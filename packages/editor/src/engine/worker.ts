/// <reference lib="webworker" />
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import { analyzePage } from '../text/analyze';
import { createSubsetter, type Subsetter } from './hb-subset';
import { EngineError, PdfiumDocument, initLibrary, type EncodeJpeg } from './pdfium-core';
import type { EngineRequest, EngineResponse, OpenResult } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

type RenderRequest = Extract<EngineRequest, { type: 'render' }>;

let library: Promise<WrappedPdfiumModule> | null = null;
let subsetWasmUrl = '';
let subsetter: Promise<Subsetter> | null = null;
/** Open documents by id: the one being edited, and any opened alongside it (pages to merge in). */
const docs = new Map<number, PdfiumDocument>();
/** The document being edited; opening another without `keep` replaces it. */
let mainId: number | null = null;
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

function loadSubsetter(): Promise<Subsetter> {
  subsetter ??= fetch(subsetWasmUrl).then(async (response) => {
    if (!response.ok) throw new EngineError('EngineError', `Could not load the font subsetter (HTTP ${response.status}).`);
    return createSubsetter(await response.arrayBuffer());
  });
  return subsetter.catch((error: unknown) => {
    subsetter = null;
    throw error;
  });
}

/** JPEG encoding with the browser's own encoder, resized in high quality on the way. */
const encodeJpeg: EncodeJpeg = async (rgba, width, height, targetWidth, targetHeight, quality) => {
  const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba), width, height), {
    resizeWidth: targetWidth,
    resizeHeight: targetHeight,
    resizeQuality: 'high',
  });
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
};

function openDoc(docId: number): PdfiumDocument {
  const doc = docs.get(docId);
  if (!doc) throw new EngineError('EngineError', 'The document is no longer open.');
  return doc;
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
        const pixels = openDoc(job.docId).render(job.page, job.width, job.height, job.hidden);
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
      subsetWasmUrl = request.subsetWasmUrl;
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
        const id = nextDocId++;
        if (!request.keep) {
          if (mainId !== null) docs.get(mainId)?.close();
          if (mainId !== null) docs.delete(mainId);
          mainId = id;
        }
        docs.set(id, doc);
        const result: OpenResult = {
          docId: id,
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
        reply({ id: request.id, ok: true, result: openDoc(request.docId).glyphs(request.page, request.object, request.chars) });
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'writeText': {
      let copy: PdfiumDocument | null = null;
      try {
        if (!library) throw new EngineError('EngineError', 'The engine is not initialised.');
        copy = new PdfiumDocument(await library, new Uint8Array(request.data));
        // Fallback fonts go in subset to the characters their words use.
        const needed = new Map<number, Set<string>>();
        const invisible = request.plans.flatMap((plan) => plan.invisible ?? []);
        for (const word of [...request.plans.flatMap((plan) => plan.fallback), ...invisible.map((w) => ({ ...w, font: w.bold ? -2 : -1 }))]) {
          const chars = needed.get(word.font) ?? new Set<string>();
          for (const char of word.text) chars.add(char);
          needed.set(word.font, chars);
        }
        const fonts: Record<number, Uint8Array> = {};
        if (needed.size) {
          const hb = await loadSubsetter();
          for (const [font, chars] of needed) {
            const bytes = request.fallbackFonts[font];
            if (bytes) fonts[font] = hb.subset(new Uint8Array(bytes), chars);
          }
        }
        copy.applyTextPlans(request.plans, fonts);
        const saved = copy.save();
        reply({ id: request.id, ok: true, result: saved }, [saved.buffer]);
      } catch (error) {
        fail(request.id, error);
      } finally {
        copy?.close();
      }
      return;
    }
    case 'text':
      try {
        reply({ id: request.id, ok: true, result: analyzePage(openDoc(request.docId).extractText(request.page)) });
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'scanInfo':
      try {
        reply({ id: request.id, ok: true, result: openDoc(request.docId).scanInfo(request.page) });
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'raster':
      try {
        // Without annotations: notes and highlights on top of a scan aren't part of its text.
        const pixels = openDoc(request.docId).render(request.page, request.width, request.height, [], false);
        reply({ id: request.id, ok: true, result: pixels }, [pixels.buffer]);
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'compress': {
      let copy: PdfiumDocument | null = null;
      try {
        if (!library) throw new EngineError('EngineError', 'The engine is not initialised.');
        copy = new PdfiumDocument(await library, new Uint8Array(request.data));
        await copy.compressImages({ dpi: request.dpi, quality: request.quality }, encodeJpeg);
        const saved = copy.save();
        reply({ id: request.id, ok: true, result: saved }, [saved.buffer]);
      } catch (error) {
        fail(request.id, error);
      } finally {
        copy?.close();
      }
      return;
    }
    case 'scanPatch':
      try {
        const patch = openDoc(request.docId).scanPatch(request.page, request.erase);
        reply({ id: request.id, ok: true, result: patch }, [patch.image.rgba.buffer, patch.original.rgba.buffer]);
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'addInvisibleText':
      try {
        const doc = openDoc(request.docId);
        const hb = await loadSubsetter();
        const words = request.pages.flatMap((p) => p.words);
        const subset = (font: ArrayBuffer, bold: boolean) =>
          hb.subset(new Uint8Array(font), new Set(words.filter((w) => w.bold === bold).flatMap((w) => [...w.text])));
        doc.addInvisibleText(request.pages, {
          regular: subset(request.fonts.regular, false),
          ...(words.some((w) => w.bold) ? { bold: subset(request.fonts.bold, true) } : {}),
        });
        const saved = doc.save();
        reply({ id: request.id, ok: true, result: saved }, [saved.buffer]);
      } catch (error) {
        fail(request.id, error);
      }
      return;
    case 'cancel':
      if (queue.some((job) => job.id === request.target)) cancelled.add(request.target);
      return;
    case 'close':
      docs.get(request.docId)?.close();
      docs.delete(request.docId);
      if (mainId === request.docId) mainId = null;
      reply({ id: request.id, ok: true });
      return;
  }
};
