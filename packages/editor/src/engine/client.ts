import type { InvisibleWord } from '../ocr/place';
import type { SearchMatch, SearchOptions } from '../text/search';
import type { PageText } from '../text/types';
import type { TextWritePlan } from '../text/write-plan';
import type { ScanErase } from '../text/scan-edit';
import type { ScanInfo, ScanPatch } from './pdfium-core';
import type { FontGlyphs } from './pdfium-glyphs';
import type { EngineRequest, EngineResponse, OpenResult } from './protocol';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface RenderHandle {
  promise: Promise<ImageBitmap>;
  cancel: () => void;
}

function toError(error: { name: string; message: string }): Error {
  return Object.assign(new Error(error.message), { name: error.name });
}

/** Main-thread side of the PDFium worker: request/response over postMessage. */
export class EngineClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<unknown>;
  private nextId = 1;
  private terminated = false;

  constructor(createWorker: () => Worker, wasmUrl: string, subsetWasmUrl: string) {
    this.worker = createWorker();
    this.worker.onmessage = (event: MessageEvent<EngineResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) {
        // A late bitmap for a request we stopped waiting for: free it right away.
        if (response.ok && response.result instanceof ImageBitmap) response.result.close();
        return;
      }
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(toError(response.error));
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.failAll(new Error(event.message || 'The PDF engine crashed.'));
    };
    this.ready = this.send({ type: 'init', wasmUrl, subsetWasmUrl }).promise;
    // Init failures surface through `open()`; an editor destroyed before
    // opening anything must not leave an unhandled rejection behind.
    this.ready.catch(() => undefined);
  }

  private send(request: DistributiveOmit<EngineRequest, 'id'>, transfer: Transferable[] = []): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    if (this.terminated) return { id, promise: Promise.reject(new Error('The PDF engine was shut down.')) };
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ ...request, id } as EngineRequest, transfer);
    return { id, promise };
  }

  /**
   * Opens a document, replacing the one being edited, or alongside it with
   * `keep` (close it yourself). The bytes are transferred, so pass a copy you don't need.
   */
  async open(bytes: Uint8Array, keep = false): Promise<OpenResult> {
    await this.ready;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return (await this.send({ type: 'open', data: buffer, ...(keep ? { keep } : {}) }, [buffer]).promise) as OpenResult;
  }

  /** A copy of a protected file without its protection, opened with `password` (PasswordException if wrong). */
  async unlock(bytes: Uint8Array, password: string): Promise<Uint8Array> {
    await this.ready;
    const buffer = bytes.slice().buffer as ArrayBuffer;
    return (await this.send({ type: 'unlock', data: buffer, password }, [buffer]).promise) as Uint8Array;
  }

  render(docId: number, page: number, width: number, height: number, hidden?: number[]): RenderHandle {
    const { id, promise } = this.send({ type: 'render', docId, page, width, height, ...(hidden?.length ? { hidden } : {}) });
    return {
      promise: promise as Promise<ImageBitmap>,
      cancel: () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(Object.assign(new Error('Render cancelled.'), { name: 'AbortError' }));
        if (!this.terminated) this.worker.postMessage({ type: 'cancel', target: id, id: this.nextId++ } satisfies EngineRequest);
      },
    };
  }

  /** Lines, paragraphs and styles of a page. */
  async text(docId: number, page: number): Promise<PageText> {
    return (await this.send({ type: 'text', docId, page }).promise) as PageText;
  }

  /** Matches of `query` on `pages`, found in the worker. */
  async search(docId: number, pages: number[], query: string, options: SearchOptions): Promise<SearchMatch[]> {
    return (await this.send({ type: 'search', docId, pages, query, options }).promise) as SearchMatch[];
  }

  /** Outlines and advances of `chars` in the font of a page's text object. */
  async glyphs(docId: number, page: number, object: number, chars: string[]): Promise<FontGlyphs> {
    return (await this.send({ type: 'glyphs', docId, page, object, chars }).promise) as FontGlyphs;
  }

  /** A copy of `bytes` with the planned text edits written in; `fallbackFonts` are the TTFs fallback words use. */
  async writeText(bytes: Uint8Array, plans: TextWritePlan[], fallbackFonts: Record<number, ArrayBuffer>): Promise<Uint8Array> {
    await this.ready;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return (await this.send({ type: 'writeText', data: buffer, plans, fallbackFonts }, [buffer]).promise) as Uint8Array;
  }

  /** Whether a page is a scan and whether it already has recognized text. */
  async scanInfo(docId: number, page: number): Promise<ScanInfo> {
    return (await this.send({ type: 'scanInfo', docId, page }).promise) as ScanInfo;
  }

  /** The scan under an edited paragraph with its words erased, and where it goes. */
  async scanPatch(docId: number, page: number, erase: ScanErase): Promise<ScanPatch> {
    return (await this.send({ type: 'scanPatch', docId, page, erase }).promise) as ScanPatch;
  }

  /** A copy of `bytes` with its pictures re-encoded (see `PdfiumDocument.compressImages`). */
  async compress(bytes: Uint8Array, dpi: number, quality: number): Promise<Uint8Array> {
    await this.ready;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return (await this.send({ type: 'compress', data: buffer, dpi, quality }, [buffer]).promise) as Uint8Array;
  }

  /** RGBA pixels of a page at the given size, without annotations. */
  async raster(docId: number, page: number, width: number, height: number): Promise<Uint8ClampedArray> {
    return (await this.send({ type: 'raster', docId, page, width, height }).promise) as Uint8ClampedArray;
  }

  /** Writes recognized words into the open document as invisible text; returns the saved file. */
  async addInvisibleText(
    docId: number,
    pages: { page: number; words: InvisibleWord[] }[],
    fonts: { regular: ArrayBuffer; bold: ArrayBuffer },
  ): Promise<Uint8Array> {
    return (await this.send({ type: 'addInvisibleText', docId, pages, fonts }).promise) as Uint8Array;
  }

  async close(docId: number): Promise<void> {
    await this.send({ type: 'close', docId }).promise.catch(() => undefined);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    this.failAll(Object.assign(new Error('The PDF engine was shut down.'), { name: 'AbortError' }));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
