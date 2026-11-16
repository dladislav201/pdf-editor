import type { PixelBox, Raster, RecognizedWord } from './types';

/** A word as read from the straightened page, with its line's size (pixels) and weight. */
/** `stamped`: a stamp or signature crosses the word, so its letters carry bits of it. */
export type ScanWord = RecognizedWord & { size: number; bold: boolean; stamped?: boolean };

/** One letter cut from the scan: grey pixels (255 is paper), placed relative to the pen and the baseline. */
export interface ScanGlyph {
  char: string;
  width: number;
  height: number;
  /** Grey level per pixel, row by row. */
  pixels: Uint8ClampedArray;
  /** Top of the ink relative to the baseline (negative: above it). */
  top: number;
  /** Font size of the line it was cut from, in pixels. */
  size: number;
  bold: boolean;
  confidence: number;
  /** Sum of ink, to pick a typical sample rather than a smudged or broken one. */
  ink: number;
  /** Line it was cut from: letters of the line being edited fit it best. */
  line: number;
  /** Where on the straightened page it was cut from. */
  at: PixelBox;
  /** Cut from under a stamp: used only when the letter isn't found anywhere else. */
  stamped?: boolean;
}

export interface ScanStyle {
  size: number;
  bold: boolean;
  /** The line being rewritten, whose own letters are preferred. */
  line?: number;
  /** Or the area being rewritten (straightened page pixels): letters cut from it are preferred. */
  near?: PixelBox;
}

/** A letter ready to set: the sample (at the style's size) and the space it keeps on either side, in pixels. */
export interface PlacedScanGlyph {
  glyph: ScanGlyph;
  left: number;
  right: number;
}

/** Letters below this confidence, or far from the size of their line, are not cut out. */
const MIN_CONFIDENCE = 80;
/** Samples from lines within this size ratio are used as they are; others are scaled. */
const SAME_SIZE = 0.1;
/** How far a sample may be scaled to stand in for another size. */
const MAX_SCALE = 0.35;

/**
 * Where letters sit, to catch samples OCR got wrong (a capital read as lower
 * case, an "р" read as "г"): x-height letters, x-height letters with a
 * descender, and capitals/digits/ascenders, which all end on the baseline.
 */
const X_HEIGHT = /[абвгеєжзиклмнопстхчшьюяъыэacemnorsuvwxz]/;
const DESCENDER = /[дрруфцщpqyg]/;
const CAPITAL = /[A-ZА-ЯЄІЇҐЁ0-9бbdhklt]/;
const classOf = (char: string) =>
  X_HEIGHT.test(char) ? 'x' : DESCENDER.test(char) ? 'xd' : CAPITAL.test(char) && !/[ЙЇЁ]/.test(char) ? 'cap' : null;
/** A sample whose top or bottom is this far (in ems) from its class's is not that letter. */
const SHAPE_TOLERANCE = 0.09;

/** Samples further than this from their letter's typical shape (mean difference of 0–1 ink) are dropped. */
const SHAPE_DISTANCE = 0.2;
const SHAPE_GRID = 16;

/** A sample reduced to a 16×16 ink map of its box, plus its proportions in ems. */
function shapeOf(glyph: ScanGlyph): { ink: Float32Array; width: number; height: number } {
  const ink = new Float32Array(SHAPE_GRID * SHAPE_GRID);
  for (let y = 0; y < SHAPE_GRID; y++) {
    for (let x = 0; x < SHAPE_GRID; x++) {
      const sx = Math.min(glyph.width - 1, Math.floor(((x + 0.5) * glyph.width) / SHAPE_GRID));
      const sy = Math.min(glyph.height - 1, Math.floor(((y + 0.5) * glyph.height) / SHAPE_GRID));
      ink[y * SHAPE_GRID + x] = (255 - glyph.pixels[sy * glyph.width + sx]!) / 255;
    }
  }
  return { ink, width: glyph.width / glyph.size, height: glyph.height / glyph.size };
}

