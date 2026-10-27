import type { Rect } from '../types';
import type { PageText, RawPageText, TextAlign, TextChar, TextLine, TextParagraph, TextRun } from './types';

type RawChar = RawPageText['chars'][number];

/**
 * Layout analysis: glyphs → lines → paragraphs. Tolerances are in ems of the
 * text involved, so they hold for 6 pt footnotes and 40 pt titles alike.
 */

/** Same baseline when the origins differ by less than this (ems). */
const BASELINE_TOLERANCE = 0.25;
/** A horizontal gap wider than this (ems) splits a baseline into separate lines: columns, table cells. */
const COLUMN_GAP = 1.6;
/** A gap wider than this (ems) between glyphs is a word break even without a space glyph. */
const WORD_GAP = 0.15;
/** Largest baseline-to-baseline distance (ems) inside a paragraph. */
const MAX_LEADING = 1.75;
/** Sizes within this ratio count as the same text size. */
const SIZE_TOLERANCE = 0.08;
/** Edges within this (ems) count as aligned. */
const EDGE_TOLERANCE = 0.6;

const isHorizontal = (angle: number) => Math.abs(angle) < 0.02 || Math.abs(angle - 2 * Math.PI) < 0.02;
const right = (rect: Rect) => rect.x + rect.width;
const top = (rect: Rect) => rect.y + rect.height;

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(top)) - y };
}

function mostCommon<T>(values: T[]): T {
  const counts = new Map<T, number>();
  let best = values[0] as T;
  for (const value of values) {
    const n = (counts.get(value) ?? 0) + 1;
    counts.set(value, n);
    if (n > (counts.get(best) ?? 0)) best = value;
  }
  return best;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const spread = (values: number[]) => (values.length ? Math.max(...values) - Math.min(...values) : 0);
const sameSize = (a: number, b: number) => Math.abs(a - b) <= SIZE_TOLERANCE * Math.max(a, b);

function toChar(raw: RawChar): TextChar {
  const { angle: _angle, unmapped: _unmapped, invisible: _invisible, ...char } = raw;
  return char;
}

// ------------------------------------------------------------------- lines

interface Baseline {
  y: number;
  size: number;
  chars: RawChar[];
}

/** Groups glyphs that share a baseline, top of the page first. */
function baselines(chars: RawChar[]): Baseline[] {
  const sorted = [...chars].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Baseline[] = [];
  for (const char of sorted) {
    let target: Baseline | undefined;
    // Only the last few groups can be within tolerance: chars come top-down.
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!;
      const tolerance = BASELINE_TOLERANCE * Math.max(group.size, char.size);
      if (group.y - char.y > tolerance) break;
      if (Math.abs(group.y - char.y) <= tolerance) {
        target = group;
        break;
      }
    }
    if (target) {
      target.chars.push(char);
      if (!char.isSpace) target.size = Math.max(target.size, char.size);
    } else {
      groups.push({ y: char.y, size: char.size, chars: [char] });
    }
  }
  return groups;
}

/** Splits one baseline at wide gaps, so columns and table cells become separate lines. */
function segments(group: Baseline): RawChar[][] {
  const chars = [...group.chars].sort((a, b) => a.x - b.x);
  const out: RawChar[][] = [];
  let current: RawChar[] = [];
  let lastGlyph: RawChar | undefined;
  for (const char of chars) {
    if (!char.isSpace && lastGlyph) {
      const gap = char.x - right(lastGlyph.box);
      if (gap > COLUMN_GAP * Math.max(char.size, lastGlyph.size)) {
        out.push(current);
        current = [];
      }
    }
    current.push(char);
    if (!char.isSpace) lastGlyph = char;
  }
  if (current.length) out.push(current);
  return out.filter((segment) => segment.some((c) => !c.isSpace));
}

const glyphsOf = (segment: RawChar[]) => segment.filter((c) => !c.isSpace);
const segmentSize = (segment: RawChar[]) => Math.max(...glyphsOf(segment).map((c) => c.size));
const segmentLeft = (segment: RawChar[]) => Math.min(...glyphsOf(segment).map((c) => c.box.x));
const segmentRight = (segment: RawChar[]) => Math.max(...glyphsOf(segment).map((c) => right(c.box)));
const segmentBaseline = (segment: RawChar[]) => median(glyphsOf(segment).map((c) => c.y));

