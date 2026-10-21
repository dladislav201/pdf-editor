import type { InvisibleWord } from '../ocr/place';
import type { TextWritePlan } from '../text/write-plan';
import type { PageInfo } from './pdfium-core';

/** Messages from the editor to the engine worker. Every request except `cancel` gets exactly one response. */
export type EngineRequest =
  | { id: number; type: 'init'; wasmUrl: string; subsetWasmUrl: string }
  | { id: number; type: 'open'; data: ArrayBuffer }
  | { id: number; type: 'render'; docId: number; page: number; width: number; height: number; hidden?: number[] }
  | { id: number; type: 'text'; docId: number; page: number }
  | { id: number; type: 'glyphs'; docId: number; page: number; object: number; chars: string[] }
  /** Applies text edits to a fresh copy of `data` and returns the saved file; the open document is untouched. */
  | { id: number; type: 'writeText'; data: ArrayBuffer; plans: TextWritePlan[]; fallbackFonts: Record<number, ArrayBuffer> }
  | { id: number; type: 'scanInfo'; docId: number; page: number }
  /** RGBA pixels of a page (no annotations), for recognition. */
  | { id: number; type: 'raster'; docId: number; page: number; width: number; height: number }
  /** Writes recognized text as invisible text into the open document and returns the saved file. */
  | { id: number; type: 'addInvisibleText'; docId: number; pages: { page: number; words: InvisibleWord[] }[]; font: ArrayBuffer }
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'close'; docId: number };

export interface OpenResult {
  docId: number;
  pages: PageInfo[];
}

export type EngineResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };
