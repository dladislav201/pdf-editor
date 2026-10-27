import type { Point, Rect } from '../types';
import type { PageText, TextLine } from './types';

/**
 * The lines of a page in reading order, as a drag across text selects them:
 * paragraph by paragraph, top line first. `dy` moves a line down (a paragraph
 * pushed by one above it that grew).
 */
export interface SelectableLine {
  line: TextLine;
  dy: number;
}

/** A place between two glyphs: the `at`-th gap of line `line` (0 is before its first glyph). */
export interface TextPosition {
  line: number;
  at: number;
}

export interface SelectableOptions {
  /** Paragraphs to leave out, e.g. ones being edited, whose glyphs aren't where the model says. */
  skip?: (paragraphId: string) => boolean;
  /** How far a paragraph has been pushed down, in points. */
  shift?: (paragraphId: string) => number;
}

export function selectableLines(page: PageText, options: SelectableOptions = {}): SelectableLine[] {
  return page.paragraphs.flatMap((paragraph) =>
    options.skip?.(paragraph.id)
      ? []
      : paragraph.lines.map((line) => ({ line, dy: options.shift?.(paragraph.id) ?? 0 })),
  );
}

const boxOf = ({ line, dy }: SelectableLine): Rect => ({ ...line.box, y: line.box.y - dy });

/** The gap in a line nearest to x: past every glyph whose middle is left of it. */
function gapAt(line: TextLine, x: number): number {
  let at = 0;
  while (at < line.chars.length && line.chars[at]!.box.x + line.chars[at]!.box.width / 2 < x) at++;
  return at;
}

/**
 * Where a press at `point` starts a selection: on a line when the point is
 * over it (with `pad` points of slack around its box). Null away from text.
 */
export function positionAt(lines: SelectableLine[], [x, y]: Point, pad = 2): TextPosition | null {
  let best: { position: TextPosition; distance: number } | null = null;
  lines.forEach((entry, index) => {
    const box = boxOf(entry);
    if (x < box.x - pad || x > box.x + box.width + pad || y < box.y - pad || y > box.y + box.height + pad) return;
    // Lines can overlap a little (tight leading): the one whose middle is closest wins.
    const distance = Math.abs(y - (box.y + box.height / 2));
    if (!best || distance < best.distance) best = { position: { line: index, at: gapAt(entry.line, x) }, distance };
  });
  return (best as { position: TextPosition } | null)?.position ?? null;
}

/**
 * Where a drag that started on text has got to: the nearest line, even when
 * the pointer is between lines or beside them. Vertical distance counts most,
 * so a pointer in the margin picks the line at its height.
 */
export function nearestPosition(lines: SelectableLine[], [x, y]: Point): TextPosition | null {
  let best: { position: TextPosition; distance: number } | null = null;
  lines.forEach((entry, index) => {
    const box = boxOf(entry);
    const dy = y < box.y ? box.y - y : y > box.y + box.height ? y - box.y - box.height : 0;
    const dx = x < box.x ? box.x - x : x > box.x + box.width ? x - box.x - box.width : 0;
    const distance = dy * 4 + dx;
    if (!best || distance < best.distance) best = { position: { line: index, at: gapAt(entry.line, x) }, distance };
  });
  return (best as { position: TextPosition } | null)?.position ?? null;
}

const before = (a: TextPosition, b: TextPosition) => a.line < b.line || (a.line === b.line && a.at <= b.at);

/**
 * The text between two positions (in either order): one box per line it
 * covers, from the first selected glyph to the last, and the text itself
 * (lines joined with spaces). Empty when nothing is between them.
 */
export function selection(lines: SelectableLine[], a: TextPosition, b: TextPosition): { rects: Rect[]; text: string } {
  const [start, end] = before(a, b) ? [a, b] : [b, a];
  const rects: Rect[] = [];
  const words: string[] = [];
  for (let index = start.line; index <= end.line; index++) {
    const entry = lines[index]!;
    const { chars, wordStarts } = entry.line;
    const from = index === start.line ? start.at : 0;
    const to = index === end.line ? end.at : chars.length;
    if (to <= from) continue;
    const picked = chars.slice(from, to);
    const left = Math.min(...picked.map((c) => c.box.x));
    const right = Math.max(...picked.map((c) => c.box.x + c.box.width));
    const bottom = Math.min(...picked.map((c) => c.box.y)) - entry.dy;
    const top = Math.max(...picked.map((c) => c.box.y + c.box.height)) - entry.dy;
    rects.push({ x: left, y: bottom, width: right - left, height: top - bottom });
    let text = '';
    for (let i = from; i < to; i++) text += (i > from && wordStarts.includes(i) ? ' ' : '') + chars[i]!.text;
    words.push(text);
  }
  return { rects, text: words.join(' ') };
}
