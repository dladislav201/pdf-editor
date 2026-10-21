import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

/** Outline and advance of one character in a document font, in ems (y up). */
export interface Glyph {
  advance: number;
  /** SVG path data in ems, y up; empty for blank glyphs such as space. */
  path: string;
}

export interface FontGlyphs {
  font: number;
  /** Ems above and below the baseline (descent is negative). */
  ascent: number;
  descent: number;
  /** `null` where the font has no glyph for the character (subset fonts often don't). */
  glyphs: Record<string, Glyph | null>;
}

// fpdf_edit.h
const SEGMENT_LINETO = 0;
const SEGMENT_BEZIERTO = 1;
const SEGMENT_MOVETO = 2;
/** A private-use character no real font maps: its outline is the font's "missing glyph". */
const NEVER_MAPPED = 0xe8f7;
const SIZE = 1000;

const heapF32 = (lib: WrappedPdfiumModule) => (lib.pdfium as unknown as { HEAPF32: Float32Array }).HEAPF32;

function readFloat(lib: WrappedPdfiumModule, scratch: number, call: (ptr: number) => boolean): number | null {
  return call(scratch) ? heapF32(lib)[scratch >> 2]! : null;
}

function outline(lib: WrappedPdfiumModule, font: number, code: number, scratch: number): string | null {
  const path = lib.FPDFFont_GetGlyphPath(font, code, SIZE);
  if (!path) return null;
  const parts: string[] = [];
  const count = lib.FPDFGlyphPath_CountGlyphSegments(path);
  const n = (v: number) => (Math.round(v * 10000) / 10000).toString();
  let bezier: string[] = [];
  for (let i = 0; i < count; i++) {
    const segment = lib.FPDFGlyphPath_GetGlyphPathSegment(path, i);
    lib.FPDFPathSegment_GetPoint(segment, scratch, scratch + 4);
    const heap = heapF32(lib);
    const point = `${n(heap[scratch >> 2]!)} ${n(heap[(scratch >> 2) + 1]!)}`;
    const type = lib.FPDFPathSegment_GetType(segment);
    if (type === SEGMENT_MOVETO) parts.push(`M${point}`);
    else if (type === SEGMENT_LINETO) parts.push(`L${point}`);
    else if (type === SEGMENT_BEZIERTO) {
      // PDFium lists a cubic as three consecutive points: two controls, then the end.
      bezier.push(point);
      if (bezier.length === 3) {
        parts.push(`C${bezier.join(' ')}`);
        bezier = [];
      }
    }
    if (lib.FPDFPathSegment_GetClose(segment)) parts.push('Z');
  }
  return parts.join('');
}

/**
 * Advances and outlines for characters in a document font. PDFium happily
 * returns the ".notdef" box for characters a subset font lacks, so a glyph
 * counts as missing when its outline equals that box, its advance is zero, or
 * a visible character has no outline at all.
 */
export function fontGlyphs(lib: WrappedPdfiumModule, font: number, chars: string[]): FontGlyphs {
  const scratch = lib.pdfium.wasmExports.malloc(16);
  try {
    const ascent = readFloat(lib, scratch, (p) => lib.FPDFFont_GetAscent(font, SIZE, p)) ?? 800;
    const descent = readFloat(lib, scratch, (p) => lib.FPDFFont_GetDescent(font, SIZE, p)) ?? -200;
    const missing = outline(lib, font, NEVER_MAPPED, scratch);
    const glyphs: FontGlyphs['glyphs'] = {};
    for (const char of chars) {
      const code = char.codePointAt(0)!;
      const advance = readFloat(lib, scratch, (p) => lib.FPDFFont_GetGlyphWidth(font, code, SIZE, p));
      const path = outline(lib, font, code, scratch) ?? '';
      const blank = /\s/.test(char);
      const absent = advance === null || advance <= 0 || (!blank && (!path || path === missing));
      glyphs[char] = absent ? null : { advance: advance / SIZE, path: blank ? '' : path };
    }
    return { font, ascent: ascent / SIZE, descent: descent / SIZE, glyphs };
  } finally {
    lib.pdfium.wasmExports.free(scratch);
  }
}
