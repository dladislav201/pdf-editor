import type { TextAlign } from './types';

/** Visual style of one character. Sizes and offsets in points. */
export interface CharStyle {
  font: number;
  size: number;
  color: string;
  /** Baseline shift for super/subscripts. */
  rise: number;
  /** The document font the text was in before it was made bold or italic (set only while `font` differs). */
  base?: number;
}

export interface StyledChar {
  char: string;
  style: CharStyle;
  /**
   * Advance taken from the original page (glyph spacing incl. kerning) for
   * characters that come from it; the font's advance is used otherwise.
   */
  advance?: number;
  /** The page glyph this character was read from; lets a save move it instead of redrawing it. */
  source?: { object: number; x: number; y: number; ownObject: boolean };
}

/** Where and how a paragraph is set, in PDF user space (y up). */
export interface ParagraphFrame {
  /** Left edge of the text column. */
  x: number;
  width: number;
  firstBaseline: number;
  leading: number;
  /** Extra left offset of the first line. */
  indent: number;
  align: TextAlign;
  /** Baselines of the original lines; lines past them continue one `leading` apart. */
  baselines?: number[];
  /**
   * The paragraph's text size that `leading` goes with. A line whose largest
   * text is another size gets a leading scaled to it (and lines after it
   * follow), so text made larger doesn't run into the line above.
   */
  size?: number;
}

export type Measure = (style: CharStyle, char: string) => number;

export interface PlacedGlyph {
  /** Index into the paragraph's chars. */
  index: number;
  char: string;
  x: number;
  y: number;
  advance: number;
  style: CharStyle;
}

export interface LayoutLine {
  /** Char range of the line, end exclusive; includes trailing spaces and a hard break. */
  start: number;
  end: number;
  baseline: number;
  /** Ink extent without trailing spaces. */
  left: number;
  right: number;
  glyphs: PlacedGlyph[];
  /** Ends with an explicit line break (`\n`). */
  hardBreak: boolean;
}

export interface CaretPosition {
  line: number;
  x: number;
}

export interface ParagraphLayout {
  lines: LayoutLine[];
  /** Where the caret is drawn for a char offset (0…length). */
  caret(offset: number): CaretPosition;
  /** Char offset nearest to a point. */
  hit(x: number, y: number): number;
  /** Offset of the same x on the line above (-1) or below (+1). */
  vertical(offset: number, direction: -1 | 1, x?: number): number;
}

const isSpace = (char: string) => char === ' ' || char === ' ' || char === '\t';

interface Token {
  start: number;
  end: number;
  kind: 'word' | 'space' | 'break';
  width: number;
}

/** Words, space runs and hard breaks. A hyphen inside a word ends a token so lines may break after it. */
function tokenize(chars: StyledChar[], widths: number[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    const char = chars[i]!.char;
    const start = i;
    let kind: Token['kind'];
    if (char === '\n') {
      kind = 'break';
      i++;
    } else if (isSpace(char)) {
      kind = 'space';
      while (i < chars.length && isSpace(chars[i]!.char)) i++;
    } else {
      kind = 'word';
      while (i < chars.length && !isSpace(chars[i]!.char) && chars[i]!.char !== '\n') {
        i++;
        if (chars[i - 1]!.char === '-' && i < chars.length && !isSpace(chars[i]!.char)) break;
      }
    }
    let width = 0;
    for (let k = start; k < i; k++) width += widths[k]!;
    tokens.push({ start, end: i, kind, width });
  }
  return tokens;
}

/**
 * Sets a paragraph: greedy line breaking with the real glyph advances, first
 * line indent, alignment (justify stretches the spaces of every line but the
 * last and those ending in a hard break).
 */
