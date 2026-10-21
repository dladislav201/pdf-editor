import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { InvisibleWord } from '../ocr/place';
import type { RawPageText } from '../text/types';
import type { TextWritePlan } from '../text/write-plan';
import type { Rotation } from './page-geometry';
import { fontGlyphs, type FontGlyphs } from './pdfium-glyphs';
import { extractPageText } from './pdfium-text';

/** Plain data about one page, safe to post between threads. */
export interface PageInfo {
  /** Visible box (crop box clipped to the media box) in user space: `[x0, y0, x1, y1]`. */
  box: [number, number, number, number];
  rotation: Rotation;
}

/** What a page is made of, to tell scans from born-digital pages. */
export interface ScanInfo {
  /** Mostly one big picture and (almost) no visible text: a scan or a photo. */
  scanned: boolean;
  /** Has invisible text: a recognized (OCR) layer is already there. */
  recognized: boolean;
  /** Resolution of the biggest picture on the page, in pixels per inch (0 without one). */
  dpi: number;
}

/** Errors keep a stable `name`, so callers can tell "password" from "not a PDF" across the worker boundary. */
export class EngineError extends Error {
  constructor(name: 'PasswordException' | 'InvalidPDFException' | 'EngineError', message: string) {
    super(message);
    this.name = name;
  }
}

// fpdfview.h
const FPDF_ERR_FILE = 2;
const FPDF_ERR_FORMAT = 3;
const FPDF_ERR_PASSWORD = 4;
const FPDF_ERR_SECURITY = 5;
const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
// fpdf_edit.h
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_FONT_TRUETYPE = 2;
const RENDER_INVISIBLE = 3;
/** A picture covering this much of the page, with fewer visible characters than below, makes a scan. */
const SCAN_COVER = 0.5;
const SCAN_MAX_CHARS = 20;
/** Pages kept parsed; parsing is the expensive part of re-rendering at a new zoom. */
const PAGE_CACHE_SIZE = 8;

/**
 * Typed views of the WASM heap. Read them fresh after every allocation: when
 * memory grows the old views are detached and silently read zeros.
 */
