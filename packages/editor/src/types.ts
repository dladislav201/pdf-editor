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

export type ToolName = 'select' | 'highlight' | 'rectangle' | 'ink' | 'text';

interface AnnotationBase {
  id: string;
  /** Zero-based page index. */
  pageIndex: number;
  /** CSS hex color, e.g. `#f59e0b`. */
  color: string;
  /** ISO timestamp. */
  createdAt: string;
  author?: string;
}

export interface HighlightAnnotation extends AnnotationBase {
  type: 'highlight';
  rect: Rect;
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
   * Base URL where the pdf.js runtime assets are served (worker, cmaps,
   * standard fonts, wasm). Defaults to the `pdfjs/` folder shipped next to
   * the bundle.
   */
  assetsUrl?: string;
  /** TTF/OTF used for text annotations, in the viewer and in the exported PDF. Needed for non-Latin text. */
  fontUrl?: string;
  /** Show the built-in toolbar. Default `true`. */
  toolbar?: boolean;
  /** Default `'fit-width'`. */
  initialZoom?: ZoomValue;
  /** Annotations to show on load, e.g. restored from your backend. */
  annotations?: Annotation[];
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
  error: { error: unknown };
}
