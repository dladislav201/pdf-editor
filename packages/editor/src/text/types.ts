import type { Rect } from '../types';

/**
 * Text model of a page. Everything is in PDF user space (points, y up), like
 * annotations. Plain data: it is built in the engine worker and posted over.
 */

export interface TextFont {
  /** Engine handle; stable while the document is open, used to group runs. */
  id: number;
  /** PostScript name, e.g. `CAAAAA+ArialMT` (the prefix marks a subset). */
  name: string;
  family: string;
  /** 100–900. */
  weight: number;
  italic: boolean;
  embedded: boolean;
  /** Embedded fonts with a `XXXXXX+` prefix contain only the glyphs the file uses. */
  subset: boolean;
  /** Has serifs (from the PDF font flags or the name), to pick a matching fallback font. */
  serif: boolean;
  monospace: boolean;
}

/** One glyph as drawn on the page (generated spaces/line breaks are not glyphs). */
export interface TextChar {
  /** The character (may be more than one UTF-16 unit). */
  text: string;
  /** Baseline origin. */
  x: number;
  y: number;
  /** Box from the font's ascent/descent, same height for every glyph of a font and size. */
  box: Rect;
  /** Visible font size in points (font size × text matrix scale). */
  size: number;
  font: number;
  /** CSS hex color of the fill. */
  color: string;
  /** Index of the page object that draws this glyph; -1 when it sits inside a form XObject. */
  object: number;
  /** A real space glyph (not one inferred from a gap). */
  isSpace: boolean;
  /** A hyphen at the end of a line, possibly inserted by hyphenation. */
  lineEndHyphen: boolean;
  /** For text that runs at an angle: the glyph's box in its line's straightened frame (see `TextLine.rotation`). */
  straight?: Rect;
  /**
   * The glyph's ink, for invisible (recognized) text only: there the glyph is
   * stretched over a word of the scan, so its ink box is where the scan's ink is.
   */
  ink?: Rect;
}

/** Consecutive glyphs of a line that share font, size and color. */
export interface TextRun {
  text: string;
  font: number;
  size: number;
  color: string;
  /** Index range into the line's `chars`, end exclusive. */
  start: number;
  end: number;
}

export interface TextLine {
  /** Glyphs left to right, without space glyphs. */
  chars: TextChar[];
  /** Line text with word gaps as single spaces. */
  text: string;
  runs: TextRun[];
  /** Index into `chars` where each word starts. */
  wordStarts: number[];
  /** Page objects that draw only (invisible) space glyphs on this line, with their x. */
  spaceObjects: { object: number; x: number }[];
  baseline: number;
  /** Ends with a hyphen that may come from hyphenation (rejoining the word may drop it). */
  hyphenated: boolean;
  /** Dominant visible font size. */
  size: number;
  box: Rect;
  /**
   * Text that runs at an angle (a label up the side of a table, a page turned
   * in its content): its direction, counterclockwise from the x axis in
   * radians, and its box in the frame turned back by it (about the origin),
   * where its glyphs' `straight` boxes are. `box` is then the bounding box.
   */
  rotation?: { angle: number; box: Rect };
}

export type TextAlign = 'left' | 'right' | 'center' | 'justify';

export interface TextParagraph {
  /** `p<page>-<n>`, stable for an unchanged page. */
  id: string;
  pageIndex: number;
  lines: TextLine[];
  /** Lines joined with spaces (a hyphen at a line end joins without one). */
  text: string;
  box: Rect;
  align: TextAlign;
  /** Baseline-to-baseline distance; the dominant size × 1.2 for single lines. */
  leading: number;
  /** How far the first line starts right of the others (0 when not indented). */
  indent: number;
  /** False when some glyphs can't be rewritten yet; `reason` says why. */
  editable: boolean;
  reason?: string;
  /**
   * Invisible text recognized from a scan (an OCR layer). Editing it writes
   * the paragraph as visible text and erases its words from the scan.
   */
  recognized?: boolean;
}

/** A page object that isn't text (a path, picture, shading or form XObject) and where it is. */
export interface PageGraphic {
  object: number;
  box: Rect;
}

/** A page object shifted by an offset in user space. */
export interface ObjectMove {
  object: number;
  dx: number;
  dy: number;
}

export interface PageText {
  pageIndex: number;
  fonts: Record<number, TextFont>;
  paragraphs: TextParagraph[];
  /** Left and right edges of the page's main text block (where most lines start and end). */
  block: { left: number; right: number };
  /** Everything on the page that isn't text: what moves with text pushed down by a growing paragraph. */
  graphics: PageGraphic[];
}

/** What the engine extracts per page before layout analysis. */
export interface RawPageText {
  pageIndex: number;
  fonts: Record<number, TextFont>;
  chars: (TextChar & { angle: number; unmapped: boolean; invisible: boolean })[];
  graphics: PageGraphic[];
}