function heapU8(lib: WrappedPdfiumModule): Uint8Array {
  return (lib.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}
function heapF32(lib: WrappedPdfiumModule): Float32Array {
  return (lib.pdfium as unknown as { HEAPF32: Float32Array }).HEAPF32;
}

function parseColor(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function loadError(code: number): EngineError {
  if (code === FPDF_ERR_PASSWORD || code === FPDF_ERR_SECURITY) {
    return new EngineError('PasswordException', 'This PDF is password-protected.');
  }
  if (code === FPDF_ERR_FORMAT || code === FPDF_ERR_FILE) {
    return new EngineError('InvalidPDFException', 'This file is not a valid PDF.');
  }
  return new EngineError('EngineError', `Could not open the PDF (PDFium error ${code}).`);
}

/**
 * One open document. Owns the WASM copy of the file bytes and every native
 * handle; nothing here touches the DOM, so it runs in a worker and in Node.
 */
export class PdfiumDocument {
  readonly pageCount: number;
  private readonly handle: number;
  private readonly dataPtr: number;
  private readonly pages = new Map<number, number>();
  private closed = false;

  constructor(
    private readonly lib: WrappedPdfiumModule,
    bytes: Uint8Array,
  ) {
    const { wasmExports } = lib.pdfium;
    this.dataPtr = wasmExports.malloc(bytes.length);
    if (!this.dataPtr) throw new EngineError('EngineError', 'Not enough memory to open the PDF.');
    heapU8(lib).set(bytes, this.dataPtr);
    this.handle = lib.FPDF_LoadMemDocument(this.dataPtr, bytes.length, '');
    if (!this.handle) {
      const error = loadError(lib.FPDF_GetLastError());
      wasmExports.free(this.dataPtr);
      throw error;
    }
    this.pageCount = lib.FPDF_GetPageCount(this.handle);
  }

  private page(index: number): number {
    if (this.closed) throw new EngineError('EngineError', 'The document is closed.');
    const cached = this.pages.get(index);
    if (cached) {
      // Re-insert to mark as most recently used.
      this.pages.delete(index);
      this.pages.set(index, cached);
      return cached;
    }
    const page = this.lib.FPDF_LoadPage(this.handle, index);
    if (!page) throw new EngineError('EngineError', `Could not load page ${index + 1}.`);
    this.pages.set(index, page);
    if (this.pages.size > PAGE_CACHE_SIZE) {
      const [oldestIndex, oldest] = this.pages.entries().next().value as [number, number];
      this.lib.FPDF_ClosePage(oldest);
      this.pages.delete(oldestIndex);
    }
    return page;
  }

  pageInfo(index: number): PageInfo {
    const page = this.page(index);
    const { wasmExports } = this.lib.pdfium;
    const ptr = wasmExports.malloc(16);
    try {
      // FS_RECTF is { left, top, right, bottom }.
      this.lib.FPDF_GetPageBoundingBox(page, ptr);
      const [left, top, right, bottom] = heapF32(this.lib).subarray(ptr >> 2, (ptr >> 2) + 4);
      const rotation = (((this.lib.FPDFPage_GetRotation(page) % 4) + 4) % 4) * 90;
      return {
        box: [Math.min(left!, right!), Math.min(top!, bottom!), Math.max(left!, right!), Math.max(top!, bottom!)],
        rotation: rotation as Rotation,
      };
    } finally {
      wasmExports.free(ptr);
    }
  }

  /**
   * Renders the page (with its annotations' appearances) to RGBA pixels.
   * `hidden` page objects are left out, e.g. the text of a paragraph being edited.
   */
  render(index: number, width: number, height: number, hidden: number[] = [], annotations = true): Uint8ClampedArray<ArrayBuffer> {
    const page = this.page(index);
    const lib = this.lib;
    const inactive = hidden.map((i) => lib.FPDFPage_GetObject(page, i)).filter(Boolean);
    for (const object of inactive) lib.FPDFPageObj_SetIsActive(object, false);
    const bitmap = lib.FPDFBitmap_Create(width, height, 1);
    if (!bitmap) throw new EngineError('EngineError', 'Not enough memory to render the page.');
    try {
      lib.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      lib.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, (annotations ? FPDF_ANNOT : 0) | FPDF_REVERSE_BYTE_ORDER);
      const ptr = lib.FPDFBitmap_GetBuffer(bitmap);
      // Copy out of the WASM heap: the heap may grow (and move) on the next call.
      return new Uint8ClampedArray(heapU8(lib).slice(ptr, ptr + width * height * 4).buffer);
    } finally {
      lib.FPDFBitmap_Destroy(bitmap);
      for (const object of inactive) lib.FPDFPageObj_SetIsActive(object, true);
    }
  }

  /**
   * Rewrites paragraphs on their pages: drops the objects a plan removes,
   * moves the glyph objects it keeps and adds new words in document fonts or,
   * for characters those lack, in fallback fonts (`fallbackFonts`: TrueType
   * bytes by fallback id, ideally already subset), then regenerates the page
   * content.
   */
  applyTextPlans(plans: TextWritePlan[], fallbackFonts: Record<number, Uint8Array> = {}): void {
    const lib = this.lib;
    const { wasmExports } = lib.pdfium;
    const loadedFallbacks = new Map<number, number>();
    const fallbackFont = (id: number): number => {
      let font = loadedFallbacks.get(id);
      if (font === undefined) {
        const bytes = fallbackFonts[id];
        if (!bytes) throw new EngineError('EngineError', 'A fallback font needed for edited text is missing.');
        const ptr = wasmExports.malloc(bytes.length);
        try {
          heapU8(lib).set(bytes, ptr);
          // As a CID font, so any Unicode text maps through the font's own cmap.
          font = lib.FPDFText_LoadFont(this.handle, ptr, bytes.length, FPDF_FONT_TRUETYPE, true);
        } finally {
          wasmExports.free(ptr);
        }
        if (!font) throw new EngineError('EngineError', 'Could not embed a fallback font.');
        loadedFallbacks.set(id, font);
      }
      return font;
    };
    const touched = new Set<number>();
    // Resolve every index of every plan before changing anything: removing and
    // inserting objects shifts the indices the next plan on the same page refers to.
    const resolved = plans.map((plan) => {
      const page = this.page(plan.page);
      const handle = (index: number) => {
        const object = lib.FPDFPage_GetObject(page, index);
        if (!object) throw new EngineError('EngineError', `Page ${plan.page + 1} has no object ${index}.`);
        return object;
      };
      return {
        plan,
        page,
        removed: plan.remove.map(handle),
        moved: plan.moves.map((move) => ({ ...move, object: handle(move.object) })),
        words: [
          ...plan.words.map((word) => ({ ...word, font: lib.FPDFTextObj_GetFont(handle(word.fontObject)) })),
          ...plan.fallback.map((word) => ({ ...word, font: fallbackFont(word.font) })),
        ],
      };
    });
    for (const { plan, page, removed, moved, words } of resolved) {
      for (const move of moved) lib.FPDFPageObj_Transform(move.object, 1, 0, 0, 1, move.dx, move.dy);
      words.forEach((word) => {
        const object = lib.FPDFPageObj_CreateTextObj(this.handle, word.font, word.size);
        if (!object) throw new EngineError('EngineError', 'Could not create a text object.');
        const bytes = (word.text.length + 1) * 2;
        const text = wasmExports.malloc(bytes);
        const matrix = wasmExports.malloc(24);
        try {
          lib.pdfium.stringToUTF16(word.text, text, bytes);
          lib.FPDFText_SetText(object, text);
          heapF32(lib).set([1, 0, 0, 1, word.x, word.y], matrix >> 2);
          lib.FPDFPageObj_SetMatrix(object, matrix);
        } finally {
          wasmExports.free(text);
          wasmExports.free(matrix);
        }
        lib.FPDFPageObj_SetFillColor(object, ...parseColor(word.color), 255);
        lib.FPDFPage_InsertObject(page, object);
      });
      for (const object of removed) {
        lib.FPDFPage_RemoveObject(page, object);
        lib.FPDFPageObj_Destroy(object);
      }
      touched.add(plan.page);
    }
    for (const index of touched) {
      if (!lib.FPDFPage_GenerateContent(this.page(index))) {
        throw new EngineError('EngineError', `Could not write page ${index + 1}.`);
      }
    }
    // The text objects keep their own references to the fonts.
    for (const font of loadedFallbacks.values()) lib.FPDFFont_Close(font);
  }

  /** Whether a page is a scan (one big picture, no real text) and whether it already has an OCR layer. */
  scanInfo(index: number): ScanInfo {
    const page = this.page(index);
    const lib = this.lib;
    const { wasmExports } = lib.pdfium;
    const [x0, y0, x1, y1] = this.pageInfo(index).box;
    const pageArea = (x1 - x0) * (y1 - y0);
    let cover = 0;
    let dpi = 0;
    const scratch = wasmExports.malloc(16);
    try {
      const count = lib.FPDFPage_CountObjects(page);
      for (let i = 0; i < count; i++) {
        const object = lib.FPDFPage_GetObject(page, i);
        if (lib.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) continue;
        if (!lib.FPDFPageObj_GetBounds(object, scratch, scratch + 4, scratch + 8, scratch + 12)) continue;
        const [left, bottom, right, top] = heapF32(lib).subarray(scratch >> 2, (scratch >> 2) + 4) as unknown as number[];
        const width = Math.min(right!, x1) - Math.max(left!, x0);
        const height = Math.min(top!, y1) - Math.max(bottom!, y0);
        if (width <= 0 || height <= 0) continue;
        const share = (width * height) / pageArea;
        if (share <= cover) continue;
        cover = share;
        if (lib.FPDFImageObj_GetImagePixelSize(object, scratch, scratch + 4)) {
          const pixels = new Uint32Array(heapU8(lib).buffer, scratch, 1)[0]!;
          dpi = Math.round(pixels / ((right! - left!) / 72));
        }
      }
    } finally {
      wasmExports.free(scratch);
    }
    const { chars } = this.extractText(index);
    const visible = chars.filter((c) => !c.invisible && !c.isSpace).length;
    return { scanned: cover >= SCAN_COVER && visible < SCAN_MAX_CHARS, recognized: chars.some((c) => c.invisible), dpi };
  }

  /**
   * Adds recognized text under the page images as invisible text (render
   * mode 3), the way OCR software makes scans searchable and selectable. Each
   * word is stretched along its baseline to cover the word on the scan.
   * `font` is a TrueType font with every character used (ideally subset).
   */
  addInvisibleText(pages: { page: number; words: InvisibleWord[] }[], font: Uint8Array): void {
    const lib = this.lib;
    const { wasmExports } = lib.pdfium;
    const fontPtr = wasmExports.malloc(font.length);
    let handle: number;
    try {
      heapU8(lib).set(font, fontPtr);
      handle = lib.FPDFText_LoadFont(this.handle, fontPtr, font.length, FPDF_FONT_TRUETYPE, true);
    } finally {
      wasmExports.free(fontPtr);
    }
    if (!handle) throw new EngineError('EngineError', 'Could not embed the font for recognized text.');
    const bounds = wasmExports.malloc(16);
    try {
      for (const { page: index, words } of pages) {
        const page = this.page(index);
        for (const word of words) {
          const object = lib.FPDFPageObj_CreateTextObj(this.handle, handle, word.size);
          if (!object) throw new EngineError('EngineError', 'Could not create a text object.');
          const bytes = (word.text.length + 1) * 2;
          const text = wasmExports.malloc(bytes);
          try {
            lib.pdfium.stringToUTF16(word.text, text, bytes);
            lib.FPDFText_SetText(object, text);
          } finally {
            wasmExports.free(text);
          }
          lib.FPDFTextObj_SetTextRenderMode(object, RENDER_INVISIBLE);
          // Natural width at the identity matrix, then stretch it to the word on the scan.
          lib.FPDFPageObj_GetBounds(object, bounds, bounds + 4, bounds + 8, bounds + 12);
          const [left, , right] = heapF32(lib).subarray(bounds >> 2, (bounds >> 2) + 4) as unknown as number[];
          const natural = Math.max(right! - left!, 0.01);
          const matrix = wasmExports.malloc(24);
          try {
            const [rx, ry] = word.run;
            const [ux, uy] = word.up;
            heapF32(lib).set([rx / natural, ry / natural, ux, uy, word.origin[0], word.origin[1]], matrix >> 2);
            lib.FPDFPageObj_SetMatrix(object, matrix);
          } finally {
            wasmExports.free(matrix);
          }
          lib.FPDFPage_InsertObject(page, object);
        }
        if (!lib.FPDFPage_GenerateContent(page)) throw new EngineError('EngineError', `Could not write page ${index + 1}.`);
      }
    } finally {
      wasmExports.free(bounds);
      lib.FPDFFont_Close(handle);
    }
  }

  /** The document as a PDF file, including changes made through the engine. */
  save(): Uint8Array {
    const lib = this.lib;
    const writer = lib.PDFiumExt_OpenFileWriter();
    try {
      if (!lib.PDFiumExt_SaveAsCopy(this.handle, writer)) throw new EngineError('EngineError', 'Could not save the PDF.');
      const size = lib.PDFiumExt_GetFileWriterSize(writer);
      const ptr = lib.pdfium.wasmExports.malloc(size);
      try {
        lib.PDFiumExt_GetFileWriterData(writer, ptr, size);
        return heapU8(lib).slice(ptr, ptr + size);
      } finally {
        lib.pdfium.wasmExports.free(ptr);
      }
    } finally {
      lib.PDFiumExt_CloseFileWriter(writer);
    }
  }

  /** Glyphs of the font used by a text object, for the given characters. */
  glyphs(pageIndex: number, objectIndex: number, chars: string[]): FontGlyphs {
    const object = this.lib.FPDFPage_GetObject(this.page(pageIndex), objectIndex);
    const font = object ? this.lib.FPDFTextObj_GetFont(object) : 0;
    if (!font) throw new EngineError('EngineError', `Page object ${objectIndex} has no font.`);
    return fontGlyphs(this.lib, font, chars);
  }

  /** Every glyph of the page, for layout analysis. */
  extractText(index: number): RawPageText {
    return extractPageText(this.lib, this.page(index), index);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pages.values()) this.lib.FPDF_ClosePage(page);
    this.pages.clear();
    this.lib.FPDF_CloseDocument(this.handle);
    this.lib.pdfium.wasmExports.free(this.dataPtr);
  }
}

export function initLibrary(lib: WrappedPdfiumModule): WrappedPdfiumModule {
  lib.PDFiumExt_Init();
  return lib;
}