function inkDistance(a: ReturnType<typeof shapeOf>, b: ReturnType<typeof shapeOf>): number {
  let sum = 0;
  for (let i = 0; i < a.ink.length; i++) sum += Math.abs(a.ink[i]! - b.ink[i]!);
  return sum / a.ink.length;
}

function distance(a: ReturnType<typeof shapeOf>, b: ReturnType<typeof shapeOf>): number {
  // Proportions count as much as the picture: a capital is a scaled-up small letter.
  return inkDistance(a, b) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height);
}

/** The sample most like all the others of its letter. */
function typical(samples: ScanGlyph[]): ScanGlyph {
  const shapes = samples.map(shapeOf);
  const totals = shapes.map((a) => shapes.reduce((sum, b) => sum + distance(a, b), 0));
  return samples[totals.indexOf(Math.min(...totals))]!;
}

/** How a page's letters compare with those of a typeface. */
export interface Likeness {
  /** Mean difference of shape (0–1 ink per cell, plus the difference of width to height) over the letters compared. */
  distance: number;
  /** How much taller the page's letters are than the typeface's at the same size: what to set it larger by. */
  scale: number;
  /** How many letters were compared. */
  letters: number;
}

/** Fewer letters in common than this say little about a typeface. */
const MIN_LIKENESS_LETTERS = 5;

const centreIn = (box: PixelBox, area: PixelBox) => {
  const x = (box.x0 + box.x1) / 2;
  const y = (box.y0 + box.y1) / 2;
  return x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;
};
const isNumber = (text: string) => /^[\d.,]+$/.test(text);

const median = (values: number[], fallback: number) => {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
};

/**
 * The baseline of a word from its own letters: where letters without a
 * descender end. OCR's line baseline can be a few pixels off at either end.
 */
export function wordBaseline(word: ScanWord): number {
  const bottoms = (word.symbols ?? []).filter((s) => {
    const kind = classOf(s.text);
    return (kind === 'x' || kind === 'cap') && s.confidence >= MIN_CONFIDENCE;
  });
  return median(bottoms.map((s) => s.box.y1), word.baseline);
}

/** Darker than this is the core of a letter's ink, which the pieces of a letter are found by. */
const INK = 128;
/** Pixels this close to a letter's core keep their grey: its soft, anti-aliased edge. */
const EDGE = 2;

/** A letter's own ink, cut from the scan: its box, and its pixels with everything else turned to paper. */
export interface LetterInk {
  box: PixelBox;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/**
 * The letters of a word, cut out by their ink. OCR's letter boxes are
 * approximate: they overlap, or miss a bit of the letter. Every connected
 * piece of ink goes to the letter whose box has its centre inside the piece
 * (else to the box it overlaps most: a dot, a breve), and each letter keeps
 * only its own pieces. A piece across two centres is letters that touch:
 * both are left out (null), as is a letter with no ink of its own.
 */
export function letterInk(image: Raster, symbols: { box: PixelBox }[], size: number): (LetterInk | null)[] {
  if (!symbols.length) return [];
  const pad = Math.ceil(size * 0.15);
  const rx0 = Math.max(0, Math.floor(Math.min(...symbols.map((s) => s.box.x0))) - pad);
  const ry0 = Math.max(0, Math.floor(Math.min(...symbols.map((s) => s.box.y0))) - pad);
  const rx1 = Math.min(image.width, Math.ceil(Math.max(...symbols.map((s) => s.box.x1))) + pad);
  const ry1 = Math.min(image.height, Math.ceil(Math.max(...symbols.map((s) => s.box.y1))) + pad);
  const W = rx1 - rx0;
  const H = ry1 - ry0;
  if (W <= 0 || H <= 0) return symbols.map(() => null);
  const grey = (x: number, y: number) => image.rgba[((ry0 + y) * image.width + rx0 + x) * 4]!;

  // Connected pieces of ink (8-connected), smallest specks left out.
  const piece = new Int32Array(W * H).fill(-1);
  const pieces: { x0: number; y0: number; x1: number; y1: number; pixels: number[] }[] = [];
  const minArea = Math.max(3, (size * 0.04) ** 2);
  for (let start = 0; start < W * H; start++) {
    if (piece[start]! !== -1 || grey(start % W, Math.floor(start / W)) >= INK) continue;
    const id = pieces.length;
    const found = { x0: W, y0: H, x1: -1, y1: -1, pixels: [] as number[] };
    const stack = [start];
    piece[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = Math.floor(p / W);
      found.pixels.push(p);
      found.x0 = Math.min(found.x0, x);
      found.y0 = Math.min(found.y0, y);
      found.x1 = Math.max(found.x1, x);
      found.y1 = Math.max(found.y1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (piece[q] === -1 && grey(nx, ny) < INK) {
            piece[q] = id;
            stack.push(q);
          }
        }
      }
    }
    pieces.push(found);
  }

