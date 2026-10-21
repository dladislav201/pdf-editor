/// <reference lib="webworker" />
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import { analyzePage } from '../text/analyze';
import { EngineError, PdfiumDocument, initLibrary } from './pdfium-core';
import type { EngineRequest, EngineResponse, OpenResult } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

type RenderRequest = Extract<EngineRequest, { type: 'render' }>;

let library: Promise<WrappedPdfiumModule> | null = null;
let current: { id: number; doc: PdfiumDocument } | null = null;
let nextDocId = 1;
const queue: RenderRequest[] = [];
const cancelled = new Set<number>();
let pumping = false;

function reply(response: EngineResponse, transfer: Transferable[] = []): void {
  self.postMessage(response, transfer);
}

function fail(id: number, error: unknown): void {
  const name = error instanceof Error ? error.name : 'EngineError';
  const message = error instanceof Error ? error.message : String(error);
  reply({ id, ok: false, error: { name, message } });
}

async function loadLibrary(wasmUrl: string): Promise<WrappedPdfiumModule> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new EngineError('EngineError', `Could not load the PDF engine (HTTP ${response.status}).`);
  return initLibrary(await init({ wasmBinary: await response.arrayBuffer() }));
}

/**
 * Renders run one at a time and yield between jobs, so a `cancel` sent while
 * the user zooms or scrolls arrives before stale pages are drawn.
 */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      if (cancelled.delete(job.id)) {
        fail(job.id, Object.assign(new Error('Render cancelled.'), { name: 'AbortError' }));
        continue;
      }
      try {
        if (!current || current.id !== job.docId) throw new EngineError('EngineError', 'The document is no longer open.');
        const pixels = current.doc.render(job.page, job.width, job.height, job.hidden);
        const bitmap = await createImageBitmap(new ImageData(pixels, job.width, job.height));
        reply({ id: job.id, ok: true, result: bitmap }, [bitmap]);
      } catch (error) {
        fail(job.id, error);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    pumping = false;
  }
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'init':
      library ??= loadLibrary(request.wasmUrl);
      try {
        await library;
        reply({ id: request.id, ok: true });
      } catch (error) {
        library = null;
        fail(request.id, error);
      }
      return;
    case 'open':
      try {
        if (!library) throw new EngineError('EngineError', 'The engine is not initialised.');
        const lib = await library;
        // Open first: if the new file fails, the current document stays usable.
        const doc = new PdfiumDocument(lib, new Uint8Array(request.data));
        current?.doc.close();
        current = { id: nextDocId++, doc };
        const result: OpenResult = {
          docId: current.id,
          pages: Array.from({ length: doc.pageCount }, (_, i) => doc.pageInfo(i)),
        };
        reply({ id: request.id, ok: true, result });
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'render':
      queue.push(request);
      void pump();
      return;
    case 'glyphs':
      try {
        if (!current || current.id !== request.docId) throw new EngineError('EngineError', 'The document is no longer open.');
        reply({ id: request.id, ok: true, result: current.doc.glyphs(request.page, request.object, request.chars) });
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'text':
      try {
        if (!current || current.id !== request.docId) throw new EngineError('EngineError', 'The document is no longer open.');
        reply({ id: request.id, ok: true, result: analyzePage(current.doc.extractText(request.page)) });
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'cancel':
      if (queue.some((job) => job.id === request.target)) cancelled.add(request.target);
      return;
    case 'close':
      if (current?.id === request.docId) {
        current.doc.close();
        current = null;
      }
      reply({ id: request.id, ok: true });
      return;
  }
};
