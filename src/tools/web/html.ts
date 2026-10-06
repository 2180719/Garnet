/**
 * A small HTML to readable-text converter (no dependencies). Not a full HTML
 * parser: it tokenizes tags and text, drops what a reader never sees (scripts,
 * styles, hidden elements, navigation), prefers <main>/<article> when they
 * hold the content, and renders light Markdown (headings, lists, links, code,
 * table rows). Hidden text and invisible Unicode are removed because they are
 * common prompt-injection carriers.
 */

export type Extracted = { title: string; text: string; links: string[] };

/** Elements whose content is never shown as text. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'select', 'button', 'head', 'dialog']);
/** Raw-text elements: their content is not markup, so it is skipped to the matching close tag. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template']);
/** Navigation and page chrome, dropped unless inside the main content. */
const CHROME = new Set(['nav', 'aside', 'footer', 'header', 'form']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header',
  'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const MAIN = new Set(['main', 'article']);

const NAME = /[a-zA-Z][a-zA-Z0-9:-]*/y;
/** Open elements tracked at most; deeper (malformed) nesting is treated as flat. */
const MAX_DEPTH = 512;

type Token =
  | { kind: 'text'; text: string; end: number }
  | { kind: 'skip'; end: number }
  | { kind: 'tag'; name: string; closing: boolean; selfClosing: boolean; attrs: string; end: number };

/**
 * The token at `pos`. Linear overall: a tag is scanned once to its closing
 * `>` (quotes respected), and an unterminated tag ends the document, as in a
 * browser, instead of being rescanned from every later `<`.
 */
function tokenAt(html: string, pos: number): Token {
  if (html[pos] !== '<') {
    const next = html.indexOf('<', pos + 1);
    const end = next === -1 ? html.length : next;
    return { kind: 'text', text: html.slice(pos, end), end };
  }
  if (html.startsWith('<!--', pos)) {
    const close = html.indexOf('-->', pos + 4);
    return { kind: 'skip', end: close === -1 ? html.length : close + 3 };
  }
  if (html[pos + 1] === '!' || html[pos + 1] === '?') {
    const close = html.indexOf('>', pos + 2);
    return { kind: 'skip', end: close === -1 ? html.length : close + 1 };
  }
  const closing = html[pos + 1] === '/';
  NAME.lastIndex = pos + (closing ? 2 : 1);
  const m = NAME.exec(html);
  if (!m) return { kind: 'text', text: '<', end: pos + 1 };
  let i = NAME.lastIndex;
  while (i < html.length && html[i] !== '>') {
    const c = html[i];
    if (c === '"' || c === "'") {
      const q = html.indexOf(c, i + 1);
      if (q === -1) return { kind: 'skip', end: html.length };
      i = q + 1;
    } else i++;
  }
  if (i >= html.length) return { kind: 'skip', end: html.length };
  const attrs = html.slice(NAME.lastIndex, i);
  return { kind: 'tag', name: m[0].toLowerCase(), closing, selfClosing: attrs.endsWith('/'), attrs, end: i + 1 };
}

type Frame = { tag: string; hidden: boolean; chrome: boolean; main: boolean; href?: string | undefined };

/** Marks where a link's text starts in the output; never present in page text (controls are stripped). */
const LINK = '\u0001';

export function htmlToText(html: string, baseUrl: string, maxLinks = 300): Extracted {
  const all = new Out();
  const main = new Out();
  const links = new Set<string>();
  const stack: Frame[] = [];
  let title = '';
  let base = baseUrl;
  let pre = 0;
  let listDepth = 0;
  let cell = 0;
  let lower: string | null = null; // computed once, only if a raw-text element appears
  const top = (): Frame | undefined => stack[stack.length - 1];
  const hidden = () => top()?.hidden ?? false;
  const inMain = () => top()?.main ?? false;
  const inChrome = () => top()?.chrome ?? false;
  const emit = (fn: (o: Out) => void) => {
    if (hidden()) return;
    if (!inChrome() || inMain()) fn(all);
    if (inMain()) fn(main);
  };

  let pos = 0;
  while (pos < html.length) {
    const tok = tokenAt(html, pos);
    pos = tok.end;
    if (tok.kind === 'skip') continue; // comments, doctype, CDATA, processing instructions
    if (tok.kind === 'text') {
      const text = decodeEntities(tok.text);
      emit((o) => o.text(text, pre > 0));
      continue;
    }
    const { name, closing } = tok;
    const attrs = closing ? {} : parseAttrs(tok.attrs);
    if (!closing && RAW.has(name)) {
      // Skip to the matching close tag; the title is the only raw text kept.
      lower ??= html.toLowerCase();
      const end = lower.indexOf(`</${name}`, pos);
      const body = html.slice(pos, end === -1 ? html.length : end);
      if (name === 'title' && !title && !stack.some((f) => f.tag === 'svg' || f.tag === 'math')) title = clean(decodeEntities(body));
      if (name === 'textarea' && !hidden() && !isHidden(attrs)) emit((o) => o.text(decodeEntities(body), false));
      const close = end === -1 ? -1 : html.indexOf('>', end);
      pos = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!closing && name === 'base' && attrs.href) {
      const b = absolute(attrs.href, base);
      if (b) base = b;
    }
    if (closing) {
      const at = stack.map((f) => f.tag).lastIndexOf(name);
      if (at === -1) continue; // stray close tag
      while (stack.length > at) {
        const f = stack.pop()!;
        closeTag(f);
      }
      continue;
    }
    if (VOID.has(name) || tok.selfClosing || stack.length >= MAX_DEPTH) {
      if (name === 'br') emit((o) => o.newline());
      else if (name === 'hr') emit((o) => o.block('---'));
      else if (name === 'img' && attrs.alt?.trim() && !isHidden(attrs)) emit((o) => o.text(` [image: ${clean(decodeEntities(attrs.alt!))}] `, false));
      continue;
    }
    const parent = top();
    const frame: Frame = {
      tag: name,
      hidden: (parent?.hidden ?? false) || SKIP.has(name) || isHidden(attrs),
      chrome: (parent?.chrome ?? false) || CHROME.has(name),
      main: (parent?.main ?? false) || MAIN.has(name) || attrs.role === 'main',
    };
    if (name === 'nav') frame.hidden ||= true; // navigation menus are never content
    stack.push(frame);
    openTag(frame, attrs);
  }
  while (stack.length) closeTag(stack.pop()!);

  function openTag(f: Frame, attrs: Record<string, string>): void {
    const t = f.tag;
    if (/^h[1-6]$/.test(t)) emit((o) => o.block(`${'#'.repeat(Number(t[1]))} `, true));
    else if (t === 'li') emit((o) => o.line(`${'  '.repeat(Math.max(0, listDepth - 1))}- `));
    else if (t === 'ul' || t === 'ol') listDepth++;
    else if (t === 'pre') {
      emit((o) => o.block('```\n', true));
      pre++;
    } else if (t === 'blockquote') emit((o) => o.block('> ', true));
    else if (t === 'tr') {
      cell = 0;
      emit((o) => o.newline());
    } else if (t === 'td' || t === 'th') {
      if (cell++ > 0) emit((o) => o.text(' | ', true));
    } else if (t === 'code' && pre === 0) emit((o) => o.text('`', true));
    else if (t === 'a') {
      const href = attrs.href ? absolute(attrs.href, base) : null;
      if (href) {
        f.href = href;
        if (!f.hidden && links.size < maxLinks) links.add(href);
        emit((o) => o.mark());
      }
    } else if (BLOCK.has(t)) emit((o) => o.block(''));
  }

  function closeTag(f: Frame): void {
    const t = f.tag;
    // Emit with the closing element's own visibility (it is already popped).
    const say = (fn: (o: Out) => void) => {
      if (f.hidden) return;
      if (!f.chrome || f.main) fn(all);
      if (f.main) fn(main);
    };
    if (t === 'ul' || t === 'ol') listDepth = Math.max(0, listDepth - 1);
    if (t === 'pre') {
      pre = Math.max(0, pre - 1);
      say((o) => {
        o.trimEnd();
        o.line('```');
        o.block('');
      });
    } else if (t === 'code' && pre === 0) say((o) => o.text('`', true));
    else if (t === 'a' && f.href) say((o) => o.closeLink(f.href!));
    if ((BLOCK.has(t) && t !== 'li' && t !== 'pre') || /^h[1-6]$/.test(t)) say((o) => o.block(''));
  }

  const mainText = main.render();
  const text = mainText.length >= 200 ? mainText : all.render();
  return { title, text, links: [...links] };
}

/** Accumulates Markdown-ish output with collapsed whitespace. */
class Out {
  private parts: string[] = [];

  text(s: string, preformatted: boolean): void {
    let t = s.replaceAll(LINK, '');
    if (!preformatted) {
      t = t.replace(/\s+/g, ' ');
      const last = this.parts.at(-1) ?? '\n';
      if (/[\s\u0001]$/.test(last)) t = t.replace(/^ /, '');
    }
    if (t) this.parts.push(t);
  }

  /** Drops trailing whitespace (the last newline inside a <pre> before its closing fence). */
  trimEnd(): void {
    while (this.parts.length) {
      const last = this.parts[this.parts.length - 1]!.replace(/\s+$/, '');
      if (last) {
        this.parts[this.parts.length - 1] = last;
        return;
      }
      this.parts.pop();
    }
  }

  mark(): void {
    this.parts.push(LINK);
  }

  /** Starts a new line with `prefix`. */
  line(prefix: string): void {
    this.parts.push('\n', prefix);
  }

  newline(): void {
    this.parts.push('\n');
  }

  block(prefix: string, raw = false): void {
    this.parts.push('\n\n');
    if (prefix) this.parts.push(raw ? prefix : `${prefix}\n\n`);
  }

  /** Turns "[text" into "[text](href)", or drops the bracket when the link has no text. */
  closeLink(href: string): void {
    const open = this.parts.lastIndexOf(LINK);
    if (open === -1) return;
    const inner = this.parts.slice(open + 1).join('').replace(/\s+/g, ' ').trim();
    this.parts.splice(open);
    if (inner) this.parts.push(`[${inner}](${href})`);
  }

  render(): string {
    return stripInvisible(this.parts.join(''))
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/^(#{1,6}|-|>) *\n+/gm, '') // empty headings, bullets and quotes
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

function isHidden(attrs: Record<string, string>): boolean {
  if ('hidden' in attrs) return true;
  if (attrs['aria-hidden']?.toLowerCase() === 'true') return true;
  const style = (attrs.style ?? '').toLowerCase().replace(/\s+/g, '');
  if (/display:none|visibility:hidden|font-size:0(?![.\d])|opacity:0(?![.\d])/.test(style)) return true;
  return attrs.type?.toLowerCase() === 'hidden';
}

const ATTR = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) {
    const k = m[1]!.toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

const clean = (s: string): string => stripInvisible(s).replace(/\s+/g, ' ').trim();

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', para: '¶', sect: '§', middot: '·', bull: '•',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', prime: '′', Prime: '″', dagger: '†', Dagger: '‡', permil: '‰', euro: '€', pound: '£', yen: '¥', cent: '¢',
  iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', rArr: '⇒', hearts: '♥', check: '✓', infin: '∞', ne: '≠', le: '≤', ge: '≥', minus: '−', zwj: '', zwnj: '', lrm: '', rlm: '',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return NAMED[ent] ?? whole;
  });
}

/**
 * Removes characters a reader cannot see but a model reads: zero-width and
 * bidi controls, Unicode "tag" characters (used to smuggle hidden ASCII
 * instructions) and other C0/C1 controls except tab and newline.
 */
export function stripInvisible(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻\u{E0000}-\u{E007F}]/gu, '');
}