  // Letters as clusters of pieces: a dot, a breve or a colon's other half goes with the piece it sits over.
  const kept = pieces.map((p, id) => ({ ...p, id })).filter((p) => p.pixels.length >= minArea);
  const span = (p: { x0: number; x1: number }) => p.x1 + 1 - p.x0;
  const clusterOf = new Map<number, number>();
  const widest = [...kept].sort((a, b) => span(b) - span(a));
  const sitsOn = (p: (typeof kept)[number], q: (typeof kept)[number]) =>
    Math.min(q.x1, p.x1) + 1 - Math.max(q.x0, p.x0) >= 0.5 * span(p) ||
    // A small mark above or below it, a little wider maybe: the dots of "ї".
    (span(p) < 0.25 * size && p.x0 >= q.x0 - 0.1 * size && p.x1 <= q.x1 + 0.1 * size && (p.y1 < q.y0 || p.y0 > q.y1));
  for (const p of widest) {
    const base = widest.find((q) => q.id !== p.id && clusterOf.has(q.id) && span(q) >= span(p) && sitsOn(p, q));
    clusterOf.set(p.id, base ? clusterOf.get(base.id)! : p.id);
  }
  const clusters = [...new Set(clusterOf.values())]
    .map((root) => {
      const members = kept.filter((p) => clusterOf.get(p.id) === root);
      return { ids: members.map((p) => p.id), x0: Math.min(...members.map((p) => p.x0)), x1: Math.max(...members.map((p) => p.x1)) };
    })
    .sort((a, b) => a.x0 - b.x0);

  const boxes = symbols.map((s) => ({ x0: s.box.x0 - rx0, x1: s.box.x1 - rx0 }));
  const owner = pieces.map(() => -1);
  const unsure = new Set<number>();
  if (clusters.length === symbols.length) {
    // As many letters of ink as OCR read: they go in order, whatever the boxes say.
    clusters.forEach((cluster, k) => cluster.ids.forEach((id) => (owner[id] = k)));
  } else {
    // Otherwise by the centres of the boxes. Ink across two centres is touching letters;
    // ink with none means the boxes are off here: the letters they overlap are left out.
    const centres = boxes.map((b) => (b.x0 + b.x1) / 2);
    for (const cluster of clusters) {
      const inside = centres.flatMap((c, k) => (c >= cluster.x0 && c <= cluster.x1 + 1 ? [k] : []));
      if (inside.length === 1) cluster.ids.forEach((id) => (owner[id] = inside[0]!));
      const suspects =
        inside.length > 1
          ? inside
          : inside.length
            ? []
            : boxes.flatMap((b, k) => (Math.min(b.x1, cluster.x1 + 1) - Math.max(b.x0, cluster.x0) > 0.3 * span(cluster) ? [k] : []));
      for (const k of suspects) unsure.add(k);
    }
  }

