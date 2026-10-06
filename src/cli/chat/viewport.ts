// Scroll state for the fullscreen transcript. Pure.
//
// The transcript is a list of rows (rendered at the current width). The view
// either follows the bottom (new rows scroll into view) or is pinned at a top
// row: then new rows do not move what the owner is reading, and are counted
// as unseen so the indicator can say there is something new below.

export type ScrollState = {
  /** First visible row, or null when following the bottom. */
  top: number | null;
  /** Rows added below while scrolled up (0 when following). */
  unseen: number;
};

export const FOLLOW: ScrollState = { top: null, unseen: 0 };

export const following = (s: ScrollState): boolean => s.top === null;

/** The highest top row: the view ends at the last row. */
export function maxTop(total: number, height: number): number {
  return Math.max(0, total - Math.max(1, height));
}

/** The first visible row. */
export function topOf(s: ScrollState, total: number, height: number): number {
  const max = maxTop(total, height);
  return s.top === null ? max : Math.min(Math.max(0, s.top), max);
}

/** Scrolls by `delta` rows (negative is up). Reaching the bottom follows again. */
export function scrollBy(s: ScrollState, delta: number, total: number, height: number): ScrollState {
  const max = maxTop(total, height);
  const next = max === 0 ? 0 : topOf(s, total, height) + Math.trunc(delta);
  if (next >= max) return FOLLOW; // includes content that fits: nothing to scroll
  return { top: Math.max(0, next), unseen: s.unseen };
}

export function scrollToTop(s: ScrollState, total: number, height: number): ScrollState {
  return maxTop(total, height) === 0 ? FOLLOW : { top: 0, unseen: s.unseen };
}

/** Rows were appended to the transcript. */
export function appended(s: ScrollState, added: number): ScrollState {
  return s.top === null || added <= 0 ? s : { top: s.top, unseen: s.unseen + added };
}

/** `removed` rows were dropped from the start of the transcript (a size cap). */
export function trimmed(s: ScrollState, removed: number): ScrollState {
  return s.top === null ? s : { top: Math.max(0, s.top - removed), unseen: s.unseen };
}

/**
 * The transcript was re-rendered (a new width wraps it differently). The view
 * keeps its relative position; following stays following.
 */
export function rewrapped(s: ScrollState, oldTotal: number, newTotal: number): ScrollState {
  if (s.top === null) return s;
  const top = oldTotal > 0 ? Math.round((s.top / oldTotal) * newTotal) : 0;
  return { top, unseen: s.unseen };
}

export type View = {
  /** The rows to show, at most `height`. */
  rows: string[];
  /** Rows below the view (0 when following). */
  below: number;
  /** True when the last row of the view is left for the "more below" indicator. */
  indicator: boolean;
};

/**
 * The visible slice of `content`. When scrolled up, the last row of the view is
 * reserved for the indicator, so the owner always knows they are not at the bottom.
 */
export function view(content: readonly string[], s: ScrollState, height: number): View {
  const h = Math.max(1, height);
  const top = topOf(s, content.length, h);
  if (s.top === null || top >= maxTop(content.length, h)) {
    return { rows: content.slice(top, top + h), below: 0, indicator: false };
  }
  const shown = Math.max(0, h - 1);
  return { rows: content.slice(top, top + shown), below: Math.max(0, content.length - top - shown), indicator: true };
}
