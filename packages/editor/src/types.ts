import type { TextParagraph } from './text/types';

/**
 * All annotation geometry is stored in PDF user space (points, origin at the
 * bottom-left of the page, y grows upwards). That keeps annotations stable
 * across zoom levels and lets the exporter draw them without conversion.
 */
export type Point = [x: number, y: number];

/** Axis-aligned box in PDF user space; (x, y) is the bottom-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToolName = 'select' | 'editText' | 'highlight' | 'rectangle' | 'ink' | 'text';

interface AnnotationBase {
  id: string;
  /** Zero-based page index. */
  pageIndex: number;
  /** CSS hex color, e.g. `#f59e0b`. */
  color: string;
  /** ISO timestamp. */
  createdAt: string;
  author?: string;
  /** Comment attached to the markup (the PDF `/Contents` of non-text annotations). */
  comment?: string;
}

export interface HighlightAnnotation extends AnnotationBase {
  type: 'highlight';
  /** Bounding box of the highlight. */
  rect: Rect;
  /**
   * Per-line boxes when the highlight spans several lines, as text highlights
   * from Acrobat and other viewers do. When absent, `rect` is the highlight.
   */
  segments?: Rect[];
  opacity: number;
}

export interface RectangleAnnotation extends AnnotationBase {
  type: 'rectangle';
  rect: Rect;
  strokeWidth: number;
}

export interface InkAnnotation extends AnnotationBase {
  type: 'ink';
  /** One entry per stroke. */
  paths: Point[][];
  strokeWidth: number;
}

export interface TextAnnotation extends AnnotationBase {
  type: 'text';
  /** Top-left corner of the text box. */
  position: Point;
  text: string;
  fontSize: number;
}

export type Annotation =
  | HighlightAnnotation
  | RectangleAnnotation
  | InkAnnotation
  | TextAnnotation;

export type DocumentSource = string | URL | ArrayBuffer | Uint8Array | Blob;

export type ZoomValue = number | 'fit-width';

export interface EditorOptions {
  /** Element the editor mounts into. It should have an explicit height. */
  container: HTMLElement;
  /** PDF to open right away. */
  document?: DocumentSource;
  /**
   * Base URL where the engine assets (`pdfium.wasm`) are served. Defaults to
   * the `engine/` folder shipped next to the bundle.
   */
  assetsUrl?: string;
  /**
   * URL of the engine worker script, for setups that can't use the bundled
   * one (e.g. a strict CSP or a CDN). Defaults to the worker shipped with the
   * package.
   */
  workerUrl?: string | URL;
  /** TTF/OTF used for text annotations, in the viewer and in the exported PDF. Needed for non-Latin text. */
  fontUrl?: string;
  /** Show the built-in toolbar. Default `true`. */
  toolbar?: boolean;
  /** Default `'fit-width'`. */
  initialZoom?: ZoomValue;
  /**
   * Annotations to show on load, e.g. restored from your backend. When given,
   * they replace the annotations stored in the PDF file itself.
   */
  annotations?: Annotation[];
  /**
   * Read highlight, rectangle, ink and free-text annotations stored in the PDF
   * and make them editable. Default `true`. Other annotation types (links,
   * form fields, stamps, …) are always kept as they are.
   */
  importAnnotations?: boolean;
  /** Written into every new annotation. */
  author?: string;
  /** Default `'auto'` (follows the OS setting). */
  theme?: 'light' | 'dark' | 'auto';
  /** Disables all editing tools. */
  readOnly?: boolean;
}

export interface EditorEventMap {
  documentLoaded: { pageCount: number };
  annotationsChange: { annotations: Annotation[] };
  selectionChange: { id: string | null };
  toolChange: { tool: ToolName };
  colorChange: { color: string | null };
  zoomChange: { zoom: number };
  pageChange: { pageIndex: number };
  historyChange: { canUndo: boolean; canRedo: boolean };
  /** A paragraph of page text was selected with the Edit text tool (or the selection cleared). */
  paragraphSelect: { paragraph: TextParagraph | null };
  /** Page text was edited (fires when an edit session ends). */
  textEditsChange: { edits: { paragraphId: string; pageIndex: number; text: string }[] };
  error: { error: unknown };
}
