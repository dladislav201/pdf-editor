import type { PageGeometry } from '../engine/page-geometry';
import type { Point } from '../types';
import type { OcrWord, PlacedWord } from './types';

/**
 * A word of the invisible text layer, in PDF user space: drawn from `origin`
 * along `run` (its full width on the page) with glyphs `size` points tall in
 * the `up` direction (a unit vector).
 */
export interface InvisibleWord {
  text: string;
  /** The size the text appears in on the scan, so it can be edited as such. */
  size: number;
  bold: boolean;
  color: string;
  origin: Point;
  run: Point;
  up: Point;
}

/**
 * Maps words recognized on a page raster rendered with `geometry` (same
 * page, at the raster's scale) into PDF user space: the words a caller gets,
 * and the layer the engine writes under the scan.
 */
export function placeWords(words: PlacedWord[], geometry: PageGeometry): { words: OcrWord[]; layer: InvisibleWord[] } {
  const out: OcrWord[] = [];
  const layer: InvisibleWord[] = [];
  for (const word of words) {
    const origin = geometry.toPdf(word.start);
    const end = geometry.toPdf(word.end);
    const top = geometry.toPdf([word.start[0] + word.up[0], word.start[1] + word.up[1]]);
    const up: Point = [top[0] - origin[0], top[1] - origin[1]];
    const length = Math.hypot(...up) || 1;
    const size = word.size / geometry.scale;
    const [x0, y0] = geometry.toPdf([word.box.x0, word.box.y1]);
    const [x1, y1] = geometry.toPdf([word.box.x1, word.box.y0]);
    out.push({
      text: word.text,
      confidence: word.confidence,
      box: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) },
      baseline: origin[1],
      size,
      line: word.line,
      bold: word.bold,
      color: word.color,
    });
    layer.push({
      text: word.text,
      size,
      bold: word.bold,
      color: word.color,
      origin,
      run: [end[0] - origin[0], end[1] - origin[1]],
      up: [up[0] / length, up[1] / length],
    });
  }
  return { words: out, layer };
}
