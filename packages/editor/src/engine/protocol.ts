import type { InvisibleWord } from '../ocr/place';
import type { ScanErase } from '../text/scan-edit';
import type { SearchOptions } from '../text/search';
import type { TextWritePlan } from '../text/write-plan';
import type { PageInfo } from './pdfium-core';

/** Messages from the editor to the engine worker. Every request except `cancel` gets exactly one response. */
export type EngineRequest =
  | { id: number; type: 'init'; wasmUrl: string; subsetWasmUrl: string }
  /** Opens a document; it replaces the one being edited unless `keep` (one opened alongside it). */
  | { id: number; type: 'open'; data: ArrayBuffer; keep?: boolean }
  | { id: number; type: 'render'; docId: number; page: number; width: number; height: number; hidden?: number[] }
  | { id: number; type: 'text'; docId: number; page: number }
  /** Opens a protected file with `password` and returns a copy without its protection; PasswordException if it's wrong. */
  | { id: number; type: 'unlock'; data: ArrayBuffer; password: string }
  /** Searches pages in the worker, so only the matches cross over (text models of a long document are large). */
  | { id: number; type: 'search'; docId: number; pages: number[]; query: string; options: SearchOptions }
  | { id: number; type: 'glyphs'; docId: number; page: number; object: number; chars: string[] }
  /** Applies text edits to a fresh copy of `data` and returns the saved file; the open document is untouched. */
  | { id: number; type: 'writeText'; data: ArrayBuffer; plans: TextWritePlan[]; fallbackFonts: Record<number, ArrayBuffer> }
  | { id: number; type: 'scanInfo'; docId: number; page: number }
  /** RGBA pixels of a page (no annotations), for recognition. */
  | { id: number; type: 'raster'; docId: number; page: number; width: number; height: number }
  /** Writes recognized text as invisible text into the open document and returns the saved file. */
  | {
      id: number;
      type: 'addInvisibleText';
      docId: number;
      pages: { page: number; words: InvisibleWord[] }[];
      fonts: { regular: ArrayBuffer; bold: ArrayBuffer };
    }
  /** A cleaned piece of a scan for an edited paragraph, see `PdfiumDocument.scanPatch`. */
  | { id: number; type: 'scanPatch'; docId: number; page: number; erase: ScanErase }
  /** Re-encodes the pictures of `data` (a copy of the file) to make it smaller; returns the saved file. */
  | { id: number; type: 'compress'; data: ArrayBuffer; dpi: number; quality: number }
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'close'; docId: number };

export interface OpenResult {
  docId: number;
  pages: PageInfo[];
}

export type EngineResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };
