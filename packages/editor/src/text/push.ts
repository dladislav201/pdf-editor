import type { Rect } from '../types';

/** Something on a page that a paragraph growing above it may push down. Boxes are where things are on the page (y up). */
export interface PushItem {
  id: string;
  box: Rect;
  /** How much lower an edited paragraph now ends than it did, in points. */
  growth?: number;
  /** Can't be moved (text inside a form XObject); pushing it means nothing moves. */
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
 * How far everything below paragraphs that grew moves down so the longer
 * text doesn't run into it, the way a word processor pushes what follows.
 * Things below in the same column move as far as the paragraph grew, and in
 * turn push what is below them; a gap wider than `keepGap` takes up some of
 * it. Things that overlap (text inside a table's lines) move together.
 * Returns the shift (positive, downwards) of each item that moves, or null
 * when the page can't make room: a graphic encloses the paragraph's end,
 * something fixed would have to move, or text would leave the page.
 */
export function pushDown(items: PushItem[], options: PushOptions): Map<string, number> | null {
  const shifts = new Map<string, number>();
  const growing = items.filter((item) => (item.growth ?? 0) > 0.01);
  if (!growing.length) return shifts;
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

  // Only what lies below the top of a growing paragraph can move.
  const reachable = Math.max(...growing.map((item) => top(item.box)));
  const order = movable
    .filter((item) => item.box.y < reachable)
    .sort((a, b) => top(b.box) - top(a.box) || b.box.y - a.box.y);
  if (order.length > MAX_ITEMS) return null;

  const shift = new Array<number>(order.length).fill(0);
  order.forEach((item, k) => {
    let s = 0;
    for (let i = 0; i < k; i++) {
      const above = order[i]!;
      const reach = shift[i]! + (above.growth ?? 0);
      if (reach <= 0.01 || sideBySide(above.box, item.box)) continue;
      const gap = above.box.y - top(item.box);
      if (gap >= -tolerance(above.box, item.box)) {
        s = Math.max(s, reach - Math.max(0, gap - options.keepGap));
      } else if (above.box.y < top(item.box) && top(above.box) > item.box.y) {
        // Overlapping: they move together (a cell's text and the table's lines).
        s = Math.max(s, shift[i]!);
      }
    }
    shift[k] = s;
  });

  for (const [k, item] of order.entries()) {
    const s = shift[k]!;
    if (s <= 0.01) continue;
    if (item.fixed) return null;
    if (item.box.y - s < Math.min(options.page.y, item.box.y)) return null;
    shifts.set(item.id, s);
  }
  return shifts;
}
