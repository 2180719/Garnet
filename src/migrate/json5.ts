// A small JSON5 reader for openclaw.json and OpenClaw skill metadata (no dependency):
// comments, trailing commas, unquoted keys, single-quoted strings and hex numbers.
// It rewrites the text into JSON and lets JSON.parse do the rest. Data only: nothing is evaluated.

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

export function parseJson5(text: string): unknown {
  const src = text.replace(/^﻿/, '');
  const n = src.length;
  let out = '';
  let i = 0;

  /** Index of the next significant character at or after j (skips whitespace and comments). */
  const skip = (j: number): number => {
    for (;;) {
      while (j < n && /\s/.test(src[j]!)) j++;
      if (src[j] === '/' && src[j + 1] === '/') {
        while (j < n && src[j] !== '\n') j++;
      } else if (src[j] === '/' && src[j + 1] === '*') {
        const e = src.indexOf('*/', j + 2);
        if (e < 0) throw new Error('unterminated comment');
        j = e + 2;
      } else return j;
    }
  };

  while (i < n) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < n && src[i] !== c) {
        const ch = src[i]!;
        if (ch === '\\') {
          const nx = src[i + 1] ?? '';
          if (nx === '\n') s += '';
          else if (nx === "'") s += "'";
          else s += `\\${nx}`;
          i += 2;
          continue;
        }
        if (ch === '\n') throw new Error('newline in string');
        if (ch === '"') s += '\\"';
        else if (ch < ' ') s += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        else s += ch;
        i++;
      }
      if (i >= n) throw new Error('unterminated string');
      i++;
      out += `"${s}"`;
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skip(i);
      continue;
    }
    if (/[0-9.+-]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX.eE+-]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      const num = Number(raw.replace(/^\+/, ''));
      if (!Number.isFinite(num)) throw new Error(`bad number ${raw}`);
      out += JSON.stringify(num);
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i;
      while (j < n && ID_PART.test(src[j]!)) j++;
      const id = src.slice(i, j);
      if (id === 'true' || id === 'false' || id === 'null') out += id;
      else if (id === 'Infinity' || id === 'NaN') throw new Error(`unsupported value ${id}`);
      else out += JSON.stringify(id);
      i = j;
      continue;
    }
    if (c === ',') {
      const j = skip(i + 1);
      if (src[j] !== '}' && src[j] !== ']') out += ',';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

/** parseJson5, or null when the text is not valid. */
export function tryJson5(text: string): unknown {
  try {
    return parseJson5(text);
  } catch {
    return null;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
