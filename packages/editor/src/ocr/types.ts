import type { Rect } from '../types';

/** A page rendered for recognition: grayscale RGBA pixels (y down). */
export interface Raster {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** A pixel rectangle in a raster (y down). */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RecognizedWord {
  text: string;
  /** 0–100. */
  confidence: number;
  box: PixelBox;
  /** Baseline y in raster pixels. */
  baseline: number;
  /** Line height in raster pixels (Tesseract's row height), to size the text. */
  lineHeight: number;
  /** Index of the line within the page, in reading order. */
  line: number;
  /** Came from re-reading a table cell on its own. */
  fromCell?: boolean;
}

/**
 * A recognized word placed on the original (possibly skewed) raster: its
 * baseline from left to right end, and the direction "up" from it.
 */
export interface PlacedWord extends RecognizedWord {
  start: [number, number];
  end: [number, number];
  /** Unit vector pointing up from the baseline, in raster pixels (y down, so usually `[0, -1]`). */
  up: [number, number];
  /** Font size of the word's line, in pixels, from the height of its ink. */
  size: number;
  /** Thicker strokes than the page's text of the same size. */
  bold: boolean;
  /** CSS hex colour of the ink. */
  color: string;
}

/** Recognized text of a page, in PDF user space. */
export interface OcrWord {
  text: string;
  confidence: number;
  box: Rect;
  baseline: number;
  /** Estimated font size in points. */
  size: number;
  line: number;
  bold: boolean;
  color: string;
}

export interface OcrPage {
  pageIndex: number;
  words: OcrWord[];
  /** Mean word confidence, 0–100. */
  confidence: number;
  /** Table cells found and re-read separately. */
  cells: number;
  durationMs: number;
}
