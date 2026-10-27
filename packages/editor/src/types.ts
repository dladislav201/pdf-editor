import type { OcrPage } from './ocr/types';
import type { FormValue } from './pdf/forms';
import type { TextStyle } from './text/edit-session';
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

/**
 * `highlight`, `underline` and `strikeout` mark the page text dragged across,
 * line by line (`highlight` draws a box where there is no text). `image`
 * places the picture given to `placeImage()` (a signature) where the user clicks.
 */
export type ToolName = 'select' | 'editText' | 'highlight' | 'underline' | 'strikeout' | 'rectangle' | 'ink' | 'text' | 'image';

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

/** A line under or through page text: one per line of text, as the PDF `/Underline` and `/StrikeOut` annotations. */
export interface TextLineAnnotation extends AnnotationBase {
  type: 'underline' | 'strikeout';
  /** Bounding box of the marked text. */
  rect: Rect;
  /** The marked text's box on each line; when absent, `rect` is the only one. */
  segments?: Rect[];
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

/** A picture on the page, such as a signature: saved as a PDF stamp that keeps the original image. */
export interface ImageAnnotation extends AnnotationBase {
  type: 'image';
  rect: Rect;
  /** The image as a `data:image/png` or `data:image/jpeg` URL. */
  src: string;
  /** What it is, for other viewers (the stamp's name): a signature or any image. */
  kind: 'signature' | 'image';
}

export type Annotation =
  | HighlightAnnotation
  | TextLineAnnotation
  | RectangleAnnotation
  | InkAnnotation
  | TextAnnotation
  | ImageAnnotation;

export type DocumentSource = string | URL | ArrayBuffer | Uint8Array | Blob;

export type ZoomValue = number | 'fit-width';

/** Words the editor shows on its own, in English unless given. */
export interface EditorMessages {
  /** No document yet. */
  empty: string;
  loading: string;
  passwordProtected: string;
  invalidPdf: string;
  openFailed: string;
}

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
  /**
   * Folder with the fallback fonts for edited page text (Arimo, Tinos, Cousine
   * in four styles, shipped in `dist/engine/fonts/`). Defaults to `fonts/`
   * under `assetsUrl`.
   */
  fallbackFontsUrl?: string;
  /**
   * Folder with the OCR assets (Tesseract's worker and cores, and `lang/` with
   * `*.traineddata.gz` models), shipped in `dist/engine/ocr/` with Ukrainian
   * and English. Defaults to `ocr/` under `assetsUrl`.
   */
  ocrUrl?: string;
  /**
   * Asked when a file needs a password to open (again with `incorrect` after
   * a wrong one); resolve with the password, or null to give up. Without it,
   * such files don't open. Files are decrypted once on opening, so the
   * document — and what is saved — has no password or restrictions.
   */
  getPassword?: (request: { fileName: string; incorrect: boolean }) => Promise<string | null>;
  /**
   * Languages scans are read in (Tesseract codes, the most likely first):
   * `eng`, `ukr`, `deu`, `nor` and `swe` ship in `dist/engine/ocr/lang`.
   * Each one costs time per page, so name only the ones the documents use.
   * Default `['ukr', 'eng']`.
   */
  ocrLanguages?: string[];
  /** The editor's own words, for other languages. */
  messages?: Partial<EditorMessages>;
  /**
   * With the Edit text tool, a click on a scanned page whose text isn't
   * recognized yet reads that page (as `recognizeText` does) and then opens
   * the paragraph under the click, as Acrobat does. Default `true`.
   */
  recognizeOnEdit?: boolean;
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
   * Read highlight, underline, strike-out, rectangle, ink and free-text annotations stored in the PDF
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
  /**
   * Your licence key. Without a valid key for the page's domain the editor
   * runs as a trial: a watermark on the pages and in exported files. Any valid
   * key also works on localhost.
   */
  licenseKey?: string;
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
  /** A paragraph opened for typing with the Edit text tool, or the open one was left (`paragraph` null). */
  textEditing: { paragraph: TextParagraph | null };
  /** Bold, italic, size or family of the selection in the open paragraph changed; `style` is null when none is open or it can't be styled. */
  textStyleChange: { style: TextStyle | null };
  /** A protected file was opened (after its password, if `password`): the document has no protection now. */
  documentUnlocked: { password: boolean };
  /** Page text was edited (fires when an edit session ends). */
  textEditsChange: { edits: { paragraphId: string; pageIndex: number; text: string }[] };
  /** Text recognition is reading `pageIndex` (after `done` of `total` pages); `pageIndex` is -1 once it has stopped. */
  ocrProgress: { pageIndex: number; done: number; total: number };
  /** A form field was filled in. */
  formChange: { name: string; value: FormValue };
  /** Recognized text was added to scanned pages. */
  textRecognized: { pages: OcrPage[] };
  error: { error: unknown };
}

export type CompressLevel = 'light' | 'recommended' | 'strong';

/** Pages of a PDF for thumbnails: their displayed sizes (points, rotation applied) and a renderer. */
export interface PageSource {
  pageCount: number;
  sizes: { width: number; height: number }[];
  /** The page as a bitmap `width` pixels wide. */
  render(pageIndex: number, width: number): Promise<ImageBitmap>;
  close(): void;
}

export interface RecognizeOptions {
  /** Pages to read (0-based). Default: every scanned page without recognized text. */
  pages?: number[];
  /** Tesseract language codes; models are loaded from `ocrUrl`. Default: the `ocrLanguages` option. */
  languages?: string[];
  /** Resolution pages are read at. Default 300. */
  dpi?: number;
  signal?: AbortSignal;
}