  return symbols.map((_, k) => {
    const own = pieces.filter((_, id) => owner[id] === k);
    if (unsure.has(k) || !own.length) return null;
    const x0 = Math.min(...own.map((p) => p.x0));
    const y0 = Math.min(...own.map((p) => p.y0));
    const x1 = Math.max(...own.map((p) => p.x1)) + 1;
    const y1 = Math.max(...own.map((p) => p.y1)) + 1;
    const width = x1 - x0;
    const height = y1 - y0;
    // Ink much wider than the box: two touching letters, the other one boxed off its ink.
    if (width > 1.5 * (boxes[k]!.x1 - boxes[k]!.x0) + 0.15 * size) return null;
    // Its ink and the soft edge around it; another letter's ink, specks and the rest are paper.
    const near = new Uint8Array(width * height);
    for (const p of own) {
      for (const at of p.pixels) {
        const px = (at % W) - x0;
        const py = Math.floor(at / W) - y0;
        for (let y = Math.max(0, py - EDGE); y <= Math.min(height - 1, py + EDGE); y++) {
          for (let x = Math.max(0, px - EDGE); x <= Math.min(width - 1, px + EDGE); x++) near[y * width + x] = 1;
        }
      }
    }
    const pixels = new Uint8ClampedArray(width * height).fill(255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = piece[(y0 + y) * W + x0 + x]!;
        const theirs = id !== -1 && owner[id] !== k;
        if (near[y * width + x] && !theirs) pixels[y * width + x] = grey(x0 + x, y0 + y);
      }
    }
    return { box: { x0: rx0 + x0, y0: ry0 + y0, x1: rx0 + x1, y1: ry0 + y1 }, width, height, pixels };
  });
}

/**
 * A regular letter made bold: every stroke thickened sideways, by the
 * difference between bold and regular stems (about 6% of the size).
 */
function emboldenGlyph(glyph: ScanGlyph, size: number): ScanGlyph {
  const grow = Math.max(1, Math.round(size * 0.03));
  const width = glyph.width + grow * 2;
  const pixels = new Uint8ClampedArray(width * glyph.height).fill(255);
  for (let y = 0; y < glyph.height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 255;
      for (let k = -grow; k <= grow; k++) {
        const sx = x - grow + k;
        if (sx >= 0 && sx < glyph.width) v = Math.min(v, glyph.pixels[y * glyph.width + sx]!);
      }
      pixels[y * width + x] = v;
    }
  }
  return { ...glyph, width, pixels, bold: true };
}

/** Bilinear resize of a glyph, for a size the page has no samples of. */
function scaleGlyph(glyph: ScanGlyph, factor: number): ScanGlyph {
  const width = Math.max(1, Math.round(glyph.width * factor));
  const height = Math.max(1, Math.round(glyph.height * factor));
  const pixels = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(glyph.width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const sy = Math.min(glyph.height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(glyph.width - 1, x0 + 1);
      const y1 = Math.min(glyph.height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const at = (px: number, py: number) => glyph.pixels[py * glyph.width + px]!;
      pixels[y * width + x] =
        at(x0, y0) * (1 - fx) * (1 - fy) + at(x1, y0) * fx * (1 - fy) + at(x0, y1) * (1 - fx) * fy + at(x1, y1) * fx * fy;
    }
  }
  return { ...glyph, width, height, pixels, top: glyph.top * factor, size: glyph.size * factor };
}

/**
 * The letters of a scanned page, cut from the scan itself, to set new text
 * that looks like the rest of the page: the same type, the same blur and
 * ink, because it is the same pixels. Spacing comes from the page too.
 */
export class ScanFont {
  private readonly glyphs = new Map<string, ScanGlyph[]>();
  /** Gap between letters and between words, as a share of the size, per weight. */
  private readonly letterGap = new Map<boolean, number>();
  private readonly wordGap = new Map<boolean, number>();
  /** Space between groups of digits ("38 760,00"): narrower than between words. */
  private readonly numberGap = new Map<boolean, number>();
  /** The same, measured on each line: digits in a table are set tighter than prose. */
  private readonly lineGaps = new Map<number, { box: PixelBox; letter: number; word: number }>();
  /**
   * Space each letter keeps before and after itself (half the gaps seen next
   * to it), per weight, in ems: "1" in tabular digits keeps a lot, "," little.
   */
  private readonly bearings = new Map<string, { left: number; right: number }>();
  /** Digits in documents are usually tabular: each takes the same width. Ems per weight, from the page. */
  private readonly digitPitch = new Map<boolean, number>();

  static fromPage(image: Raster, words: ScanWord[]): ScanFont {
    const font = new ScanFont();
    const letterGaps: Record<'true' | 'false', number[]> = { true: [], false: [] };
    const wordGaps: Record<'true' | 'false', number[]> = { true: [], false: [] };
    const numberGaps: Record<'true' | 'false', number[]> = { true: [], false: [] };
    const pitches: Record<'true' | 'false', number[]> = { true: [], false: [] };
    const before = new Map<string, number[]>();
    const after = new Map<string, number[]>();
    const add = (map: Map<string, number[]>, key: string, value: number) => map.set(key, [...(map.get(key) ?? []), value]);
    const byLine = new Map<number, ScanWord[]>();
    for (const word of words) byLine.set(word.line, [...(byLine.get(word.line) ?? []), word]);
    for (const [line, lineWords] of byLine) {
      lineWords.sort((a, b) => a.box.x0 - b.box.x0);
      const own = { letters: [] as number[], words: [] as number[] };
      lineWords.forEach((word, i) => {
        const baseline = wordBaseline(word);
        const next = lineWords[i + 1];
        if (next && word.confidence > 70 && next.confidence > 70) {
          const gap = (next.box.x0 - word.box.x1) / word.size;
          if (isNumber(word.text) && isNumber(next.text) && /\d$/.test(word.text)) numberGaps[String(word.bold) as 'true'].push(gap);
          else {
            wordGaps[String(word.bold) as 'true'].push(gap);
            own.words.push(gap);
          }
        }
        const symbols = word.symbols ?? [];
        const letters = letterInk(image, symbols, word.size);
        symbols.forEach((symbol, k) => {
          const following = symbols[k + 1];
          const box = letters[k]?.box;
          const nextBox = letters[k + 1]?.box;
          if (following && box && nextBox && symbol.confidence >= MIN_CONFIDENCE && following.confidence >= MIN_CONFIDENCE) {
            const gap = (nextBox.x0 - box.x1) / word.size;
            letterGaps[String(word.bold) as 'true'].push(gap);
            own.letters.push(gap);
            add(after, `${symbol.text}|${word.bold}`, gap);
            add(before, `${following.text}|${word.bold}`, gap);
            if (/^\d$/.test(symbol.text) && /^\d$/.test(following.text)) {
              pitches[String(word.bold) as 'true'].push((nextBox.x0 - box.x0) / word.size);
            }
          }
          // A letter that can't be cut apart from its neighbours would bring a piece of them along.
          if (!box) return;
          const w = box.x1 - box.x0;
          const h = box.y1 - box.y0;
          if ([...symbol.text].length !== 1 || symbol.confidence < MIN_CONFIDENCE) return;
          if (w <= 0 || h <= 0 || w > 1.6 * word.size || h > 1.6 * word.size) return;
          // Punctuation is small; a wide "quote" is a letter OCR folded into it.
          if (!/[\p{L}\p{N}]/u.test(symbol.text) && w > 0.45 * word.size) return;
          const cut = letters[k]!;
          let ink = 0;
          for (const p of cut.pixels) ink += 255 - p;
          const glyph: ScanGlyph = {
            char: symbol.text,
            ...cut,
            top: box.y0 - baseline,
            size: word.size,
            bold: word.bold,
            confidence: symbol.confidence,
            ink,
            line: word.line,
            at: box,
            ...(word.stamped ? { stamped: true } : {}),
          };
          font.glyphs.set(symbol.text, [...(font.glyphs.get(symbol.text) ?? []), glyph]);
        });
      });
      if (own.letters.length >= 4) {
        const box = {
          x0: Math.min(...lineWords.map((w) => w.box.x0)),
          y0: Math.min(...lineWords.map((w) => w.box.y0)),
          x1: Math.max(...lineWords.map((w) => w.box.x1)),
          y1: Math.max(...lineWords.map((w) => w.box.y1)),
        };
        font.lineGaps.set(line, { box, letter: median(own.letters, 0.06), word: median(own.words, Number.NaN) });
      }
    }
    font.dropMisread();
    for (const bold of [false, true]) {
      const letter = median(letterGaps[String(bold) as 'true'], 0.06);
      const word = median(wordGaps[String(bold) as 'true'], 0.28);
      font.letterGap.set(bold, letter);
      font.wordGap.set(bold, word);
      font.numberGap.set(bold, median(numberGaps[String(bold) as 'true'], Math.max(letter * 2, word * 0.7)));
      const pitch = pitches[String(bold) as 'true'];
      if (pitch.length >= 3) font.digitPitch.set(bold, median(pitch, 0));
    }
    // Bearings need a few sightings; a letter seen less keeps half the usual gap.
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const bold = key.endsWith('|true');
      const half = font.letterGap.get(bold)! / 2;
      const left = before.get(key) ?? [];
      const right = after.get(key) ?? [];
      font.bearings.set(key, {
        left: left.length >= 2 ? Math.max(0, median(left, 0) - half) : half,
        right: right.length >= 2 ? Math.max(0, median(right, 0) - half) : half,
      });
    }
    return font;
  }

  /**
   * Drops samples OCR got wrong: those whose top or bottom doesn't sit where
   * their kind of letter sits on this page, and those that don't look like
   * most other samples of the same letter (a capital read as lower case, an
   * "r" read as "г", two letters in one box).
   */
  private dropMisread(): void {
    const all = [...this.glyphs.values()].flat();
    const top = (g: ScanGlyph) => g.top / g.size;
    const bottom = (g: ScanGlyph) => (g.top + g.height) / g.size;
    const xTop = median(all.filter((g) => classOf(g.char) === 'x').map(top), -0.53);
    const capTop = median(all.filter((g) => classOf(g.char) === 'cap').map(top), -0.71);
    const expected: Record<string, { top: number; bottom: (b: number) => boolean }> = {
      x: { top: xTop, bottom: (b) => Math.abs(b) <= SHAPE_TOLERANCE },
      xd: { top: xTop, bottom: (b) => b > 0.12 },
      cap: { top: capTop, bottom: (b) => Math.abs(b) <= SHAPE_TOLERANCE },
    };
    for (const [char, samples] of this.glyphs) {
      const kind = classOf(char);
      if (!kind) continue;
      const rule = expected[kind]!;
      const kept = samples.filter((g) => Math.abs(top(g) - rule.top) <= SHAPE_TOLERANCE && rule.bottom(bottom(g)));
      if (kept.length) this.glyphs.set(char, kept);
      else this.glyphs.delete(char);
    }
    for (const [char, samples] of this.glyphs) {
      // Bold and regular letters differ in shape: each weight keeps its own typical form.
      const kept = [true, false].flatMap((bold) => {
        const group = samples.filter((g) => g.bold === bold);
        if (group.length < 3) return group;
        const shapes = group.map(shapeOf);
        // The medoid: the sample most like all the others.
        const totals = shapes.map((a) => shapes.reduce((sum, b) => sum + distance(a, b), 0));
        const medoid = shapes[totals.indexOf(Math.min(...totals))]!;
        return group.filter((_, i) => distance(shapes[i]!, medoid) <= SHAPE_DISTANCE);
      });
      this.glyphs.set(char, kept);
    }
  }

  /**
   * The page's letters against a typeface's (`reference` draws one, at any
   * size): to tell which typeface the page is set in, and how much larger to
   * set it for its letters to stand as tall as the page's. Regular letters
   * are compared where the page has enough of them. Null with too few
   * letters in common.
   */
  likeness(reference: (char: string) => ScanGlyph | null): Likeness | null {
    const letters = [...this.glyphs].filter(([char]) => /\p{L}/u.test(char));
    const regular = letters.map(([char, samples]) => [char, samples.filter((g) => !g.bold)] as const).filter(([, s]) => s.length);
    const pool = regular.length >= MIN_LIKENESS_LETTERS ? regular : letters;
    const distances: number[] = [];
    const ratios: number[] = [];
    for (const [char, samples] of pool) {
      const glyph = reference(char);
      if (!glyph || !glyph.height) continue;
      const sample = typical(samples);
      const a = shapeOf(sample);
      const b = shapeOf(glyph);
      // Width to height, not ems: the page's size was measured as if it were Arial.
      distances.push(inkDistance(a, b) + Math.abs(a.width / a.height - b.width / b.height));
      ratios.push(a.height / b.height);
    }
    if (distances.length < MIN_LIKENESS_LETTERS) return null;
    return { distance: distances.reduce((sum, d) => sum + d, 0) / distances.length, scale: median(ratios, 1), letters: distances.length };
  }

  /** Characters the page has samples of. */
  get chars(): string[] {
    return [...this.glyphs.keys()];
  }

  /**
   * A sample of `char` for a style: from the area being rewritten if it has
   * one, else of the same weight and size, else the nearest size scaled. The
   * most typical samples come first; `occurrence` (the n-th time the letter
   * appears in the text) steps through the few best, so "00" isn't one blot
   * twice, and the same text always gets the same letters.
   */
  glyph(char: string, style: ScanStyle, occurrence = 0): ScanGlyph | null {
    const samples = this.glyphs.get(char) ?? [];
    // Letters from under a stamp bring bits of it along; clean ones from anywhere on the page do better.
    const clean = samples.filter((g) => !g.stamped);
    const all = clean.length ? clean : samples;
    const ratio = (g: ScanGlyph) => g.size / style.size;
    const fits = (g: ScanGlyph) => Math.abs(ratio(g) - 1) <= SAME_SIZE;
    const sameWeight = all.filter((g) => g.bold === style.bold);
    const own = sameWeight.filter((g) => (style.line !== undefined ? g.line === style.line : style.near ? centreIn(g.at, style.near) : false));
    // In order: the area's own letters; the same weight and size; for bold, regular letters of
    // that size made bolder; the same weight scaled from the nearest size. Never a bold letter
    // in regular text: it stands out more than a letter of the fallback typeface does.
    let candidates = own.filter(fits);
    if (!candidates.length) candidates = sameWeight.filter(fits);
    let embolden = false;
    if (!candidates.length && style.bold) {
      candidates = all.filter((g) => !g.bold && fits(g));
      embolden = candidates.length > 0;
    }
    if (!candidates.length) {
      const pool = sameWeight.length || !style.bold ? sameWeight : all;
      if (!pool.length) return null;
      const nearest = Math.min(...pool.map((g) => Math.abs(ratio(g) - 1)));
      if (nearest > MAX_SCALE) return null;
      candidates = pool.filter((g) => Math.abs(Math.abs(ratio(g) - 1) - nearest) < 0.02);
    }
    const shapes = candidates.map(shapeOf);
    const totals = shapes.map((a) => shapes.reduce((sum, b) => sum + distance(a, b), 0));
    const ranked = candidates
      .map((g, i) => ({ g, score: totals[i]! - g.confidence / 1000 }))
      .sort((a, b) => a.score - b.score)
      .map((r) => r.g);
    const sample = ranked[occurrence % Math.min(3, ranked.length)]!;
    const factor = style.size / sample.size;
    const sized = Math.abs(factor - 1) <= SAME_SIZE ? sample : scaleGlyph(sample, factor);
    return embolden ? emboldenGlyph(sized, style.size) : sized;
  }

  /** `char` set at a style: its sample and the space around it, in pixels at that size. */
  place(char: string, style: ScanStyle, occurrence = 0): PlacedScanGlyph | null {
    const glyph = this.glyph(char, style, occurrence);
    if (!glyph) return null;
    return { glyph, ...this.sides(char, style, glyph.width) };
  }

  /** Space a letter keeps on either side, in pixels at the style's size. Digits fill a fixed-width cell. */
  sides(char: string, style: ScanStyle, width?: number): { left: number; right: number } {
    const pitch = this.digitPitch.get(style.bold);
    if (pitch && width !== undefined && /^\d$/.test(char)) {
      const room = Math.max(0, pitch * style.size - width);
      return { left: room / 2, right: room / 2 };
    }
    const half = this.gaps(style).letter / 2;
    const bearing = this.bearings.get(`${char}|${style.bold}`);
    // Scale the page-wide bearings to this line's own spacing.
    const scale = half / ((this.letterGap.get(style.bold)! / 2) * style.size || 1);
    return bearing ? { left: bearing.left * style.size * scale, right: bearing.right * style.size * scale } : { left: half, right: half };
  }

  /** Width of a space, in pixels: between words, or the narrower one between groups of digits. */
  space(style: ScanStyle, betweenDigits = false): number {
    const { letter, word } = this.gaps(style);
    const width = betweenDigits ? this.numberGap.get(style.bold)! * style.size : word;
    return Math.max(width - letter, letter);
  }

  gaps(style: ScanStyle): { letter: number; word: number } {
    const own =
      style.line !== undefined
        ? this.lineGaps.get(style.line)
        : style.near
          ? [...this.lineGaps.values()].find((g) => centreIn(g.box, style.near!))
          : undefined;
    const letter = own?.letter ?? this.letterGap.get(style.bold)!;
    const word = own && !Number.isNaN(own.word) ? own.word : this.wordGap.get(style.bold)!;
    return { letter: letter * style.size, word: word * style.size };
  }
}

/** New text set in a scan's own letters: each glyph with its pen position, and what the page had no letter for. */
export interface ScanLayout {
  glyphs: { glyph: ScanGlyph; x: number }[];
  width: number;
  missing: string[];
}

/**
 * Lays `text` out with the page's letters. `fallback` makes a glyph for
 * characters the page lacks (drawn in a matching font); without it they are
 * left out and reported in `missing`.
 */
export function setInScanFont(
  font: ScanFont,
  text: string,
  style: ScanStyle,
  fallback?: (char: string, style: ScanStyle) => ScanGlyph | null,
): ScanLayout {
  const glyphs: ScanLayout['glyphs'] = [];
  const missing: string[] = [];
  const seen = new Map<string, number>();
  const chars = [...text];
  let x = 0;
  let trailing = 0;
  chars.forEach((char, i) => {
    if (char === ' ') {
      x += font.space(style, /\d/.test(chars[i - 1] ?? '') && /\d/.test(chars[i + 1] ?? ''));
      trailing = 0;
      return;
    }
    const occurrence = seen.get(char) ?? 0;
    seen.set(char, occurrence + 1);
    let placed = font.place(char, style, occurrence);
    if (!placed) {
      const glyph = fallback?.(char, style);
      if (glyph) placed = { glyph, ...font.sides(char, style) };
      missing.push(char);
    }
    if (!placed) return;
    x += placed.left;
    glyphs.push({ glyph: placed.glyph, x });
    x += placed.glyph.width + placed.right;
    trailing = placed.right;
  });
  // The width ends at the last letter's ink, for right-aligned text.
  return { glyphs, width: x - trailing, missing };
}

/** Draws laid out scan letters onto an image with their baseline at `baseline`, darkening only. */
export function drawScanText(image: Raster, layout: ScanLayout, left: number, baseline: number): void {
  for (const { glyph, x } of layout.glyphs) {
    const ox = Math.round(left + x);
    const oy = Math.round(baseline + glyph.top);
    for (let y = 0; y < glyph.height; y++) {
      for (let gx = 0; gx < glyph.width; gx++) {
        const px = ox + gx;
        const py = oy + y;
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
        const v = glyph.pixels[y * glyph.width + gx]!;
        const o = (py * image.width + px) * 4;
        image.rgba[o] = Math.min(image.rgba[o]!, v);
        image.rgba[o + 1] = Math.min(image.rgba[o + 1]!, v);
        image.rgba[o + 2] = Math.min(image.rgba[o + 2]!, v);
      }
    }
  }
}