export function layoutParagraph(chars: StyledChar[], frame: ParagraphFrame, measure: Measure): ParagraphLayout {
  const widths = chars.map((c) => (c.char === '\n' ? 0 : (c.advance ?? measure(c.style, c.char))));
  const tokens = tokenize(chars, widths);
  const available = (line: number) => frame.width - (line === 0 ? frame.indent : 0);

  // ---- break into lines (char ranges)
  const ranges: { start: number; end: number; hardBreak: boolean }[] = [];
  let start = 0;
  let width = 0; // ink width so far, without trailing spaces
  let pendingSpace = 0; // width of spaces after the last word
  const close = (end: number, hardBreak: boolean) => {
    ranges.push({ start, end, hardBreak });
    start = end;
    width = 0;
    pendingSpace = 0;
  };
  for (const token of tokens) {
    if (token.kind === 'break') {
      close(token.end, true);
      continue;
    }
    if (token.kind === 'space') {
      pendingSpace += token.width;
      continue;
    }
    const limit = available(ranges.length);
    if (width > 0 && width + pendingSpace + token.width > limit) close(token.start, false);
    if (width === 0 && token.width > available(ranges.length)) {
      // A word longer than the column: break it between characters.
      for (let k = token.start; k < token.end; k++) {
        if (width > 0 && width + widths[k]! > available(ranges.length)) close(k, false);
        width += widths[k]!;
      }
      continue;
    }
    width += pendingSpace + token.width;
    pendingSpace = 0;
  }
  if (start < chars.length || ranges.length === 0 || ranges[ranges.length - 1]!.hardBreak) {
    ranges.push({ start, end: chars.length, hardBreak: false });
  }

  // ---- baselines: the original ones while every line is set at the paragraph's size
  const known = frame.baselines ?? [frame.firstBaseline];
  const baselines: number[] = [];
  let resized = false;
  ranges.forEach((range, lineIndex) => {
    let largest = 0;
    for (let k = range.start; k < range.end; k++) if (chars[k]!.char !== '\n') largest = Math.max(largest, chars[k]!.style.size);
    if (!largest) largest = chars[Math.min(range.start, chars.length - 1)]?.style.size ?? 0;
    const scale = frame.size && largest ? largest / frame.size : 1;
    resized ||= Math.abs(scale - 1) > 0.02;
    const gap =
      lineIndex === 0 ? 0 : lineIndex < known.length ? known[lineIndex - 1]! - known[lineIndex]! : frame.leading;
    if (!resized) {
      baselines.push(lineIndex < known.length ? known[lineIndex]! : baselines[lineIndex - 1]! - gap);
    } else if (lineIndex === 0) {
      // The top of the first line stays: its baseline moves by the change of its ascent.
      baselines.push(known[0]! - (scale - 1) * frame.leading * 0.75);
    } else {
      baselines.push(baselines[lineIndex - 1]! - gap * scale);
    }
  });

  // ---- place glyphs
  const lines: LayoutLine[] = ranges.map((range, lineIndex) => {
    let inkEnd = range.end;
    while (inkEnd > range.start && (isSpace(chars[inkEnd - 1]!.char) || chars[inkEnd - 1]!.char === '\n')) inkEnd--;
    let ink = 0;
    let gaps = 0;
    for (let k = range.start; k < inkEnd; k++) {
      ink += widths[k]!;
      if (isSpace(chars[k]!.char)) gaps++;
    }
    const room = available(lineIndex) - ink;
    const isLast = lineIndex === ranges.length - 1;
    let offset = 0;
    let stretch = 0;
    if (frame.align === 'right') offset = room;
    else if (frame.align === 'center') offset = room / 2;
    else if (frame.align === 'justify' && !isLast && !range.hardBreak && gaps > 0 && room > 0) stretch = room / gaps;

    const baseline = baselines[lineIndex]!;
    let x = frame.x + (lineIndex === 0 ? frame.indent : 0) + offset;
    const left = x;
    const glyphs: PlacedGlyph[] = [];
    for (let k = range.start; k < range.end; k++) {
      const { char, style } = chars[k]!;
      const advance = widths[k]! + (k < inkEnd && isSpace(char) ? stretch : 0);
      glyphs.push({ index: k, char, x, y: baseline + style.rise, advance, style });
      x += advance;
    }
    const right = glyphs.slice(0, inkEnd - range.start).reduce((end, g) => g.x + g.advance, left);
    return { start: range.start, end: range.end, baseline, left, right, glyphs, hardBreak: range.hardBreak };
  });

  // ---- caret geometry
  const lineOf = (offset: number): number => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const next = lines[i + 1];
      // At a soft wrap the caret belongs to the start of the next line; after a hard break too.
      if (offset < line.end || !next) return i;
      if (offset === line.end && line.hardBreak) continue;
    }
    return lines.length - 1;
  };
  const xAt = (lineIndex: number, offset: number): number => {
    const line = lines[lineIndex]!;
    const glyph = line.glyphs[offset - line.start];
    if (glyph) return glyph.x;
    const last = line.glyphs[line.glyphs.length - 1];
    return last ? last.x + last.advance : line.left;
  };
  const caret = (offset: number): CaretPosition => {
    const clamped = Math.max(0, Math.min(chars.length, offset));
    const line = lineOf(clamped);
    return { line, x: xAt(line, clamped) };
  };
  /** Offsets a caret may take on a line: a soft-wrapped line can't put it after its trailing space. */
  const offsetsOf = (lineIndex: number): [number, number] => {
    const line = lines[lineIndex]!;
    const isLast = lineIndex === lines.length - 1;
    let end = line.end;
    if (line.hardBreak) end -= 1;
    else if (!isLast && end > line.start) end -= 1;
    return [line.start, Math.max(line.start, end)];
  };
  const nearestOnLine = (lineIndex: number, x: number): number => {
    const [from, to] = offsetsOf(lineIndex);
    let best = from;
    let bestDistance = Infinity;
    for (let offset = from; offset <= to; offset++) {
      const distance = Math.abs(xAt(lineIndex, offset) - x);
      if (distance < bestDistance) {
        best = offset;
        bestDistance = distance;
      }
    }
    return best;
  };
  const hit = (x: number, y: number): number => {
    let lineIndex = 0;
    let bestDistance = Infinity;
    lines.forEach((line, i) => {
      // Compare against the middle of the line's x-height band.
      const distance = Math.abs(line.baseline + frame.leading * 0.3 - y);
      if (distance < bestDistance) {
        lineIndex = i;
        bestDistance = distance;
      }
    });
    return nearestOnLine(lineIndex, x);
  };
  const vertical = (offset: number, direction: -1 | 1, x?: number): number => {
    const position = caret(offset);
    const target = position.line + direction;
    if (target < 0) return 0;
    if (target >= lines.length) return chars.length;
    return nearestOnLine(target, x ?? position.x);
  };

  return { lines, caret, hit, vertical };
}
