// Fullscreen layout: the status bar at the top, the transcript viewport in the
// middle, the dock (input, footer, approval choices) at the bottom. Pure.

export type Cursor = { row: number; col: number };

export type Regions = {
  /** Header rows to show (the status bar shrinks first on short terminals). */
  header: number;
  /** Rows for the transcript viewport (at least 1). */
  body: number;
  /** Dock rows to show (the bottom of the dock is kept). */
  dock: number;
};

/**
 * Splits `height` rows. The dock keeps at most half the screen (so the
 * transcript is never squeezed out by a long draft), the header uses
 * `fullHeader` rows when the screen is tall enough, else `compactHeader`,
 * else none; the body gets the rest and at least one row.
 */
export function regions(height: number, dockRows: number, fullHeader: number, compactHeader = 1): Regions {
  const h = Math.max(1, height);
  const dock = Math.min(dockRows, Math.max(1, Math.floor(h / 2)));
  const left = h - dock;
  const header = left - fullHeader >= 6 ? fullHeader : left - compactHeader >= 2 ? compactHeader : 0;
  return { header, body: left - header, dock };
}

export type FrameParts = {
  height: number;
  /** Status bar rows, and the shorter form for small terminals. */
  header: { full: string[]; compact: string[] };
  /** The transcript rows for a body of the given height (from `view`, with the indicator row when scrolled up). */
  body: (height: number) => string[];
  dock: string[];
  /** Cursor within `dock`, or null to hide it. */
  cursor: Cursor | null;
};

/** Every row of the screen, top to bottom (exactly `height` rows), and the cursor on screen. */
export function compose(parts: FrameParts): { rows: string[]; cursor: Cursor | null; body: number } {
  const r = regions(parts.height, parts.dock.length, parts.header.full.length, parts.header.compact.length);
  const header = r.header === parts.header.full.length ? parts.header.full : r.header ? parts.header.compact.slice(0, r.header) : [];
  const cut = parts.dock.length - r.dock;
  const dock = parts.dock.slice(cut);
  const body = parts.body(r.body).slice(0, r.body);
  while (body.length < r.body) body.push('');
  const rows = [...header, ...body, ...dock].slice(0, parts.height);
  while (rows.length < parts.height) rows.push('');
  const c = parts.cursor;
  const cursor = c && c.row >= cut ? { row: header.length + body.length + c.row - cut, col: c.col } : null;
  return { rows, cursor: cursor && cursor.row < parts.height ? cursor : null, body: r.body };
}
