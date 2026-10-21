import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { RawPageText, TextFont } from '../text/types';

// fpdf_edit.h
const FPDF_PAGEOBJ_TEXT = 1;
const RENDER_INVISIBLE = 3;
const RENDER_CLIP = 7;

interface Heaps {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
}
const heaps = (lib: WrappedPdfiumModule) => lib.pdfium as unknown as Heaps;

function readString(lib: WrappedPdfiumModule, getter: (ptr: number, len: number) => number): string {
  const length = getter(0, 0);
  if (length <= 1) return '';
  const ptr = lib.pdfium.wasmExports.malloc(length);
  try {
    getter(ptr, length);
    return lib.pdfium.UTF8ToString(ptr);
  } finally {
    lib.pdfium.wasmExports.free(ptr);
  }
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function fontInfo(lib: WrappedPdfiumModule, font: number, scratch: number): TextFont {
  const name = readString(lib, (ptr, len) => lib.FPDFFont_GetBaseFontName(font, ptr, len));
  const family = readString(lib, (ptr, len) => lib.FPDFFont_GetFamilyName(font, ptr, len));
  const italicAngle = lib.FPDFFont_GetItalicAngle(font, scratch) ? (heaps(lib).HEAPU32[scratch >> 2]! | 0) : 0;
  const embedded = lib.FPDFFont_GetIsEmbedded(font) === 1;
  return {
    id: font,
    name,
    family: family || name.replace(/^[A-Z]{6}\+/, ''),
    weight: lib.FPDFFont_GetWeight(font) || (/bold|black|heavy|semibold|demi/i.test(name) ? 700 : 400),
    italic: italicAngle !== 0 || /italic|oblique/i.test(name),
    embedded,
    subset: embedded && /^[A-Z]{6}\+/.test(name),
  };
}

/**
 * Every glyph of a page with its position, size, color, font and owning page
 * object. Generated characters (spaces and line breaks PDFium infers) are left
 * out: layout analysis derives words and lines from geometry.
 */
export function extractPageText(lib: WrappedPdfiumModule, page: number, pageIndex: number): RawPageText {
  const { wasmExports } = lib.pdfium;
  const objectIndex = new Map<number, number>();
  const objectCount = lib.FPDFPage_CountObjects(page);
  for (let i = 0; i < objectCount; i++) {
    const object = lib.FPDFPage_GetObject(page, i);
    if (lib.FPDFPageObj_GetType(object) === FPDF_PAGEOBJ_TEXT) objectIndex.set(object, i);
  }

  const textPage = lib.FPDFText_LoadPage(page);
  // 64 bytes of scratch: doubles at 0/8, a FS_RECTF at 16, a FS_MATRIX at 32, RGBA at 56.
  const scratch = wasmExports.malloc(80);
  const fonts: RawPageText['fonts'] = {};
  const chars: RawPageText['chars'] = [];
  const renderModes = new Map<number, number>();
  try {
    const count = lib.FPDFText_CountChars(textPage);
    for (let i = 0; i < count; i++) {
      if (lib.FPDFText_IsGenerated(textPage, i) === 1) continue;
      const code = lib.FPDFText_GetUnicode(textPage, i);
      if (code === 0 || code === 0x0d || code === 0x0a || code === 0xfffe) continue;
      const object = lib.FPDFText_GetTextObject(textPage, i);
      if (!object) continue;

      const font = lib.FPDFTextObj_GetFont(object);
      if (font && !fonts[font]) fonts[font] = fontInfo(lib, font, scratch);
      let mode = renderModes.get(object);
      if (mode === undefined) {
        mode = lib.FPDFTextObj_GetTextRenderMode(object);
        renderModes.set(object, mode);
      }

      lib.FPDFText_GetCharOrigin(textPage, i, scratch, scratch + 8);
      lib.FPDFText_GetLooseCharBox(textPage, i, scratch + 16);
      lib.FPDFText_GetMatrix(textPage, i, scratch + 32);
      lib.FPDFText_GetFillColor(textPage, i, scratch + 56, scratch + 60, scratch + 64, scratch + 68);
      // Read the views after the calls: none allocate, but stay safe if that changes.
      const { HEAPF64, HEAPF32, HEAPU32 } = heaps(lib);
      const x = HEAPF64[scratch >> 3]!;
      const y = HEAPF64[(scratch >> 3) + 1]!;
      const [left, top, right, bottom] = HEAPF32.subarray((scratch + 16) >> 2, ((scratch + 16) >> 2) + 4) as unknown as number[];
      const c = HEAPF32[((scratch + 32) >> 2) + 2]!;
      const d = HEAPF32[((scratch + 32) >> 2) + 3]!;
      const [r, g, b] = HEAPU32.subarray((scratch + 56) >> 2, ((scratch + 56) >> 2) + 3) as unknown as number[];

      // PDFium reports a hyphen that ends a line as U+0002; the page draws a plain hyphen.
      const hyphen = lib.FPDFText_IsHyphen(textPage, i) === 1;
      const text = hyphen ? '-' : String.fromCodePoint(code);
      chars.push({
        text,
        x,
        y,
        box: {
          x: Math.min(left!, right!),
          y: Math.min(top!, bottom!),
          width: Math.abs(right! - left!),
          height: Math.abs(top! - bottom!),
        },
        // GetFontSize is the font size of the text object; the matrix scales it to what is seen.
        size: lib.FPDFText_GetFontSize(textPage, i) * Math.hypot(c, d),
        font,
        color: hex(r!, g!, b!),
        object: objectIndex.get(object) ?? -1,
        isSpace: /\s/.test(text),
        lineEndHyphen: hyphen,
        angle: lib.FPDFText_GetCharAngle(textPage, i),
        unmapped: lib.FPDFText_HasUnicodeMapError(textPage, i) === 1,
        invisible: mode === RENDER_INVISIBLE || mode === RENDER_CLIP,
      });
    }
  } finally {
    wasmExports.free(scratch);
    lib.FPDFText_ClosePage(textPage);
  }
  return { pageIndex, fonts, chars };
}