/**
 * Superscripts and subscripts (smaller text a little above or below a line,
 * like m², H₂O or note¹) get their own baseline; fold them back into the line
 * they belong to instead of leaving holes in it and stray one-glyph lines.
 */
function mergeScripts(segments: RawChar[][]): RawChar[][] {
  const bySize = [...segments].sort((a, b) => segmentSize(b) - segmentSize(a));
  const merged = new Set<RawChar[]>();
  for (const small of [...bySize].reverse()) {
    const size = segmentSize(small);
    const host = bySize.find((big) => {
      if (big === small || merged.has(big)) return false;
      const bigSize = segmentSize(big);
      if (size > 0.85 * bigSize) return false;
      if (Math.abs(segmentBaseline(small) - segmentBaseline(big)) > 0.6 * bigSize) return false;
      return segmentLeft(small) >= segmentLeft(big) - bigSize && segmentRight(small) <= segmentRight(big) + 2 * bigSize;
    });
    if (host) {
      host.push(...small);
      merged.add(small);
    }
  }
  return segments.filter((segment) => !merged.has(segment));
}

function buildLine(chars: RawChar[]): TextLine {
  const glyphs = chars.filter((c) => !c.isSpace).sort((a, b) => a.x - b.x);
  const spaces = chars.filter((c) => c.isSpace);
  const size = mostCommon(glyphs.map((c) => Math.round(c.size * 100) / 100));

  const wordStarts = [0];
  let text = glyphs[0]!.text;
  for (let i = 1; i < glyphs.length; i++) {
    const prev = glyphs[i - 1]!;
    const next = glyphs[i]!;
    const gap = next.x - right(prev.box);
    const spaceBetween = spaces.some((s) => s.x >= prev.x && s.x <= next.x);
    // OCR layers draw one object per word, stretched over the word on the scan, so gaps can be tiny.
    const nextWord = prev.invisible && next.invisible && prev.object !== next.object;
    if (spaceBetween || nextWord || gap > WORD_GAP * Math.max(prev.size, next.size)) {
      wordStarts.push(i);
      text += ' ';
    }
    text += next.text;
  }

  const runs: TextRun[] = [];
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i]!;
    const last = runs[runs.length - 1];
    if (last && last.font === glyph.font && last.color === glyph.color && sameSize(last.size, glyph.size)) {
      last.end = i + 1;
    } else {
      runs.push({ text: '', font: glyph.font, size: glyph.size, color: glyph.color, start: i, end: i + 1 });
    }
  }
  for (const run of runs) {
    run.text = glyphs
      .slice(run.start, run.end)
      .map((g, k) => (k > 0 && wordStarts.includes(run.start + k) ? ' ' : '') + g.text)
      .join('');
  }

  const glyphObjects = new Set(glyphs.map((g) => g.object));
  return {
    chars: glyphs.map(toChar),
    text,
    spaceObjects: spaces
      .filter((s, i) => s.object >= 0 && !glyphObjects.has(s.object) && spaces.findIndex((t) => t.object === s.object) === i)
      .map((s) => ({ object: s.object, x: s.x })),
    runs,
    wordStarts,
    hyphenated: glyphs[glyphs.length - 1]!.lineEndHyphen,
    // Scripts sit above or below: the baseline is where the full-size glyphs are.
    baseline: median(glyphs.filter((g) => sameSize(g.size, size)).map((g) => g.y)),
    size,
    box: union(glyphs.map((g) => g.box)),
  };
}

// -------------------------------------------------------------- paragraphs

interface Draft {
  lines: TextLine[];
  left: number;
  right: number;
}

const lineLeft = (line: TextLine) => line.box.x;
const lineRight = (line: TextLine) => right(line.box);
const dominantWeight = (line: TextLine, weights: Record<number, number>) =>
  mostCommon(line.chars.map((c) => ((weights[c.font] ?? 400) >= 600 ? 'bold' : 'regular')));

function leadingOf(draft: Draft): number | undefined {
  if (draft.lines.length < 2) return undefined;
  return median(draft.lines.slice(1).map((line, i) => draft.lines[i]!.baseline - line.baseline));
}

/** Can `line` continue `draft`? Returns the vertical gap when it can. */
function continues(draft: Draft, line: TextLine, weights: Record<number, number>): number | null {
  const last = draft.lines[draft.lines.length - 1]!;
  const size = Math.max(line.size, last.size);
  const gap = last.baseline - line.baseline;
  if (gap <= 0.2 * size || gap > MAX_LEADING * size) return null;
  if (!sameSize(line.size, last.size)) return null;

  const leading = leadingOf(draft);
  if (leading !== undefined && Math.abs(gap - leading) > Math.max(0.15 * size, 1)) return null;
  // A line that is bold where the paragraph is not (or the reverse) is a heading or a label.
  if (leading === undefined && dominantWeight(line, weights) !== dominantWeight(last, weights)) return null;

  const overlap = Math.min(lineRight(line), draft.right) - Math.max(lineLeft(line), draft.left);
  if (overlap <= 0.3 * Math.min(line.box.width, draft.right - draft.left)) return null;

  const tolerance = EDGE_TOLERANCE * size;
  const sameLeft = Math.abs(lineLeft(line) - draft.left) <= tolerance;
  const sameRight = Math.abs(lineRight(line) - draft.right) <= tolerance;
  const sameCenter =
    Math.abs((lineLeft(line) + lineRight(line)) / 2 - (draft.left + draft.right) / 2) <= tolerance;
  // The first line may be indented relative to the rest.
  const afterIndentedFirst =
    draft.lines.length === 1 && lineLeft(line) < draft.left && draft.left - lineLeft(line) <= 4 * size;
  if (!sameLeft && !sameRight && !sameCenter && !afterIndentedFirst) return null;

  if (sameLeft) {
    // Text wraps only when the next word doesn't fit. If this line's first word
    // would have fit after the previous line, that line ended on purpose: a list
    // item, an address line, a paragraph without spacing. The column is at least
    // as wide as the longer of the paragraph and this line.
    const columnRight = Math.max(draft.right, lineRight(line));
    const firstWordEnd = line.chars[(line.wordStarts[1] ?? line.chars.length) - 1]!;
    const firstWordWidth = right(firstWordEnd.box) - line.chars[0]!.x;
    if (firstWordWidth + 0.35 * size < columnRight - lineRight(last)) return null;
  }

  if (draft.lines.length >= 2) {
    // An indented line after full-width lines starts a new paragraph.
    const bodyLeft = Math.min(...draft.lines.slice(1).map(lineLeft));
    if (lineLeft(line) > bodyLeft + 0.8 * size && Math.abs(lineRight(last) - draft.right) <= tolerance) return null;
    // In justified text a short line ends the paragraph. Edges alone can't tell
    // justified from ragged text, so also require stretched word gaps.
    const rights = draft.lines.slice(0, -1).map(lineRight);
    const justified =
      spread(rights) <= tolerance &&
      spread(draft.lines.map(lineLeft).slice(1)) <= tolerance &&
      stretched(draft.lines, size);
    if (justified && lineRight(last) < draft.right - 2 * size) return null;
  }
  return gap;
}

interface Margins {
  left: number;
  right: number;
}

function alignment(lines: TextLine[], size: number, indent: number, margins: Margins): TextAlign {
  if (lines.length < 2) {
    // One line can only be judged against the text block of the page.
    const line = lines[0]!;
    const width = margins.right - margins.left;
    const offLeftMargin = lineLeft(line) > margins.left + 2 * size;
    if (!offLeftMargin) return 'left';
    if (Math.abs((lineLeft(line) + lineRight(line)) / 2 - (margins.left + margins.right) / 2) <= 0.02 * width) return 'center';
    if (Math.abs(lineRight(line) - margins.right) <= size) return 'right';
    return 'left';
  }
  const tolerance = Math.max(EDGE_TOLERANCE * size, 1.5);
  const lefts = (indent > 0 ? lines.slice(1) : lines).map(lineLeft);
  const rightsButLast = lines.slice(0, -1).map(lineRight);
  const centers = lines.map((l) => (lineLeft(l) + lineRight(l)) / 2);
  const leftAligned = spread(lefts) <= tolerance;
  const rightAligned = spread(lines.map(lineRight)) <= tolerance;

  // Ragged lines can end close together by chance, so edges alone don't prove justification.
  if (leftAligned && spread(rightsButLast) <= tolerance && stretched(lines, size)) return 'justify';
  if (leftAligned) return 'left';
  if (rightAligned) return 'right';
  if (spread(centers) <= tolerance) return 'center';
  return 'left';
}

