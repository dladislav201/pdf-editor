import type { PixelBox, Raster } from './types';

interface HLine {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

const DARK = 128;
/**
 * Ruling lines are thin: 0.5–1.5 pt is 2–6 px at 300 dpi, plus JPEG blur and
 * what's left of the skew. Anything thicker is a filled shape or bold text.
 */
const MAX_THICKNESS = 14;
/** How close (px) a vertical line's end must come to a horizontal line to count as joined. */
const JOIN = 8;

/**
 * Finds table cells from their ruling lines. Vertical lines only count when
 * they connect two horizontal ones, so the stems of large bold letters are
 * never mistaken for borders. Each vertical line is split where horizontal
 * lines cross it, so header and data rows become separate cells.
 */
export function detectTableCells(raster: Raster): PixelBox[] {
  const { width: w, height: h, rgba } = raster;
  const dark = (x: number, y: number) => rgba[(y * w + x) * 4]! < DARK;

  // ---- horizontal rules: long dark runs in a row, merged across their thickness
  const minRun = Math.max(60, Math.round(w * 0.04));
  const segments: { y: number; x0: number; x1: number }[] = [];
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && dark(x, y)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= minRun) segments.push({ y, x0: start, x1: x - 1 });
        start = -1;
      }
    }
  }
  const hlines: HLine[] = [];
  for (const s of segments) {
    const line = hlines.find((l) => s.y - l.y1 <= 1 && s.x0 < l.x1 && s.x1 > l.x0);
    if (line) {
      line.y1 = s.y;
      line.x0 = Math.min(line.x0, s.x0);
      line.x1 = Math.max(line.x1, s.x1);
    } else {
      hlines.push({ y0: s.y, y1: s.y, x0: s.x0, x1: s.x1 });
    }
  }
  const rules = hlines.filter((l) => l.y1 - l.y0 + 1 <= MAX_THICKNESS);
  if (rules.length < 2) return [];
  const ruleAt = (x: number, y: number) => rules.find((l) => x >= l.x0 - JOIN && x <= l.x1 + JOIN && y >= l.y0 - JOIN && y <= l.y1 + JOIN);

  // ---- vertical rules: dark runs in a column whose both ends touch a horizontal rule
  const verticals: { x: number; y0: number; y1: number }[] = [];
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      if (y < h && dark(x, y)) {
        if (start < 0) start = y;
      } else if (start >= 0) {
        const end = y - 1;
        if (end - start >= 15 && ruleAt(x, start) && ruleAt(x, end)) verticals.push({ x, y0: start, y1: end });
        start = -1;
      }
    }
  }
  // Merge adjacent columns of the same line.
  const vlines: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const v of verticals) {
    const line = vlines.find((l) => v.x - l.x1 <= 1 && Math.abs(v.y0 - l.y0) <= JOIN && Math.abs(v.y1 - l.y1) <= JOIN);
    if (line) line.x1 = v.x;
    else vlines.push({ x0: v.x, x1: v.x, y0: v.y0, y1: v.y1 });
  }
  const borders = vlines.filter((l) => l.x1 - l.x0 + 1 <= MAX_THICKNESS);

  // ---- split each vertical rule at the horizontal rules crossing it: one piece per row band
  const pieces: { x0: number; x1: number; top: HLine; bottom: HLine }[] = [];
  for (const v of borders) {
    const x = (v.x0 + v.x1) / 2;
    const crossing = rules
      .filter((l) => x >= l.x0 - JOIN && x <= l.x1 + JOIN && l.y0 >= v.y0 - JOIN && l.y1 <= v.y1 + JOIN)
      .sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < crossing.length; i++) pieces.push({ x0: v.x0, x1: v.x1, top: crossing[i - 1]!, bottom: crossing[i]! });
  }

  // ---- cells: neighbouring pieces in the same row band
  const cells: PixelBox[] = [];
  const bands = new Map<string, typeof pieces>();
  for (const p of pieces) {
    const key = `${p.top.y0}:${p.bottom.y0}`;
    bands.set(key, [...(bands.get(key) ?? []), p]);
  }
  for (const band of bands.values()) {
    band.sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < band.length; i++) {
      const left = band[i - 1]!;
      const right = band[i]!;
      const cell = { x0: left.x1 + 1, y0: left.top.y1 + 1, x1: right.x0 - 1, y1: left.bottom.y0 - 1 };
      if (cell.x1 - cell.x0 >= 20 && cell.y1 - cell.y0 >= 15) cells.push(cell);
    }
  }
  return cells;
}
