import type { Point, Quad, Rect } from '../types';
import type { PageText, TextChar, TextLine } from './types';

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

const turn = ([x, y]: Point, angle: number): Point => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];

/**
 * A line in its own frame, where its text runs left to right: upright lines
 * as they are, lines at an angle turned back. `toLine` takes a page point
 * there, `toPage` brings one back.
 */
function frame({ line, dy }: SelectableLine) {
  const angle = line.rotation?.angle ?? 0;
  return {
    box: line.rotation?.box ?? line.box,
    charBox: (c: TextChar) => c.straight ?? c.box,
    toLine: ([x, y]: Point): Point => turn([x, y + dy], -angle),
    toPage: (p: Point): Point => {
      const [x, y] = turn(p, angle);
      return [x, y - dy];
    },
    angle,
  };
}

/** The gap in a line nearest to x (in its frame): past every glyph whose middle is left of it. */
function gapAt(entry: SelectableLine, x: number): number {
  const { charBox } = frame(entry);
  const { chars } = entry.line;
  let at = 0;
  while (at < chars.length && charBox(chars[at]!).x + charBox(chars[at]!).width / 2 < x) at++;
  return at;
}

/**
 * Where a press at `point` starts a selection: on a line when the point is
 * over it (with `pad` points of slack around its box). Null away from text.
 */
export function positionAt(lines: SelectableLine[], point: Point, pad = 2): TextPosition | null {
  let best: { position: TextPosition; distance: number } | null = null;
  lines.forEach((entry, index) => {
    const { box, toLine } = frame(entry);
    const [x, y] = toLine(point);
    if (x < box.x - pad || x > box.x + box.width + pad || y < box.y - pad || y > box.y + box.height + pad) return;
    // Lines can overlap a little (tight leading): the one whose middle is closest wins.
    const distance = Math.abs(y - (box.y + box.height / 2));
    if (!best || distance < best.distance) best = { position: { line: index, at: gapAt(entry, x) }, distance };
  });
  return (best as { position: TextPosition } | null)?.position ?? null;
}

/**
 * Where a drag that started on text has got to: the nearest line, even when
 * the pointer is between lines or beside them. Distance across a line counts
 * most, so a pointer in the margin picks the line at its height.
 */
export function nearestPosition(lines: SelectableLine[], point: Point): TextPosition | null {
  let best: { position: TextPosition; distance: number } | null = null;
  lines.forEach((entry, index) => {
    const { box, toLine } = frame(entry);
    const [x, y] = toLine(point);
    const dy = y < box.y ? box.y - y : y > box.y + box.height ? y - box.y - box.height : 0;
    const dx = x < box.x ? box.x - x : x > box.x + box.width ? x - box.x - box.width : 0;
    const distance = dy * 4 + dx;
    if (!best || distance < best.distance) best = { position: { line: index, at: gapAt(entry, x) }, distance };
  });
  return (best as { position: TextPosition } | null)?.position ?? null;
}

/** The word under a point (a double click): from its first glyph to its last. Null away from text. */
export function wordAt(lines: SelectableLine[], point: Point): [TextPosition, TextPosition] | null {
  const position = positionAt(lines, point);
  if (!position) return null;
  const entry = lines[position.line]!;
  const { charBox, toLine } = frame(entry);
  const { chars, wordStarts } = entry.line;
  const [x] = toLine(point);
  // The glyph under the point, else the nearest one.
  let under = 0;
  let distance = Infinity;
  chars.forEach((c, i) => {
    const box = charBox(c);
    const d = x < box.x ? box.x - x : x > box.x + box.width ? x - box.x - box.width : 0;
    if (d < distance) [under, distance] = [i, d];
  });
  const start = Math.max(...wordStarts.filter((s) => s <= under), 0);
  const end = wordStarts.find((s) => s > under) ?? chars.length;
  return [
    { line: position.line, at: start },
    { line: position.line, at: end },
  ];
}

const before = (a: TextPosition, b: TextPosition) => a.line < b.line || (a.line === b.line && a.at <= b.at);

const boundingBox = (points: Point[]): Rect => {
  const x = Math.min(...points.map((p) => p[0]));
  const y = Math.min(...points.map((p) => p[1]));
  return { x, y, width: Math.max(...points.map((p) => p[0])) - x, height: Math.max(...points.map((p) => p[1])) - y };
};

/**
 * The text between two positions (in either order): one box per line it
 * covers, from the first selected glyph to the last, and the text itself
 * (lines joined with spaces). `quads` has each box's corners as the text
 * runs, null for upright lines; `rects` are the bounding boxes. Empty when
 * nothing is between them.
 */
export function selection(
  lines: SelectableLine[],
  a: TextPosition,
  b: TextPosition,
): { rects: Rect[]; quads: (Quad | null)[]; text: string } {
  const [start, end] = before(a, b) ? [a, b] : [b, a];
  const rects: Rect[] = [];
  const quads: (Quad | null)[] = [];
  const words: string[] = [];
  for (let index = start.line; index <= end.line; index++) {
    const entry = lines[index]!;
    const { charBox, toPage, angle } = frame(entry);
    const { chars, wordStarts } = entry.line;
    const from = index === start.line ? start.at : 0;
    const to = index === end.line ? end.at : chars.length;
    if (to <= from) continue;
    const picked = chars.slice(from, to).map(charBox);
    const left = Math.min(...picked.map((c) => c.x));
    const right = Math.max(...picked.map((c) => c.x + c.width));
    const bottom = Math.min(...picked.map((c) => c.y));
    const top = Math.max(...picked.map((c) => c.y + c.height));
    if (angle) {
      const quad = [toPage([left, top]), toPage([right, top]), toPage([left, bottom]), toPage([right, bottom])] as Quad;
      quads.push(quad);
      rects.push(boundingBox(quad));
    } else {
      quads.push(null);
      rects.push({ x: left, y: bottom - entry.dy, width: right - left, height: top - bottom });
    }
    let text = '';
    for (let i = from; i < to; i++) text += (i > from && wordStarts.includes(i) ? ' ' : '') + chars[i]!.text;
    words.push(text);
  }
  return { rects, quads, text: words.join(' ') };
}