function wordGaps(line: TextLine): number[] {
  return line.wordStarts.slice(1).map((i) => line.chars[i]!.x - right(line.chars[i - 1]!.box));
}

/**
 * Justified lines have their word gaps stretched, each line by a different
 * amount, while the last line keeps natural spaces. Ragged text has the same
 * natural gap everywhere.
 */
function stretched(lines: TextLine[], size: number): boolean {
  const body = lines.slice(0, -1).map((line) => wordGaps(line)).filter((gaps) => gaps.length);
  if (!body.length) return false;
  const bodyMedians = body.map(median);
  const lastGaps = wordGaps(lines[lines.length - 1]!);
  const widerThanLast = lastGaps.length > 0 && median(bodyMedians) > 1.15 * median(lastGaps);
  const varyByLine = spread(bodyMedians) > 0.03 * size;
  return widerThanLast || varyByLine;
}

function joinLines(lines: TextLine[]): string {
  return lines.reduce((text, line, i) => {
    if (i === 0) return line.text;
    return /[-‐]$/.test(text) ? text + line.text : `${text} ${line.text}`;
  }, '');
}

// ---------------------------------------------------------------- public

/** Paragraphs (ids not set yet) and the main text block of a set of horizontal glyphs. */
function layoutChars(raw: RawPageText, usable: RawChar[], scripts = true): { paragraphs: TextParagraph[]; margins: Margins } {
  const pieces = baselines(usable).flatMap(segments);
  const lines = (scripts ? mergeScripts(pieces) : pieces)
    .map(buildLine)
    .sort((a, b) => b.baseline - a.baseline || a.box.x - b.box.x);

  const weights = Object.fromEntries(Object.values(raw.fonts).map((f) => [f.id, f.weight]));
  const drafts: Draft[] = [];
  for (const line of lines) {
    let best: { draft: Draft; gap: number } | undefined;
    for (const draft of drafts) {
      const gap = continues(draft, line, weights);
      if (gap !== null && (!best || gap < best.gap)) best = { draft, gap };
    }
    if (best) {
      best.draft.lines.push(line);
      best.draft.left = Math.min(best.draft.left, lineLeft(line));
      best.draft.right = Math.max(best.draft.right, lineRight(line));
    } else {
      drafts.push({ lines: [line], left: lineLeft(line), right: lineRight(line) });
    }
  }

  // The text block of the page: where most lines start and end.
  const lefts = lines.map(lineLeft).sort((a, b) => a - b);
  const rights = lines.map(lineRight).sort((a, b) => a - b);
  const margins: Margins = {
    left: lefts[Math.floor(lefts.length * 0.1)] ?? 0,
    right: rights[Math.ceil(rights.length * 0.9) - 1] ?? 0,
  };

  const blocked = new Map<string, string>();
  for (const c of raw.chars) {
    if (c.unmapped) blocked.set(`${c.x},${c.y}`, 'The font has no Unicode mapping for some characters.');
  }

  // Editing hides and rewrites whole page objects, so a paragraph that shares
  // an object with another paragraph can't be edited on its own.
  const owners = new Map<number, Set<Draft>>();
  for (const draft of drafts) {
    for (const char of draft.lines.flatMap((l) => l.chars)) {
      if (char.object < 0) continue;
      const set = owners.get(char.object) ?? new Set<Draft>();
      set.add(draft);
      owners.set(char.object, set);
    }
  }

  const paragraphs: TextParagraph[] = drafts.map((draft) => {
    const size = mostCommon(draft.lines.map((l) => l.size));
    const indent =
      draft.lines.length >= 2 ? Math.max(0, lineLeft(draft.lines[0]!) - Math.min(...draft.lines.slice(1).map(lineLeft))) : 0;
    const chars = draft.lines.flatMap((l) => l.chars);
    const reason = chars.some((c) => c.object < 0)
      ? 'Text inside a form XObject can not be edited yet.'
      : chars.some((c) => (owners.get(c.object)?.size ?? 0) > 1)
        ? 'This text is drawn together with other text and can not be edited on its own yet.'
        : chars.map((c) => blocked.get(`${c.x},${c.y}`)).find(Boolean);
    return {
      id: '',
      pageIndex: raw.pageIndex,
      lines: draft.lines,
      text: joinLines(draft.lines),
      box: union(draft.lines.map((l) => l.box)),
      align: alignment(draft.lines, size, indent > 0.5 * size ? indent : 0, margins),
      leading: leadingOf(draft) ?? Math.round(size * 1.2 * 100) / 100,
      indent: indent > 0.5 * size ? indent : 0,
      editable: !reason,
      ...(reason ? { reason } : {}),
    };
  });
  return { paragraphs, margins };
}

