import type { PageInfo } from './pdfium-core';

/** Messages from the editor to the engine worker. Every request except `cancel` gets exactly one response. */
export type EngineRequest =
  | { id: number; type: 'init'; wasmUrl: string }
  | { id: number; type: 'open'; data: ArrayBuffer }
  | { id: number; type: 'render'; docId: number; page: number; width: number; height: number; hidden?: number[] }
  | { id: number; type: 'text'; docId: number; page: number }
  | { id: number; type: 'glyphs'; docId: number; page: number; object: number; chars: string[] }
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'close'; docId: number };

export interface OpenResult {
  docId: number;
  pages: PageInfo[];
}

export type EngineResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };
