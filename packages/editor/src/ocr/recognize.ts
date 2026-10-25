import { estimateSkew, rotate, unrotateBox, unrotatePoint } from './deskew';
import { detectTableCells } from './grid';
import { removeColoredInk } from './ink';
import { fixLine, isNoise } from './post';
import { inkColor, lineColor, lineSize, strokeWidth } from './style';
import type { PixelBox, PlacedWord, Raster, RecognizedWord } from './types';

/** What the pipeline needs from an OCR engine (Tesseract in practice). */
export interface OcrEngine {
  /**
   * `page` lets the engine find blocks and lines itself; `block` reads a crop
   * as one block of text; `numeric` restricts it to digits and separators.
   */
  recognize(image: Raster, mode: { layout: 'page' | 'block'; numeric?: boolean }): Promise<RecognizedWord[]>;
}

export interface RasterResult {
  words: PlacedWord[];
  /**
   * The page as it was read: straightened, coloured ink removed, with the
   * words (fixed text, letters included) in its pixels. What a scan's own
   * letters are cut from.
   */
  straight: { image: Raster; words: (RecognizedWord & { size: number; bold: boolean })[] };
  /** Skew that was corrected, in radians. */
  angle: number;
  cells: number;
}

/** Cell crops are read at twice the size, with a white margin, away from the borders. */
const CELL_SCALE = 2;
const CELL_MARGIN = 20;
/** Text often starts right under a border, so the crop stays tight and the border is erased instead. */
const CELL_INSET = 1;
/** How far into the crop a border (or its JPEG halo) can reach. */
const BORDER_REACH = 8;
/** Line numbers of re-read cells start here, a block of this many per cell. */
const CELL_LINES = 100_000;
/** Stroke-to-height ratio above the page's median by this factor reads as bold. */
const BOLD_RATIO = 1.3;

/** Whitens rows and columns near the crop's edges that are mostly dark: the cell's own borders. */
function eraseBorders(image: Raster): void {
  const { width: w, height: h, rgba } = image;
  const dark = (x: number, y: number) => rgba[(y * w + x) * 4]! < 160;
  const white = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
  };
  const inner = { x0: CELL_MARGIN, y0: CELL_MARGIN, x1: w - CELL_MARGIN, y1: h - CELL_MARGIN };
  const reach = BORDER_REACH * CELL_SCALE;
  for (const y of [...Array(reach).keys()].flatMap((k) => [inner.y0 + k, inner.y1 - 1 - k])) {
    let n = 0;
    for (let x = inner.x0; x < inner.x1; x++) if (dark(x, y)) n++;
    if (n > (inner.x1 - inner.x0) * 0.6) for (let x = inner.x0; x < inner.x1; x++) white(x, y);
  }
  for (const x of [...Array(reach).keys()].flatMap((k) => [inner.x0 + k, inner.x1 - 1 - k])) {
    let n = 0;
    for (let y = inner.y0; y < inner.y1; y++) if (dark(x, y)) n++;
    if (n > (inner.y1 - inner.y0) * 0.6) for (let y = inner.y0; y < inner.y1; y++) white(x, y);
  }
}

function crop(raster: Raster, box: PixelBox): Raster {
  const x0 = box.x0 + CELL_INSET;
  const y0 = box.y0 + CELL_INSET;
  const w = Math.max(1, box.x1 - box.x0 - CELL_INSET * 2);
  const h = Math.max(1, box.y1 - box.y0 - CELL_INSET * 2);
  const width = w * CELL_SCALE + CELL_MARGIN * 2;
  const height = h * CELL_SCALE + CELL_MARGIN * 2;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < h * CELL_SCALE; y++) {
    for (let x = 0; x < w * CELL_SCALE; x++) {
      const v = raster.rgba[((y0 + Math.floor(y / CELL_SCALE)) * raster.width + x0 + Math.floor(x / CELL_SCALE)) * 4]!;
      const o = ((y + CELL_MARGIN) * width + x + CELL_MARGIN) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
    }
  }
  const image = { width, height, rgba };
  eraseBorders(image);
  return image;
}

/** From cell-crop pixels back to page pixels. */
function fromCell(word: RecognizedWord, cell: PixelBox): RecognizedWord {
  const x = (v: number) => cell.x0 + CELL_INSET + (v - CELL_MARGIN) / CELL_SCALE;
  const y = (v: number) => cell.y0 + CELL_INSET + (v - CELL_MARGIN) / CELL_SCALE;
  const box = (b: PixelBox) => ({ x0: x(b.x0), y0: y(b.y0), x1: x(b.x1), y1: y(b.y1) });
  return {
    ...word,
    box: box(word.box),
    symbols: word.symbols?.map((s) => ({ ...s, box: box(s.box) })),
    baseline: y(word.baseline),
    lineHeight: word.lineHeight / CELL_SCALE,
    fromCell: true,
  };
}

/** Remnants of a border read as "|" or "[" are trimmed off cell words; words that are nothing else go. */
function cellWords(words: RecognizedWord[], cell: PixelBox): RecognizedWord[] {
  return words
    .map((w) =>
      fromCell(
        { ...w, text: w.text.replace(/^[|[\]]+|[|[\]]+$/g, ''), symbols: w.symbols?.filter((s) => !/^[|[\]]$/.test(s.text)) },
        cell,
      ),
    )
    .filter((w) => w.text.length > 0);
}

const centre = (b: PixelBox) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] as const;
const inside = (b: PixelBox, cell: PixelBox) => {
  const [x, y] = centre(b);
  return x >= cell.x0 && x <= cell.x1 && y >= cell.y0 && y <= cell.y1;
};
const mean = (words: RecognizedWord[]) => words.reduce((s, w) => s + w.confidence, 0) / Math.max(1, words.length);

/** A crop with at least a few dozen dark pixels has something written in it. */
function hasInk(image: Raster): boolean {
  let dark = 0;
  for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i]! < 128 && ++dark > 40) return true;
  return false;
}

/**
 * Reads a scanned page: drops coloured ink (stamps, signatures), straightens
 * the page, recognizes it, re-reads every table cell on its own (borders
 * otherwise eat digits next to them; numeric cells with a digits-only
 * alphabet), removes noise and fixes Latin look-alikes in Cyrillic text.
 * Boxes come back in the original raster's pixels.
 */
export async function recognizeRaster(source: Raster, engine: OcrEngine): Promise<RasterResult> {
  const clean: Raster = { width: source.width, height: source.height, rgba: new Uint8ClampedArray(source.rgba) };
  removeColoredInk(clean);
  const angle = estimateSkew(clean);
  const straight = Math.abs(angle) > 0.0005 ? rotate(clean, angle) : clean;

  let words = await engine.recognize(straight, { layout: 'page' });
  const cells = detectTableCells(straight);
  let reread = 0;
  for (const cell of cells) {
    const original = words.filter((w) => inside(w.box, cell));
    const image = crop(straight, cell);
    // The page pass often misses short cell contents (a "1", a "68") right next to borders.
    if (!original.length && !hasInk(image)) continue;
    let better = cellWords(await engine.recognize(image, { layout: 'block' }), cell);
    const alnum = better.map((w) => w.text).join('').replace(/[^\p{L}\p{N}]/gu, '');
    if (alnum && (alnum.match(/\p{N}/gu) ?? []).length / alnum.length >= 0.6) {
      const digits = cellWords(await engine.recognize(image, { layout: 'block', numeric: true }), cell);
      if (digits.length && mean(digits) >= mean(better)) better = digits;
    }
    if (!better.length || (original.length && mean(better) < mean(original) - 10)) continue;
    if (!original.length && mean(better) < 60) continue;
    // The cell's words replace what the page pass read there, as lines of their own: the page
    // pass often reads a table column by column, so its line numbers don't follow the rows.
    const base = CELL_LINES + reread * CELL_LINES;
    words = [...words.filter((w) => !original.includes(w)), ...better.map((w) => ({ ...w, line: base + w.line }))];
    reread++;
  }

  words = words.filter((w) => !isNoise(w.text, w.confidence));
  const byLine = new Map<number, RecognizedWord[]>();
  for (const word of words) byLine.set(word.line, [...(byLine.get(word.line) ?? []), word]);
  // Font size per line from the height of its ink; bold where strokes are clearly
  // thicker, for that size, than the page's typical text.
  const sizes = new Map<number, number>();
  for (const [line, lineWords] of byLine) {
    const ascents = lineWords.map((w) => ({ text: w.text, ascent: w.baseline - w.box.y0 }));
    sizes.set(line, lineSize(ascents, lineWords[0]!.lineHeight));
  }
  const weight = new Map(words.map((w) => [w, strokeWidth(straight, w.box) / sizes.get(w.line)!]));
  const weights = [...weight.values()].sort((a, b) => a - b);
  const typical = weights[weights.length >> 1] ?? 0;
  const isBold = (w: RecognizedWord) => weights.length >= 10 && weight.get(w)! > typical * BOLD_RATIO;

  const fixed: PlacedWord[] = [];
  const straightWords: RasterResult['straight']['words'] = [];
  const back = (point: [number, number]) => (straight === clean ? point : unrotatePoint(point, angle, source.width, source.height));
  // Words go back onto the skewed original, along their (now tilted) baselines.
  const up: [number, number] = [Math.sin(angle), -Math.cos(angle)];
  for (const [, lineWords] of [...byLine].sort((a, b) => a[0] - b[0])) {
    lineWords.sort((a, b) => a.box.x0 - b.box.x0);
    const texts = fixLine(lineWords.map((w) => w.text));
    const color = lineColor(
      lineWords.map((w) => inkColor(source, straight === clean ? w.box : unrotateBox(w.box, angle, source.width, source.height))),
    );
    lineWords.forEach((w, i) => {
      // Tesseract now and then gives a word the box of half its line; it ends where the next word starts.
      const next = lineWords[i + 1];
      const own = next && w.box.x1 > next.box.x0 ? { ...w.box, x1: Math.max(w.box.x0 + 1, next.box.x0 - 1) } : w.box;
      // Short words ("№", "1") measure poorly: a line that is mostly bold is all bold, and vice versa.
      const boldShare = lineWords.filter(isBold).length / lineWords.length;
      const bold = boldShare >= 0.6 || (boldShare > 0.4 && isBold(w));
      // Fixed look-alikes apply to the letters too, when they still line up one to one.
      const letters = [...texts[i]!];
      const symbols = w.symbols?.length === letters.length ? w.symbols.map((s, k) => ({ ...s, text: letters[k]! })) : w.symbols;
      straightWords.push({ ...w, text: texts[i]!, symbols, box: own, size: sizes.get(w.line)!, bold });
      w = { ...w, box: own };
      const box = straight === clean ? own : unrotateBox(own, angle, source.width, source.height);
      const start = back([w.box.x0, w.baseline]);
      const end = back([w.box.x1, w.baseline]);
      fixed.push({
        ...w,
        text: texts[i]!,
        box,
        baseline: start[1],
        start,
        end,
        up: straight === clean ? [0, -1] : up,
        size: sizes.get(w.line)!,
        bold,
        color,
      });
    });
  }
  return { words: fixed, straight: { image: straight, words: straightWords }, angle, cells: reread };
}
