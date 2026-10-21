import type { PageText } from '../text/types';
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

  constructor(createWorker: () => Worker, wasmUrl: string) {
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
    this.ready = this.send({ type: 'init', wasmUrl }).promise;
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

  /** Opens a document, replacing any open one. The bytes are transferred, so pass a copy you don't need. */
  async open(bytes: Uint8Array): Promise<OpenResult> {
    await this.ready;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return (await this.send({ type: 'open', data: buffer }, [buffer]).promise) as OpenResult;
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

  /** Outlines and advances of `chars` in the font of a page's text object. */
  async glyphs(docId: number, page: number, object: number, chars: string[]): Promise<FontGlyphs> {
    return (await this.send({ type: 'glyphs', docId, page, object, chars }).promise) as FontGlyphs;
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
