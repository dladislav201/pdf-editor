import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { RawPageText } from '../text/types';
import type { Rotation } from './page-geometry';
import { extractPageText } from './pdfium-text';

/** Plain data about one page, safe to post between threads. */
export interface PageInfo {
  /** Visible box (crop box clipped to the media box) in user space: `[x0, y0, x1, y1]`. */
  box: [number, number, number, number];
  rotation: Rotation;
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

  /** Renders the page (with its annotations' appearances) to RGBA pixels. */
  render(index: number, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    const page = this.page(index);
    const lib = this.lib;
    const bitmap = lib.FPDFBitmap_Create(width, height, 1);
    if (!bitmap) throw new EngineError('EngineError', 'Not enough memory to render the page.');
    try {
      lib.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      lib.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
      const ptr = lib.FPDFBitmap_GetBuffer(bitmap);
      // Copy out of the WASM heap: the heap may grow (and move) on the next call.
      return new Uint8ClampedArray(heapU8(lib).slice(ptr, ptr + width * height * 4).buffer);
    } finally {
      lib.FPDFBitmap_Destroy(bitmap);
    }
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
