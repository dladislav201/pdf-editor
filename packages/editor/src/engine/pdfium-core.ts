import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { eraseInk } from '../ocr/erase';
import type { InvisibleWord } from '../ocr/place';
import type { Raster } from '../ocr/types';
import type { ScanErase } from '../text/scan-edit';
import type { Point } from '../types';
import type { RawPageText } from '../text/types';
import type { TextWritePlan } from '../text/write-plan';
import { PageGeometry, type Rotation } from './page-geometry';
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

/**
 * A cleaned piece of a scan and where it goes on the page: its bottom-left
 * corner and the page vectors its bottom and left edges run along.
 */
export interface ScanPatch {
  image: Raster;
  /** The same piece before erasing: what untouched words of an edited paragraph are copied back from. */
  original: Raster;
  origin: Point;
  xAxis: Point;
  yAxis: Point;
}

/** Encodes RGBA pixels (`width`×`height`) as a JPEG of `targetWidth`×`targetHeight` at `quality` (0–1). */
export type EncodeJpeg = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  quality: number,
) => Promise<Uint8Array>;

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
/** Fallback font ids of Arimo regular and bold (see text/glyph-store.ts). */
const FALLBACK_REGULAR = -1;
const FALLBACK_BOLD = -2;
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
   * A copy of the page area `erase.region` with the ink of `erase.words`
   * removed: what goes under an edited paragraph of a scan. Cut from the
   * scan's own pixels and placed exactly on them, so nothing but the erased
   * words changes; pages without a picture there are rendered instead.
   */
  scanPatch(index: number, erase: ScanErase): ScanPatch {
    return this.imagePatch(index, erase) ?? this.renderedPatch(index, erase);
  }

  /** The patch cut from the picture under the area (the scan), on its own pixel grid. */
  private imagePatch(index: number, erase: ScanErase): ScanPatch | null {
    const page = this.page(index);
    const lib = this.lib;
    const { wasmExports } = lib.pdfium;
    const { region } = erase;
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    const scratch = wasmExports.malloc(24);
    let best: { object: number; area: number; m: number[] } | null = null;
    try {
      const count = lib.FPDFPage_CountObjects(page);
      for (let i = 0; i < count; i++) {
        const object = lib.FPDFPage_GetObject(page, i);
        if (lib.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) continue;
        if (!lib.FPDFPageObj_GetBounds(object, scratch, scratch + 4, scratch + 8, scratch + 12)) continue;
        const [left, bottom, right, top] = [...heapF32(lib).subarray(scratch >> 2, (scratch >> 2) + 4)];
        if (cx < left! || cx > right! || cy < bottom! || cy > top!) continue;
        const area = (right! - left!) * (top! - bottom!);
        if (best && area <= best.area) continue;
        if (!lib.FPDFPageObj_GetMatrix(object, scratch)) continue;
        best = { object, area, m: [...heapF32(lib).subarray(scratch >> 2, (scratch >> 2) + 6)] };
      }
    } finally {
      wasmExports.free(scratch);
    }
    if (!best) return null;
    const [a, b, c, d, e, f] = best.m as [number, number, number, number, number, number];
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) return null;

    const bitmap = lib.FPDFImageObj_GetBitmap(best.object);
    if (!bitmap) return null;
    try {
      const format = lib.FPDFBitmap_GetFormat(bitmap);
      // fpdfview.h: 1 gray, 2 BGR, 3 BGRx, 4 BGRA.
      const bytesPerPixel = { 1: 1, 2: 3, 3: 4, 4: 4 }[format];
      if (!bytesPerPixel) return null;
      const W = lib.FPDFBitmap_GetWidth(bitmap);
      const H = lib.FPDFBitmap_GetHeight(bitmap);
      const stride = lib.FPDFBitmap_GetStride(bitmap);
      // User space → image pixels (the image is the unit square, its first row at the top).
      const toPixel = (x: number, y: number): [number, number] => {
        const u = (d * (x - e) - c * (y - f)) / det;
        const v = (-b * (x - e) + a * (y - f)) / det;
        return [u * W, (1 - v) * H];
      };
      const toUser = (px: number, py: number): Point => {
        const u = px / W;
        const v = 1 - py / H;
        return [a * u + c * v + e, b * u + d * v + f];
      };
      const boxOf = (r: { x: number; y: number; width: number; height: number }) => {
        const corners = [
          toPixel(r.x, r.y),
          toPixel(r.x + r.width, r.y),
          toPixel(r.x, r.y + r.height),
          toPixel(r.x + r.width, r.y + r.height),
        ];
        return {
          x0: Math.min(...corners.map((p) => p[0])),
          y0: Math.min(...corners.map((p) => p[1])),
          x1: Math.max(...corners.map((p) => p[0])),
          y1: Math.max(...corners.map((p) => p[1])),
        };
      };
      const area = boxOf(region);
      const px0 = Math.max(0, Math.floor(area.x0));
      const py0 = Math.max(0, Math.floor(area.y0));
      const px1 = Math.min(W, Math.ceil(area.x1));
      const py1 = Math.min(H, Math.ceil(area.y1));
      if (px1 <= px0 || py1 <= py0) return null;
      const width = px1 - px0;
      const height = py1 - py0;
      const source = lib.FPDFBitmap_GetBuffer(bitmap);
      const heap = heapU8(lib);
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = source + (py0 + y) * stride + (px0 + x) * bytesPerPixel;
          const to = (y * width + x) * 4;
          if (bytesPerPixel === 1) {
            rgba[to] = rgba[to + 1] = rgba[to + 2] = heap[from]!;
          } else {
            rgba[to] = heap[from + 2]!;
            rgba[to + 1] = heap[from + 1]!;
            rgba[to + 2] = heap[from]!;
          }
          rgba[to + 3] = 255;
        }
      }
      const pixelsPerPoint = W / Math.hypot(a, b);
      const original = { width, height, rgba: new Uint8ClampedArray(rgba) };
      const image = eraseInk(
        { width, height, rgba },
        erase.words.map((word) => {
          const box = boxOf(word);
          return { x0: box.x0 - px0, y0: box.y0 - py0, x1: box.x1 - px0, y1: box.y1 - py0 };
        }),
        erase.size * pixelsPerPoint,
      );
      const origin = toUser(px0, py1);
      const right = toUser(px1, py1);
      const top = toUser(px0, py0);
      return {
        image,
        original,
        origin,
        xAxis: [right[0] - origin[0], right[1] - origin[1]],
        yAxis: [top[0] - origin[0], top[1] - origin[1]],
      };
    } finally {
      lib.FPDFBitmap_Destroy(bitmap);
    }
  }

  /** The patch from the page as rendered at `erase.scale`, for areas without a picture under them. */
  private renderedPatch(index: number, erase: ScanErase): ScanPatch {
    const page = this.page(index);
    const lib = this.lib;
    const { wasmExports } = lib.pdfium;
    const info = this.pageInfo(index);
    const geometry = new PageGeometry(info.box, info.rotation, erase.scale);
    const toPixels = (r: { x: number; y: number; width: number; height: number }) => {
      const corners = [geometry.toViewport([r.x, r.y]), geometry.toViewport([r.x + r.width, r.y + r.height])];
      return {
        x0: Math.min(corners[0]![0], corners[1]![0]),
        y0: Math.min(corners[0]![1], corners[1]![1]),
        x1: Math.max(corners[0]![0], corners[1]![0]),
        y1: Math.max(corners[0]![1], corners[1]![1]),
      };
    };
    const area = toPixels(erase.region);
    const px0 = Math.max(0, Math.floor(area.x0));
    const py0 = Math.max(0, Math.floor(area.y0));
    const px1 = Math.min(Math.ceil(geometry.width), Math.ceil(area.x1));
    const py1 = Math.min(Math.ceil(geometry.height), Math.ceil(area.y1));
    const width = Math.max(1, px1 - px0);
    const height = Math.max(1, py1 - py0);

    const bitmap = lib.FPDFBitmap_Create(width, height, 1);
    if (!bitmap) throw new EngineError('EngineError', 'Not enough memory to render the page.');
    const matrix = wasmExports.malloc(24);
    const clip = wasmExports.malloc(16);
    let rgba: Uint8ClampedArray<ArrayBuffer>;
    try {
      lib.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      // The page at `scale`, shifted so the area's corner lands at the bitmap's origin.
      heapF32(lib).set([erase.scale, 0, 0, erase.scale, -px0, -py0], matrix >> 2);
      heapF32(lib).set([0, 0, width, height], clip >> 2);
      lib.FPDF_RenderPageBitmapWithMatrix(bitmap, page, matrix, clip, FPDF_REVERSE_BYTE_ORDER);
      const ptr = lib.FPDFBitmap_GetBuffer(bitmap);
      rgba = new Uint8ClampedArray(heapU8(lib).slice(ptr, ptr + width * height * 4).buffer);
    } finally {
      wasmExports.free(matrix);
      wasmExports.free(clip);
      lib.FPDFBitmap_Destroy(bitmap);
    }
    const original = { width, height, rgba: new Uint8ClampedArray(rgba) };
    const image = eraseInk(
      { width, height, rgba },
      erase.words.map((word) => {
        const box = toPixels(word);
        return { x0: box.x0 - px0, y0: box.y0 - py0, x1: box.x1 - px0, y1: box.y1 - py0 };
      }),
      erase.size * erase.scale,
    );
    const origin = geometry.toPdf([px0, py1]);
    const right = geometry.toPdf([px1, py1]);
    const top = geometry.toPdf([px0, py0]);
    return {
      image,
      original,
      origin,
      xAxis: [right[0] - origin[0], right[1] - origin[1]],
      yAxis: [top[0] - origin[0], top[1] - origin[1]],
    };
  }

  /** Puts a cleaned piece of a scan onto the page, above what is there. */
  private insertPatch(pageIndex: number, patch: Omit<ScanPatch, 'original'>): void {
    const lib = this.lib;
    const { width, height, rgba } = patch.image;
    const bitmap = lib.FPDFBitmap_Create(width, height, 0);
    if (!bitmap) throw new EngineError('EngineError', 'Not enough memory to write the page.');
    try {
      const stride = lib.FPDFBitmap_GetStride(bitmap);
      const ptr = lib.FPDFBitmap_GetBuffer(bitmap);
      const heap = heapU8(lib);
      // BGRx rows.
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = (y * width + x) * 4;
          const to = ptr + y * stride + x * 4;
          heap[to] = rgba[from + 2]!;
          heap[to + 1] = rgba[from + 1]!;
          heap[to + 2] = rgba[from]!;
          heap[to + 3] = 255;
        }
      }
      const object = lib.FPDFPageObj_NewImageObj(this.handle);
      if (!object) throw new EngineError('EngineError', 'Could not create an image.');
      if (!lib.FPDFImageObj_SetBitmap(0, 0, object, bitmap)) throw new EngineError('EngineError', 'Could not store an image.');
      const [a, b] = patch.xAxis;
      const [c, d] = patch.yAxis;
      lib.FPDFImageObj_SetMatrix(object, a, b, c, d, patch.origin[0], patch.origin[1]);
      lib.FPDFPage_InsertObject(this.page(pageIndex), object);
    } finally {
      lib.FPDFBitmap_Destroy(bitmap);
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
        // Cleaned from the page as it is before any plan changes it (unless the
        // editor already composed the piece, with the new text set in the scan's letters).
        patch: plan.patch ?? (plan.erase ? this.scanPatch(plan.page, plan.erase) : null),
      };
    });
    for (const { plan, page, removed, moved, words, patch } of resolved) {
      if (patch) this.insertPatch(plan.page, patch);
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
    // Text drawn into a scan stays searchable: an invisible layer, as recognition writes it.
    const invisible = plans.filter((plan) => plan.invisible?.length);
    if (invisible.length) {
      const regular = fallbackFonts[FALLBACK_REGULAR];
      if (!regular) throw new EngineError('EngineError', 'The font for recognized text is missing.');
      const bold = fallbackFonts[FALLBACK_BOLD];
      this.addInvisibleText(
        invisible.map((plan) => ({ page: plan.page, words: plan.invisible! })),
        bold ? { regular, bold } : { regular },
      );
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
   * Size, weight and colour are those of the text on the scan (the fill colour
   * isn't drawn, but it is what editing the text later starts from).
   * `fonts` are TrueType fonts with every character used (ideally subset).
   */
  addInvisibleText(pages: { page: number; words: InvisibleWord[] }[], fonts: { regular: Uint8Array; bold?: Uint8Array }): void {
    const lib = this.lib;
    const { wasmExports } = lib.pdfium;
    const load = (font: Uint8Array): number => {
      const ptr = wasmExports.malloc(font.length);
      try {
        heapU8(lib).set(font, ptr);
        const handle = lib.FPDFText_LoadFont(this.handle, ptr, font.length, FPDF_FONT_TRUETYPE, true);
        if (!handle) throw new EngineError('EngineError', 'Could not embed the font for recognized text.');
        return handle;
      } finally {
        wasmExports.free(ptr);
      }
    };
    const regular = load(fonts.regular);
    const bold = fonts.bold ? load(fonts.bold) : regular;
    const bounds = wasmExports.malloc(16);
    try {
      for (const { page: index, words } of pages) {
        const page = this.page(index);
        for (const word of words) {
          const object = lib.FPDFPageObj_CreateTextObj(this.handle, word.bold ? bold : regular, word.size);
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
          lib.FPDFPageObj_SetFillColor(object, ...parseColor(word.color), 255);
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
      lib.FPDFFont_Close(regular);
      if (bold !== regular) lib.FPDFFont_Close(bold);
    }
  }

  /**
   * Makes the file smaller by re-encoding its pictures: each one sharper than
   * `dpi` where it's drawn is scaled down to it, and stored as JPEG at
   * `quality` (0–1) if that is smaller than it was. Pictures with
   * transparency, 1-bit pictures (fax scans compress better as they are) and
   * pictures drawn on several pages are left alone. `encode` turns RGBA
   * pixels into JPEG bytes at a given size (the worker uses OffscreenCanvas).
   */
  async compressImages(
    options: { dpi: number; quality: number },
    encode: EncodeJpeg,
  ): Promise<{ images: number; recompressed: number }> {
    const lib = this.lib;
    const { wasmExports } = lib.pdfium;
    const scratch = wasmExports.malloc(32);
    const pageHandle = wasmExports.malloc(4);
    const access = wasmExports.malloc(12);
    // The JPEG being loaded, read by PDFium through a callback.
    let source = { ptr: 0, length: 0 };
    const module = lib.pdfium as unknown as {
      addFunction(fn: (...args: number[]) => number, signature: string): number;
      removeFunction(ptr: number): void;
    };
    const getBlock = module.addFunction((_param: number, position: number, buffer: number, size: number) => {
      if (position + size > source.length) return 0;
      heapU8(lib).copyWithin(buffer, source.ptr + position, source.ptr + position + size);
      return 1;
    }, 'iiiii');

    // Images drawn on several pages (logos, letterheads) share one stream; replacing it
    // per page would store it many times over.
    type Candidate = { page: number; object: number; key: string };
    const candidates: Candidate[] = [];
    const uses = new Map<string, number>();
    let images = 0;
    let recompressed = 0;
    try {
      for (let index = 0; index < this.pageCount; index++) {
        const page = this.page(index);
        const count = lib.FPDFPage_CountObjects(page);
        for (let i = 0; i < count; i++) {
          const object = lib.FPDFPage_GetObject(page, i);
          if (lib.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) continue;
          images++;
          if (!lib.FPDFImageObj_GetImagePixelSize(object, scratch, scratch + 4)) continue;
          const [w, h] = new Uint32Array(heapU8(lib).buffer, scratch, 2);
          const raw = lib.FPDFImageObj_GetImageDataRaw(object, 0, 0);
          const key = `${w}x${h}:${raw}`;
          uses.set(key, (uses.get(key) ?? 0) + 1);
          candidates.push({ page: index, object: i, key });
        }
      }

      const touched = new Set<number>();
      for (const { page: index, object: objectIndex, key } of candidates) {
        if (uses.get(key)! > 1) continue;
        const page = this.page(index);
        const object = lib.FPDFPage_GetObject(page, objectIndex);
        if (!lib.FPDFImageObj_GetImagePixelSize(object, scratch, scratch + 4)) continue;
        const [width, height] = [...new Uint32Array(heapU8(lib).buffer, scratch, 2)] as [number, number];
        if (width * height < 160_000) continue;
        // FPDF_IMAGEOBJ_METADATA: width, height, dpi x/y (floats), bits per pixel, colorspace, marked content.
        if (lib.FPDFImageObj_GetImageMetadata(object, page, scratch) && new Uint32Array(heapU8(lib).buffer, scratch + 16, 1)[0]! <= 1) continue;
        if (!lib.FPDFPageObj_GetBounds(object, scratch, scratch + 4, scratch + 8, scratch + 12)) continue;
        const [left, bottom, right, top] = [...heapF32(lib).subarray(scratch >> 2, (scratch >> 2) + 4)] as number[];
        const shownWidth = Math.max(1, Math.max(right! - left!, top! - bottom!));
        const dpi = Math.max(width, height) / (shownWidth / 72);
        const scale = Math.min(1, options.dpi / dpi);
        const raw = lib.FPDFImageObj_GetImageDataRaw(object, 0, 0);

        // Transparency (a soft mask or a colour key) would turn into a solid background.
        const rendered = lib.FPDFImageObj_GetRenderedBitmap(this.handle, page, object);
        if (rendered) {
          const rw = lib.FPDFBitmap_GetWidth(rendered);
          const rh = lib.FPDFBitmap_GetHeight(rendered);
          const stride = lib.FPDFBitmap_GetStride(rendered);
          const buffer = lib.FPDFBitmap_GetBuffer(rendered);
          let transparent = false;
          if (lib.FPDFBitmap_GetFormat(rendered) === 4) {
            const heap = heapU8(lib);
            for (let y = 0; y < rh && !transparent; y++) {
              for (let x = 0; x < rw; x++) if (heap[buffer + y * stride + x * 4 + 3]! < 250) (transparent = true);
            }
          }
          lib.FPDFBitmap_Destroy(rendered);
          if (transparent) continue;
        }

        const bitmap = lib.FPDFImageObj_GetBitmap(object);
        if (!bitmap) continue;
        let rgba: Uint8ClampedArray;
        try {
          const format = lib.FPDFBitmap_GetFormat(bitmap);
          const bytesPerPixel = { 1: 1, 2: 3, 3: 4, 4: 4 }[format];
          if (!bytesPerPixel) continue;
          const stride = lib.FPDFBitmap_GetStride(bitmap);
          const buffer = lib.FPDFBitmap_GetBuffer(bitmap);
          const heap = heapU8(lib);
          rgba = new Uint8ClampedArray(width * height * 4);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const from = buffer + y * stride + x * bytesPerPixel;
              const to = (y * width + x) * 4;
              if (bytesPerPixel === 1) rgba[to] = rgba[to + 1] = rgba[to + 2] = heap[from]!;
              else {
                rgba[to] = heap[from + 2]!;
                rgba[to + 1] = heap[from + 1]!;
                rgba[to + 2] = heap[from]!;
              }
              rgba[to + 3] = 255;
            }
          }
        } finally {
          lib.FPDFBitmap_Destroy(bitmap);
        }
        const jpeg = await encode(rgba, width, height, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), options.quality);
        if (jpeg.length >= raw * 0.9) continue;

        source = { ptr: wasmExports.malloc(jpeg.length), length: jpeg.length };
        try {
          heapU8(lib).set(jpeg, source.ptr);
          new Uint32Array(heapU8(lib).buffer, access, 3).set([jpeg.length, getBlock, 0]);
          new Uint32Array(heapU8(lib).buffer, pageHandle, 1)[0] = page;
          // Inline: PDFium copies the bytes, so they can be freed right after.
          if (lib.FPDFImageObj_LoadJpegFileInline(pageHandle, 1, object, access)) {
            recompressed++;
            touched.add(index);
          }
        } finally {
          wasmExports.free(source.ptr);
          source = { ptr: 0, length: 0 };
        }
      }
      for (const index of touched) {
        if (!lib.FPDFPage_GenerateContent(this.page(index))) throw new EngineError('EngineError', `Could not write page ${index + 1}.`);
      }
    } finally {
      module.removeFunction(getBlock);
      wasmExports.free(scratch);
      wasmExports.free(pageHandle);
      wasmExports.free(access);
    }
    return { images, recompressed };
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
