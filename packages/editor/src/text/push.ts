import type { Rect } from '../types';

/** Something on a page that a paragraph growing above it may push down. Boxes are where things are on the page (y up). */
export interface PushItem {
  id: string;
  box: Rect;
  /** How much lower an edited paragraph now ends than it did, in points; negative when it got shorter. */
  growth?: number;
  /** Can't be moved (text inside a form XObject): pushing it down means nothing moves; it isn't pulled up. */
  fixed?: boolean;
  /** Not text. A graphic around the end of a growing paragraph (a table cell, a box) keeps it from pushing. */
  graphic?: boolean;
}

export interface PushOptions {
  /** Gaps up to this stay as they are; a larger one (above a footer, say) is used up first, down to this. */
  keepGap: number;
  /** The page box: nothing may be pushed past its bottom, and graphics covering most of it (backgrounds) stay. */
  page: Rect;
}

/** At most this many things below a growing paragraph are considered (each pair is compared). */
const MAX_ITEMS = 4000;

const top = (box: Rect) => box.y + box.height;
const sideBySide = (a: Rect, b: Rect) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 1;
/** How far boxes may overlap and still count as one above the other (loose text boxes of neighbours touch). */
const tolerance = (a: Rect, b: Rect) => Math.min(3, 0.3 * Math.min(a.height, b.height));

/**
 * How far everything below paragraphs that grew or got shorter moves, the
 * way a word processor keeps what follows where it belongs. Things below in
 * the same column move down as far as a paragraph grew, and in turn push what
 * is below them; a gap wider than `keepGap` takes up some of it. A paragraph
 * that got shorter pulls up what follows it closely (a gap up to `keepGap`),
 * keeping that gap, and what follows that in turn; something set apart by a
 * wider gap (a footer) stays. Things that overlap (text inside a table's
 * lines) move together. Returns the shift (positive downwards, negative
 * upwards) of each item that moves, or null when the page can't make room
 * for a paragraph that grew: a graphic encloses its end, something fixed
 * would have to move down, or text would leave the page.
 */
export function pushDown(items: PushItem[], options: PushOptions): Map<string, number> | null {
  const shifts = new Map<string, number>();
  const changed = items.filter((item) => Math.abs(item.growth ?? 0) > 0.01);
  const growing = changed.filter((item) => item.growth! > 0);
  if (!changed.length) return shifts;
  const pageArea = options.page.width * options.page.height;
  const movable = items.filter((item) => !item.graphic || item.box.width * item.box.height < pageArea / 2);

  // A cell or a box around the end of a paragraph would have to grow with it, which isn't possible.
  for (const paragraph of growing) {
    const bottom = paragraph.box.y;
    for (const item of movable) {
      if (!item.graphic || item === paragraph || sideBySide(item.box, paragraph.box)) continue;
      const tol = tolerance(item.box, paragraph.box);
      if (top(item.box) > bottom + tol && item.box.y < bottom - tol) return null;
    }
  }

  // Only what lies below the top of a paragraph that changed can move.
  const reachable = Math.max(...changed.map((item) => top(item.box)));
  const order = movable
    .filter((item) => item.box.y < reachable)
    .sort((a, b) => top(b.box) - top(a.box) || b.box.y - a.box.y);
  if (order.length > MAX_ITEMS) return null;

  const shift = new Array<number>(order.length).fill(0);
  order.forEach((item, k) => {
    // What is above in the same column: how far its bottom moved, and the gap to it.
    const above: { reach: number; gap: number; overlap: boolean; shift: number }[] = [];
    for (let i = 0; i < k; i++) {
      const other = order[i]!;
      if (sideBySide(other.box, item.box)) continue;
      const gap = other.box.y - top(item.box);
      const overlap = gap < -tolerance(other.box, item.box);
      if (overlap && !(other.box.y < top(item.box) && top(other.box) > item.box.y)) continue;
      above.push({ reach: shift[i]! + (other.growth ?? 0), gap, overlap, shift: shift[i]! });
    }
    const beside = above.filter((a) => !a.overlap);
    // Pulled up by what it closely follows, keeping the gap to it; else only pushed down.
    const nearest = beside.reduce<(typeof beside)[number] | null>((best, a) => (!best || a.gap < best.gap ? a : best), null);
    // (Or it lies on something going up: a table's lines take the text in their cells.)
    const follows = nearest !== null && nearest.reach < -0.01 && nearest.gap <= options.keepGap;
    const pulled = !item.fixed && (follows || above.some((a) => a.overlap && a.shift < -0.01));
    // Gaps up to `keep` stay: to all things above, no closer than to the one it follows.
    const keep = pulled ? Math.max(0, nearest?.gap ?? 0) : options.keepGap;
    let s = pulled ? -Infinity : 0;
    for (const a of above) {
      // Overlapping: they move together (a cell's text and the table's lines).
      if (a.overlap) s = Math.max(s, a.shift);
      else if (pulled || a.reach > 0.01) s = Math.max(s, a.reach - a.gap + Math.min(a.gap, keep));
    }
    shift[k] = s === -Infinity ? 0 : s;
  });

  for (const [k, item] of order.entries()) {
    const s = shift[k]!;
    if (Math.abs(s) <= 0.01) continue;
    if (s > 0 && item.fixed) return null;
    if (item.box.y - s < Math.min(options.page.y, item.box.y)) return null;
    shifts.set(item.id, s);
  }
  return shifts;
}