const normalAngle = (angle: number) => (angle > Math.PI ? angle - 2 * Math.PI : angle);
/** Recognized text follows the scan, which is rarely more than a few degrees off. */
const MAX_SKEW = 0.1;

function rotatePoint(x: number, y: number, angle: number): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [x * cos - y * sin, x * sin + y * cos];
}

function rotateRect(rect: Rect, angle: number): Rect {
  const corners = [
    rotatePoint(rect.x, rect.y, angle),
    rotatePoint(right(rect), rect.y, angle),
    rotatePoint(rect.x, top(rect), angle),
    rotatePoint(right(rect), top(rect), angle),
  ];
  const x = Math.min(...corners.map((c) => c[0]));
  const y = Math.min(...corners.map((c) => c[1]));
  return { x, y, width: Math.max(...corners.map((c) => c[0])) - x, height: Math.max(...corners.map((c) => c[1])) - y };
}

/**
 * Invisible text: the recognized (OCR) layer of a scan. It runs along the
 * scan's skew, so it is straightened to be grouped like any text, then put
 * back: glyphs and boxes sit where they are on the page, and each line's
 * baseline is that of its first glyph. Editing it rewrites it as visible text.
 */
function recognizedParagraphs(raw: RawPageText): { paragraphs: TextParagraph[]; margins: Margins | null } {
  const invisible = raw.chars.filter((c) => c.invisible);
  if (!invisible.length) return { paragraphs: [], margins: null };
  const angle = median(invisible.map((c) => normalAngle(c.angle)));
  // PDFium measures char angles clockwise; user space turns counterclockwise.
  const skew = -angle;
  const turnRect = (r: Rect, by: number): Rect => {
    const [cx, cy] = rotatePoint(r.x + r.width / 2, r.y + r.height / 2, by);
    return { ...r, x: cx - r.width / 2, y: cy - r.height / 2 };
  };
  const turn = <T extends TextChar>(c: T, by: number): T => {
    const [x, y] = rotatePoint(c.x, c.y, by);
    return { ...c, x, y, box: turnRect(c.box, by), ...(c.ink ? { ink: turnRect(c.ink, by) } : {}) };
  };
  const straight = invisible
    .filter((c) => Math.abs(normalAngle(c.angle) - angle) < MAX_SKEW)
    .map((c) => ({ ...turn(c, -skew), angle: 0 }));
  // Word sizes come from the scan and vary a little; that's not super- or subscript.
  const { paragraphs, margins } = layoutChars(raw, straight, false);
  return {
    paragraphs: paragraphs.map((paragraph) => ({
      ...paragraph,
      box: rotateRect(paragraph.box, skew),
      lines: paragraph.lines.map((line) => {
        const chars = line.chars.map((c) => turn(c, skew));
        return { ...line, chars, box: rotateRect(line.box, skew), baseline: chars[0]!.y };
      }),
      recognized: true,
    })),
    margins,
  };
}

export function analyzePage(raw: RawPageText): PageText {
  const visible = raw.chars.filter((c) => !c.invisible && isHorizontal(c.angle));
  const { paragraphs: drawn, margins } = layoutChars(raw, visible);
  const recognized = recognizedParagraphs(raw);
  const paragraphs = [...drawn, ...recognized.paragraphs]
    .sort((a, b) => top(b.box) - top(a.box) || a.box.x - b.box.x)
    .map((paragraph, i) => ({ ...paragraph, id: `p${raw.pageIndex}-${i}` }));
  // A scan has no drawn text: its text block is that of the recognized text.
  const block = drawn.length || !recognized.margins ? margins : recognized.margins;
  return { pageIndex: raw.pageIndex, fonts: raw.fonts, paragraphs, block, graphics: raw.graphics };
}
