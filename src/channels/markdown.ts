// Markdown for messaging platforms: Telegram HTML, clean plain text, and
// fence-aware splitting. Model output is untrusted, so everything that is not
// one of our own tags is escaped. Pure.

import { splitText } from './delivery.ts';

type Inline = {
  escape: (s: string) => string;
  bold: (s: string) => string;
  italic: (s: string) => string;
  strike: (s: string) => string;
  code: (raw: string) => string;
  link: (label: string, url: string) => string;
};

type Blocks = {
  inline: Inline;
  heading: (s: string) => string;
  quote: (lines: string[]) => string;
  pre: (code: string, lang: string) => string;
  rule: string;
};

const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/)/i;

const html: Blocks = {
  inline: {
    escape: escapeHtml,
    bold: (s) => `<b>${s}</b>`,
    italic: (s) => `<i>${s}</i>`,
    strike: (s) => `<s>${s}</s>`,
    code: (raw) => `<code>${escapeHtml(raw)}</code>`,
    link: (label, url) => (SAFE_URL.test(url) ? `<a href="${escapeHtml(url).replaceAll('"', '&quot;')}">${label}</a>` : `${label} (${escapeHtml(url)})`),
  },
  heading: (s) => `<b>${s}</b>`,
  quote: (lines) => `<blockquote>${lines.join('\n')}</blockquote>`,
  pre: (code, lang) => (lang ? `<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>` : `<pre>${escapeHtml(code)}</pre>`),
  rule: '———',
};

const plain: Blocks = {
  inline: {
    escape: (s) => s,
    bold: (s) => s,
    italic: (s) => s,
    strike: (s) => s,
    code: (raw) => raw,
    link: (label, url) => (label === url ? url : `${label} (${url})`),
  },
  heading: (s) => s,
  quote: (lines) => lines.map((l) => `> ${l}`).join('\n'),
  pre: (code) => code,
  rule: '———',
};

/** Markdown → Telegram `parse_mode: HTML`. Unknown or unsafe constructs come out as escaped text. */
export function markdownToTelegramHtml(text: string): string {
  return render(text, html);
}

/** Markdown → readable plain text (markers removed, links as "label (url)"). */
export function markdownToPlain(text: string): string {
  return render(text, plain);
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function render(source: string, b: Blocks): string {
  // NUL is our placeholder marker; it never appears in real text.
  const lines = source.replace(/\r\n?/g, '\n').replaceAll('\u0000', '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      let j = i + 1;
      // An unclosed fence runs to the end of the text.
      while (j < lines.length && !new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[j]!)) body.push(lines[j++]!);
      out.push(b.pre(body.join('\n'), fence[2] ?? ''));
      i = j;
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      // Tables have no rich form on these platforms; keep them aligned in monospace.
      const rows: string[] = [];
      let j = i;
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) rows.push(lines[j++]!);
      out.push(b.pre(rows.filter((r) => !TABLE_RULE.test(r)).map((r) => r.trim()).join('\n'), ''));
      i = j - 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      let j = i;
      while (j < lines.length && /^\s{0,3}>/.test(lines[j]!)) quoted.push(inline(lines[j++]!.replace(/^\s{0,3}>\s?/, ''), b.inline));
      out.push(b.quote(quoted));
      i = j - 1;
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(b.heading(inline(heading[1]!, b.inline)));
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(b.rule);
      continue;
    }
    const item = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (item) {
      const mark = item[2] === undefined ? '•' : item[2] === ' ' ? '☐' : '☑';
      out.push(`${item[1]!}${mark} ${inline(item[3]!, b.inline)}`);
      continue;
    }
    out.push(inline(line, b.inline));
  }
  return out.join('\n');
}

/** Inline markdown. Code spans, links and bare URLs are protected first so emphasis rules cannot reach into them. */
function inline(text: string, s: Inline): string {
  const held: string[] = [];
  const hold = (v: string) => `\u0000${held.push(v) - 1}\u0000`;
  let t = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) =>
    hold(s.code(code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code)),
  );
  t = t.replace(/\[([^\]\n]+)\]\(<?([^)\s>]+)>?\)/g, (_, label: string, url: string) => hold(s.link(emphasis(s.escape(label), s), url)));
  t = t.replace(/<?(https?:\/\/[^\s<>]+[^\s<>.,;:!?)'"])>?/g, (_, url: string) => hold(s.escape(url)));
  t = emphasis(s.escape(t), s);
  // A held link label may itself hold a code span, so restore until none are left.
  while (t.includes('\u0000')) t = t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]!);
  return t;
}

/**
 * Bold before italic. Italic and strike never span one of our tags, so the
 * output stays properly nested (Telegram rejects crossed tags).
 */
function emphasis(t: string, s: Inline): string {
  return t
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, (_, x: string) => s.bold(x))
    .replace(/(?<![\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, (_, x: string) => s.bold(x))
    .replace(/(?<![*\w])\*(?=[^\s*])([^*\n<>]*?[^\s*<>])\*(?![*\w])/g, (_, x: string) => s.italic(x))
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n<>]*?[^\s_<>])_(?![\w_])/g, (_, x: string) => s.italic(x))
    .replace(/~~(?=\S)([^\n<>]*?[^\s<>])~~/g, (_, x: string) => s.strike(x));
}

/**
 * Splits markdown into chunks of at most `max` characters (see `splitText`).
 * A code block cut in two is closed at the end of one chunk and reopened at
 * the start of the next, so each chunk renders on its own.
 */
export function splitMarkdown(text: string, max: number): string[] {
  if (!text.split('\n').some((l) => FENCE.test(l))) return splitText(text, max);
  const reserve = 24; // room for the closing and reopening fence lines
  const chunks = splitText(text, Math.max(reserve * 2, max - reserve));
  const out: string[] = [];
  let open: string | null = null; // the fence line to reopen with
  for (let chunk of chunks) {
    if (open !== null && /^\s{0,3}(`{3,}|~{3,})\s*(\n|$)/.test(chunk)) {
      // The cut fell right before the closing fence: nothing to reopen.
      chunk = chunk.replace(/^[^\n]*\n?/, '');
      open = null;
      if (!chunk.trim()) continue;
    }
    let c = open ? `${open}\n${chunk}` : chunk;
    for (const line of chunk.split('\n')) {
      const fence = FENCE.exec(line);
      if (!fence) continue;
      if (open === null) open = line.trim().slice(0, reserve - 4);
      else if (fence[2] === '' && fence[1]![0] === open[0]) open = null;
    }
    if (open !== null) c += `\n${open.match(/^(`{3,}|~{3,})/)?.[1] ?? '```'}`;
    out.push(c);
  }
  return out;
}
