// Small line diff (LCS) and a path-level JSON diff. No dependencies.

/** Line diff of two strings. Returns [{t:'same'|'add'|'del', s}]. */
export function lineDiff(a, b) {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');
  let lo = 0;
  while (lo < A.length && lo < B.length && A[lo] === B[lo]) lo++;
  let ea = A.length, eb = B.length;
  while (ea > lo && eb > lo && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const out = A.slice(0, lo).map((s) => ({ t: 'same', s }));
  const X = A.slice(lo, ea), Y = B.slice(lo, eb);
  const n = X.length, m = Y.length;
  if (n * m > 4_000_000) {
    out.push(...X.map((s) => ({ t: 'del', s })), ...Y.map((s) => ({ t: 'add', s })));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = X[i] === Y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (X[i] === Y[j]) { out.push({ t: 'same', s: X[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: 'del', s: X[i++] });
      else out.push({ t: 'add', s: Y[j++] });
    }
    while (i < n) out.push({ t: 'del', s: X[i++] });
    while (j < m) out.push({ t: 'add', s: Y[j++] });
  }
  out.push(...A.slice(ea).map((s) => ({ t: 'same', s })));
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object';
function flatten(v, path, out) {
  if (isObj(v) && Object.keys(v).length) for (const k of Object.keys(v)) flatten(v[k], path ? `${path}.${k}` : k, out);
  else out.set(path, v);
  return out;
}

/** Changed leaf paths between two JSON values: [{path, before, after}] (undefined = absent). */
export function pathDiff(before, after) {
  const a = flatten(before, '', new Map()), b = flatten(after, '', new Map());
  const out = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(p), y = b.get(p);
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path: p, before: x, after: y });
  }
  return out.sort((p, q) => p.path.localeCompare(q.path));
}
