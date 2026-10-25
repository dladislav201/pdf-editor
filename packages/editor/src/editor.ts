import { EngineClient } from './engine/client';
import { PageGeometry } from './engine/page-geometry';
import { Emitter } from './events';
import { exportPdf, type ExportOptions } from './export';
import { TEXT_ASCENT, TEXT_LINE_HEIGHT, hitTest, rectFromPoints, round, translate } from './geometry';
import { History } from './history';
import type { ScanInfo, ScanPatch } from './engine/pdfium-core';
import { placeWords, type InvisibleWord } from './ocr/place';
import { recognizeRaster } from './ocr/recognize';
import { ScanFont, type ScanGlyph, type ScanStyle } from './ocr/scan-font';
import { TesseractEngine } from './ocr/tesseract';
import type { OcrPage, Raster } from './ocr/types';
import { checkLicense, type LicenseInfo } from './license';
import { arrangePages, type ArrangedPage } from './pdf/arrange';
import { importAnnotations } from './pdf/read-annotations';
import { PageView } from './page-view';
import { TEXT_FONT_FAMILY, annotationElement, renderPageAnnotations } from './render-annotations';
import { injectStyles } from './styles';
import { TextEditSession, paragraphChars, paragraphFrame } from './text/edit-session';
import { CUSTOM_FONT_BASE, FALLBACK_FONT, GlyphStore, fallbackFile, fallbackId, type FontSource } from './text/glyph-store';
import type { ParagraphLayout } from './text/layout';
import {
  composeScanParagraph,
  growErase,
  scanChars,
  scanCustomFont,
  scanStyle,
  scanTracking,
  scanWritePlan,
  type PageScanFont,
} from './text/scan-type';
import { recognizedChars, scanErase, type ScanErase } from './text/scan-edit';
import { buildWritePlan, type TextWritePlan } from './text/write-plan';
import type { StyledChar } from './text/layout';
import type { PageText, TextParagraph } from './text/types';
import { createToolbar } from './toolbar';
import type {
  Annotation,
  DocumentSource,
  EditorEventMap,
  EditorOptions,
  PageSource,
  Point,
  RecognizeOptions,
  Rect,
  TextAnnotation,
  ToolName,
  ZoomValue,
} from './types';

type DrawingTool = Exclude<ToolName, 'select' | 'editText'>;
const isDrawingTool = (tool: ToolName): tool is DrawingTool => tool !== 'select' && tool !== 'editText';

const DEFAULT_COLORS: Record<DrawingTool, string> = {
  highlight: '#facc15',
  rectangle: '#ef4444',
  ink: '#2f6fed',
  text: '#111827',
};
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MIN_ZOOM = ZOOM_STEPS[0]!;
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
const PAGES_PADDING = 16;
const DEFAULT_FONT_SIZE = 14;
const SHORTCUTS: Record<string, ToolName> = { v: 'select', e: 'editText', h: 'highlight', r: 'rectangle', d: 'ink', t: 'text' };
/** Pointer slack around a paragraph's box when hovering it, in points. */
const PARAGRAPH_HIT_PADDING = 2;

type Interaction =
  | { kind: 'shape'; view: PageView; tool: 'highlight' | 'rectangle'; start: Point; current: Point }
  | { kind: 'ink'; view: PageView; points: Point[] }
  | { kind: 'move'; view: PageView; id: string; start: Point; before: Annotation[]; moved: boolean };

interface TextEditorState {
  el: HTMLTextAreaElement;
  view: PageView;
  position: Point;
  fontSize: number;
  color: string;
  existing: TextAnnotation | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Outline of a paragraph in overlay pixels (rotation-aware), with the reason as a tooltip when read-only. */
function paragraphOutline(view: PageView, paragraph: TextParagraph, box: Rect, selected: boolean): SVGElement {
  const corners = [
    view.pdfToOverlay([box.x, box.y]),
    view.pdfToOverlay([box.x + box.width, box.y + box.height]),
  ];
  const pad = 3;
  const x = Math.min(corners[0]![0], corners[1]![0]) - pad;
  const y = Math.min(corners[0]![1], corners[1]![1]) - pad;
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', String(Math.abs(corners[0]![0] - corners[1]![0]) + pad * 2));
  rect.setAttribute('height', String(Math.abs(corners[0]![1] - corners[1]![1]) + pad * 2));
  rect.setAttribute('rx', '2');
  rect.classList.add('pdfsdk-paragraph', selected ? 'pdfsdk-paragraph--selected' : 'pdfsdk-paragraph--hover');
  if (!paragraph.editable) {
    rect.classList.add('pdfsdk-paragraph--readonly');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = paragraph.reason ?? 'This text can not be edited.';
    rect.append(title);
  }
  return rect;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

let idCounter = 0;
function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ann-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

function defaultAssetsUrl(): string {
  // Kept in a variable so bundlers don't try to resolve the folder at build time.
  const base = import.meta.url;
  return new URL('engine/', base).href;
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

async function readSource(source: DocumentSource): Promise<{ bytes: Uint8Array; name: string }> {
  if (typeof source === 'string' || source instanceof URL) {
    const url = new URL(source, location.href);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the PDF (HTTP ${response.status}).`);
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'document.pdf');
    return { bytes: new Uint8Array(await response.arrayBuffer()), name };
  }
  if (source instanceof Blob) {
    const name = source instanceof File ? source.name : 'document.pdf';
    return { bytes: new Uint8Array(await source.arrayBuffer()), name };
  }
  // Copy: pdf.js transfers its buffer to the worker, and the caller may reuse theirs.
  const bytes = source instanceof Uint8Array ? source.slice() : new Uint8Array(source.slice(0));
  return { bytes, name: 'document.pdf' };
}

/** Tesseract reads best at about 300 dpi; much larger pages only cost memory. */
const OCR_DPI = 300;
const OCR_MAX_PIXELS = 40_000_000;

/** A raster as Tesseract.js takes it in the browser: a canvas it encodes to PNG itself. */
function rasterCanvas({ width, height, rgba }: Raster): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}

/**
 * A recognized paragraph being edited in its scan's own letters: the page's
 * letters and their style for it, the piece of scan under it (erased and as
 * it was), and the image last drawn from them.
 */
interface ScanEdit {
  page: PageScanFont;
  style: ScanStyle;
  bold: boolean;
  /** Custom font id of the scan's letters for this paragraph; `fallback` draws what they lack. */
  font: number;
  fallback: number;
  base: ScanPatch;
  href: string | null;
  painted: ParagraphLayout | null;
  outlines: Map<string, ScanGlyph | null>;
}

const abortError = (message: string) => Object.assign(new Error(message), { name: 'AbortError' });

function describeLoadError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === 'PasswordException') return 'This PDF is password-protected.';
  if (name === 'InvalidPDFException') return 'This file is not a valid PDF.';
  return error instanceof Error ? error.message : 'Could not open the PDF.';
}

/**
 * Embeddable PDF editor. Create it with `PdfEditor.create(options)` or
 * `new PdfEditor(options)` followed by `load()`.
 */
export class PdfEditor {
  private readonly events = new Emitter<EditorEventMap>();
  private readonly root: HTMLDivElement;
  private readonly viewportEl: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  private readonly messageEl: HTMLDivElement;
  private readonly toolbar: { el: HTMLElement; destroy: () => void } | null;
  private readonly assetsUrl: string;
  private readonly fallbackFontsUrl: string;
  private readonly ocrUrl: string;
  private readonly license: Promise<LicenseInfo>;
  private ocr: { engine: TesseractEngine; languages: string } | null = null;
  private recognizing = false;
  private geometries: PageGeometry[] = [];
  private scanInfos = new Map<number, Promise<ScanInfo>>();
  /** Letters of each scanned page, cut from the scan when it is read, for editing its text in them. */
  private scanFonts = new Map<number, Promise<PageScanFont | null>>();
  private scanEdits = new Map<string, ScanEdit>();
  private nextScanFont = CUSTOM_FONT_BASE;
  /** Cleaned scan under each recognized paragraph opened for editing, as an object URL. */
  private scanPatches = new Map<string, Promise<{ href: string; patch: Omit<ScanPatch, 'image'> & { width: number; height: number } }>>();
  private readonly readOnly: boolean;
  private readonly author: string | undefined;
  private readonly importEnabled: boolean;
  private readonly visibleObserver: IntersectionObserver;
  private readonly resizeObserver: ResizeObserver;
  private readonly fontBytes: Promise<ArrayBuffer> | null;
  private readonly measureCtx: CanvasRenderingContext2D | null;

  private readonly engine: EngineClient;
  private docId: number | null = null;
  private bytes: Uint8Array | null = null;
  private fileName = 'document.pdf';
  private views: PageView[] = [];
  private visible = new Set<PageView>();
  private annotations: Annotation[] = [];
  private initialAnnotations: Annotation[] | undefined;
  private readonly history = new History<Annotation[]>();
  private selectedId: string | null = null;
  private textModels = new Map<number, Promise<PageText>>();
  /** Page text models that have arrived, for synchronous checks such as overlap. */
  private readonly pageTexts = new Map<number, PageText>();
  private hoveredParagraph: TextParagraph | null = null;
  private selectedParagraph: TextParagraph | null = null;
  private hoverToken = 0;
  private glyphs!: GlyphStore;
  private textSession: TextEditSession | null = null;
  /** Paragraphs whose text was changed, drawn by their (frozen) sessions until saved. */
  private textEdits = new Map<string, { paragraph: TextParagraph; session: TextEditSession }>();
  private textDragging = false;
  /** A text edit session being opened (glyphs loading): its paragraph and the latest click on it. */
  private opening: { id: string; point: Point; event: PointerEvent; token: number; clicks: number } | null = null;
  private openToken = 0;
  private tool: ToolName = 'select';
  private colors = { ...DEFAULT_COLORS };
  private zoomMode: ZoomValue;
  private zoom = 1;
  private pageIndex = 0;
  private interaction: Interaction | null = null;
  private textEditor: TextEditorState | null = null;
  private loadToken = 0;
  private scrollFrame = 0;
  private destroyed = false;

  /** Mounts the editor and opens `options.document` if given. Rejects (and cleans up) if the document fails to load. */
  static async create(options: EditorOptions): Promise<PdfEditor> {
    const editor = new PdfEditor(options);
    if (options.document) {
      try {
        await editor.load(options.document);
      } catch (error) {
        editor.destroy();
        throw error;
      }
    }
    return editor;
  }

  constructor(options: EditorOptions) {
    const { container } = options;
    injectStyles(container.ownerDocument);
    this.readOnly = options.readOnly ?? false;
    this.author = options.author;
    this.importEnabled = options.importAnnotations ?? true;
    this.zoomMode = options.initialZoom ?? 'fit-width';
    this.initialAnnotations = options.annotations ? structuredClone(options.annotations) : undefined;
    this.assetsUrl = withTrailingSlash(options.assetsUrl ?? defaultAssetsUrl());
    this.fallbackFontsUrl = withTrailingSlash(options.fallbackFontsUrl ?? `${this.assetsUrl}fonts/`);
    this.ocrUrl = withTrailingSlash(options.ocrUrl ?? `${this.assetsUrl}ocr/`);
    const { workerUrl } = options;
    this.engine = new EngineClient(
      () =>
        workerUrl
          ? new Worker(workerUrl, { type: 'module' })
          : // Literal `new URL(…, import.meta.url)` so bundlers emit the worker as its own file.
            new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' }),
      `${this.assetsUrl}pdfium.wasm`,
      `${this.assetsUrl}harfbuzz-subset.wasm`,
    );

    this.root = document.createElement('div');
    this.root.className = 'pdfsdk-root';
    this.root.tabIndex = 0;
    this.root.dataset.theme = options.theme ?? 'auto';
    // Checked offline; until it is, the editor counts as licensed so a paying
    // customer never sees the watermark flash.
    this.license = checkLicense(options.licenseKey, globalThis.location?.hostname ?? '');
    void this.license.then((info) => {
      if (info.status === 'valid') return;
      this.root.dataset.license = 'trial';
      console.warn(`[pdfsdk] ${info.message}`);
    });
    this.root.dataset.tool = this.tool;

    this.viewportEl = document.createElement('div');
    this.viewportEl.className = 'pdfsdk-viewport';
    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'pdfsdk-pages';
    this.messageEl = document.createElement('div');
    this.messageEl.className = 'pdfsdk-message';
    this.viewportEl.append(this.pagesEl, this.messageEl);

    this.toolbar = options.toolbar === false ? null : createToolbar(this, this.readOnly);
    if (this.toolbar) this.root.append(this.toolbar.el);
    this.root.append(this.viewportEl);
    container.append(this.root);
    this.showMessage('Open a PDF to get started.');

    this.measureCtx = document.createElement('canvas').getContext('2d');
    this.fontBytes = options.fontUrl ? this.loadFont(options.fontUrl) : null;

    this.visibleObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const view = this.views[Number((entry.target as HTMLElement).dataset.pageIndex)];
          if (!view) continue;
          if (entry.isIntersecting) {
            this.visible.add(view);
            this.renderView(view);
          } else {
            this.visible.delete(view);
            view.release();
          }
        }
      },
      // Render a screen ahead so scrolling rarely shows a blank page.
      { root: this.viewportEl, rootMargin: '100% 0px' },
    );
    this.resizeObserver = new ResizeObserver(() => {
      if (this.zoomMode === 'fit-width') this.applyZoom();
    });
    this.resizeObserver.observe(this.viewportEl);

    this.pagesEl.addEventListener('pointerdown', this.onPointerDown);
    this.pagesEl.addEventListener('pointermove', this.onPointerMove);
    this.pagesEl.addEventListener('pointerup', this.onPointerUp);
    this.pagesEl.addEventListener('pointercancel', this.onPointerCancel);
    this.pagesEl.addEventListener('dblclick', this.onDoubleClick);
    this.root.addEventListener('keydown', this.onKeyDown);
    this.viewportEl.addEventListener('scroll', this.onScroll, { passive: true });
    this.viewportEl.addEventListener('wheel', this.onWheel, { passive: false });
  }

  // ---------------------------------------------------------------- events

  on<K extends keyof EditorEventMap>(event: K, listener: (payload: EditorEventMap[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  // -------------------------------------------------------------- document

  /** Opens a PDF, replacing the current one. Annotations are reset. */
  async load(source: DocumentSource): Promise<void> {
    const token = ++this.loadToken;
    this.commitTextEditor();
    this.showMessage('Loading…');
    try {
      const file = await readSource(source);
      if (token !== this.loadToken) return;
      // Editable annotations come out of the file into the editor; the stripped
      // file is what the engine renders and what export writes them back into.
      const { bytes, annotations: imported } = this.importEnabled
        ? await importAnnotations(file.bytes)
        : { bytes: file.bytes, annotations: [] };
      if (token !== this.loadToken) return;
      const { docId, pages } = await this.engine.open(bytes.slice());
      if (token !== this.loadToken || this.destroyed) {
        void this.engine.close(docId);
        return;
      }

      this.teardownDocument();
      this.docId = docId;
      this.bytes = bytes;
      this.fileName = file.name;
      this.geometries = pages.map((info) => new PageGeometry(info.box, info.rotation));
      this.views = this.geometries.map(
        (geometry, i) => new PageView(i, geometry, (w, h, hidden) => this.engine.render(docId, i, w, h, hidden), this.zoom),
      );
      this.pagesEl.append(...this.views.map((view) => view.el));
      for (const view of this.views) this.visibleObserver.observe(view.el);

      this.annotations = this.initialAnnotations ?? imported;
      this.initialAnnotations = undefined;
      this.history.reset();
      this.textModels.clear();
      this.pageTexts.clear();
      this.scanInfos.clear();
      this.glyphs = this.createGlyphStore(docId);
      this.hoveredParagraph = null;
      if (this.selectedParagraph) {
        this.selectedParagraph = null;
        this.events.emit('paragraphSelect', { paragraph: null });
      }
      this.selectedId = null;
      this.pageIndex = 0;
      this.hideMessage();
      this.applyZoom(true);
      this.refresh();
      this.viewportEl.scrollTo(0, 0);

      this.events.emit('documentLoaded', { pageCount: pages.length });
      this.events.emit('textEditsChange', { edits: [] });
      this.emitAnnotations();
      this.emitHistory();
      this.events.emit('selectionChange', { id: null });
      this.events.emit('pageChange', { pageIndex: 0 });
    } catch (error) {
      if (token !== this.loadToken) return;
      this.showMessage(describeLoadError(error));
      this.events.emit('error', { error });
      throw error;
    }
  }

  get pageCount(): number {
    return this.views.length;
  }

  getPageIndex(): number {
    return this.pageIndex;
  }

  goToPage(pageIndex: number): void {
    const view = this.views[pageIndex];
    if (!view) return;
    this.viewportEl.scrollTo({ top: view.el.offsetTop - PAGES_PADDING });
  }

  /**
   * Returns the PDF with the current annotations saved as real PDF annotations
   * (editable in Acrobat, Preview and here), or burned into the pages with
   * `{ flatten: true }`.
   */
  async exportPdf(options: Pick<ExportOptions, 'flatten'> = {}): Promise<Uint8Array> {
    this.commitTextEditor();
    this.endTextEdit();
    if (!this.bytes) throw new Error('No document is open.');
    const fontBytes = this.fontBytes ? await this.fontBytes : undefined;
    try {
      // Page text first: the engine rewrites edited paragraphs in a copy of the file.
      const plans: TextWritePlan[] = await Promise.all(
        [...this.textEdits.values()].map(async ({ paragraph, session }) => {
          // Recognized text set in the scan's letters: its piece of scan, redrawn, with invisible text over it.
          const scan = this.scanEdits.get(paragraph.id);
          if (scan) {
            const { origin, xAxis, yAxis } = scan.base;
            const image = this.composeScan(session, scan);
            return scanWritePlan(paragraph, session.laidOutChars, session.layout, { image, origin, xAxis, yAxis }, scan.bold);
          }
          const plan = buildWritePlan(paragraph, session.styledChars, session.layout, this.glyphs);
          // Recognized text of a scan: its words come off the scan underneath.
          return paragraph.recognized ? { ...plan, erase: await this.scanEraseFor(paragraph) } : plan;
        }),
      );
      const fallbackFonts: Record<number, ArrayBuffer> = {};
      const invisible = plans.flatMap((plan) => plan.invisible ?? []);
      const fallbackIds = [
        ...plans.flatMap((plan) => plan.fallback.map((word) => word.font)),
        ...(invisible.length ? [FALLBACK_FONT, fallbackId('sans', 'Bold')] : []),
      ];
      for (const font of new Set(fallbackIds)) {
        const bytes = await this.glyphs.fallbackBytes(font);
        if (!bytes) throw new Error(`Could not load the fallback font for edited text (${fallbackFile(font)}).`);
        fallbackFonts[font] = bytes;
      }
      const base = plans.length ? await this.engine.writeText(this.bytes, plans, fallbackFonts) : this.bytes;
      const license = await this.license;
      return await exportPdf(base, this.annotations, {
        fontBytes,
        flatten: options.flatten,
        ...(license.status === 'valid' ? {} : { watermark: 'PDF SDK trial' }),
      });
    } catch (error) {
      this.events.emit('error', { error });
      throw error;
    }
  }

  /** Exports and saves the PDF through the browser's download flow. */
  async download(fileName = this.fileName, options: Pick<ExportOptions, 'flatten'> = {}): Promise<void> {
    const bytes = await this.exportPdf(options);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ----------------------------------------------------------- annotations

  getAnnotations(): Annotation[] {
    return structuredClone(this.annotations);
  }

  /** Replaces all annotations (undoable). */
  setAnnotations(annotations: Annotation[]): void {
    this.commit(structuredClone(annotations));
  }

  addAnnotation(annotation: Annotation): void {
    this.commit([...this.annotations, structuredClone(annotation)]);
  }

  removeAnnotation(id: string): void {
    if (!this.annotations.some((a) => a.id === id)) return;
    if (this.selectedId === id) this.select(null);
    this.commit(this.annotations.filter((a) => a.id !== id));
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.refresh();
    this.events.emit('selectionChange', { id });
    this.events.emit('colorChange', { color: this.getColor() });
  }

  deleteSelected(): void {
    if (this.selectedId) this.removeAnnotation(this.selectedId);
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  undo(): void {
    this.commitTextEditor();
    const previous = this.history.undo(this.annotations);
    if (previous) this.restore(previous);
  }

  redo(): void {
    this.commitTextEditor();
    const next = this.history.redo(this.annotations);
    if (next) this.restore(next);
  }

  // ----------------------------------------------------------- tools/style

  getTool(): ToolName {
    return this.tool;
  }

  setTool(tool: ToolName): void {
    if (this.readOnly && tool !== 'select') return;
    this.commitTextEditor();
    this.tool = tool;
    this.root.dataset.tool = tool;
    if (tool !== 'select') this.select(null);
    if (tool !== 'editText') {
      this.endTextEdit();
      this.setHoveredParagraph(null);
      this.selectParagraph(null);
    }
    this.events.emit('toolChange', { tool });
    this.events.emit('colorChange', { color: this.getColor() });
  }

  /** Color of the selected annotation, else of the active drawing tool. */
  getColor(): string | null {
    const selected = this.annotations.find((a) => a.id === this.selectedId);
    if (selected) return selected.color;
    return isDrawingTool(this.tool) ? this.colors[this.tool] : null;
  }

  /** Recolors the selection, and sets the color for new annotations of the active tool. */
  setColor(color: string): void {
    if (isDrawingTool(this.tool)) this.colors[this.tool] = color;
    if (this.selectedId) {
      this.commit(this.annotations.map((a) => (a.id === this.selectedId ? { ...a, color } : a)));
    }
    this.events.emit('colorChange', { color: this.getColor() });
  }

  /** What the licence key says and whether the editor runs as a trial. */
  getLicense(): Promise<LicenseInfo> {
    return this.license;
  }

  // ------------------------------------------------------------------ text

  /**
   * Lines, paragraphs and styles of a page, as the engine reads them. Cached
   * per page while the document is open.
   */
  getPageText(pageIndex: number): Promise<PageText> {
    if (this.docId === null) return Promise.reject(new Error('No document is open.'));
    let model = this.textModels.get(pageIndex);
    if (!model) {
      model = this.engine.text(this.docId, pageIndex);
      this.textModels.set(pageIndex, model);
      void model.then((text) => this.pageTexts.set(pageIndex, text), () => undefined);
      model.catch(() => this.textModels.delete(pageIndex));
    }
    return model;
  }

  // ----------------------------------------------------------------- pages

  /** The open document's pages, for thumbnails. */
  pages(): PageSource {
    const docId = this.docId;
    if (docId === null) throw new Error('No document is open.');
    return this.pageSource(docId, this.geometries, () => undefined);
  }

  /**
   * Opens another PDF next to the one being edited, for its thumbnails (to
   * merge its pages in). Close it when done.
   */
  async openPages(source: DocumentSource): Promise<PageSource & { bytes: Uint8Array; name: string }> {
    const file = await readSource(source);
    const { docId, pages } = await this.engine.open(file.bytes.slice(), true);
    const geometries = pages.map((info) => new PageGeometry(info.box, info.rotation));
    return { ...this.pageSource(docId, geometries, () => void this.engine.close(docId)), bytes: file.bytes, name: file.name };
  }

  /**
   * The document with its pages rearranged: in a new order, turned, left out,
   * or joined with pages of other PDFs (`others`, source 1, 2, …; source 0 is
   * this document, with its current edits and annotations).
   */
  async arrangePages(pages: ArrangedPage[], others: Uint8Array[] = []): Promise<Uint8Array> {
    const base = await this.exportPdf();
    return arrangePages([base, ...others], pages);
  }

  /** Rearranges the pages (see `arrangePages`) and goes on editing the result. Annotations stay editable. */
  async applyPageArrangement(pages: ArrangedPage[], others: Uint8Array[] = []): Promise<void> {
    const bytes = await this.arrangePages(pages, others);
    await this.load(new File([bytes as BlobPart], this.fileName, { type: 'application/pdf' }));
  }

  private pageSource(docId: number, geometries: PageGeometry[], close: () => void): PageSource {
    return {
      pageCount: geometries.length,
      sizes: geometries.map((g) => ({ width: g.width, height: g.height })),
      render: (pageIndex, width) => {
        const geometry = geometries[pageIndex];
        if (!geometry) return Promise.reject(new Error(`There is no page ${pageIndex + 1}.`));
        const height = Math.max(1, Math.round((width * geometry.height) / geometry.width));
        return this.engine.render(docId, pageIndex, Math.round(width), height).promise;
      },
      close,
    };
  }

  /** Switches the colour theme (`'auto'` follows the OS). */
  setTheme(theme: 'light' | 'dark' | 'auto'): void {
    this.root.dataset.theme = theme;
  }

  // ------------------------------------------------------------------- OCR

  /** Whether a page is a scan (a picture with no real text) and whether it already has recognized text. */
  getScanInfo(pageIndex: number): Promise<ScanInfo> {
    if (this.docId === null) return Promise.reject(new Error('No document is open.'));
    let info = this.scanInfos.get(pageIndex);
    if (!info) {
      info = this.engine.scanInfo(this.docId, pageIndex);
      this.scanInfos.set(pageIndex, info);
      info.catch(() => this.scanInfos.delete(pageIndex));
    }
    return info;
  }

  /**
   * Recognizes the text of scanned pages and adds it under the scan as an
   * invisible text layer, as Acrobat's "Recognize text" does: the page looks
   * the same, but its text can be searched, selected and copied, here and in
   * any viewer, and is part of the exported PDF. Coloured ink (stamps,
   * signatures) is ignored, the page is straightened, table cells are re-read
   * one by one, and Latin look-alikes in Cyrillic words are fixed.
   *
   * By default every scanned page without recognized text is read; pass
   * `pages` to choose. Pages with unsaved text edits are skipped.
   */
  async recognizeText(options: RecognizeOptions = {}): Promise<OcrPage[]> {
    const docId = this.docId;
    if (docId === null) throw new Error('No document is open.');
    if (this.recognizing) throw new Error('Text recognition is already running.');
    this.recognizing = true;
    const token = this.loadToken;
    const check = () => {
      if (options.signal?.aborted) throw abortError('Text recognition was cancelled.');
      if (token !== this.loadToken || this.docId !== docId) throw abortError('The document was closed.');
    };
    try {
      const edited = new Set([...this.textEdits.values()].map((e) => e.paragraph.pageIndex));
      if (this.textSession) edited.add(this.textSession.paragraph.pageIndex);
      const pages: number[] = [];
      for (const pageIndex of options.pages ?? this.views.map((_, i) => i)) {
        if (!this.views[pageIndex] || edited.has(pageIndex)) continue;
        const info = await this.getScanInfo(pageIndex);
        // Never a second layer on top of one: the text would be found twice.
        if (info.recognized) continue;
        if (options.pages || info.scanned) pages.push(pageIndex);
      }
      check();

      const engine = this.ocrEngine(options.languages ?? ['ukr', 'eng']);

      const results: OcrPage[] = [];
      const layers: { page: number; words: InvisibleWord[] }[] = [];
      for (const [done, pageIndex] of pages.entries()) {
        this.events.emit('ocrProgress', { pageIndex, done, total: pages.length });
        const started = performance.now();
        let geometry = this.geometries[pageIndex]!.scaled((options.dpi ?? OCR_DPI) / 72);
        const area = geometry.width * geometry.height;
        if (area > OCR_MAX_PIXELS) geometry = geometry.scaled(geometry.scale * Math.sqrt(OCR_MAX_PIXELS / area));
        const width = Math.round(geometry.width);
        const height = Math.round(geometry.height);
        const rgba = await this.engine.raster(docId, pageIndex, width, height);
        check();
        const result = await recognizeRaster({ width, height, rgba }, engine);
        check();
        // Keep the page's letters (not the raster): editing its text later sets it in them.
        const letters = { font: ScanFont.fromPage(result.straight.image, result.straight.words), geometry, angle: result.angle };
        this.scanFonts.set(pageIndex, Promise.resolve(letters));
        const { words, layer } = placeWords(result.words, geometry);
        results.push({
          pageIndex,
          words,
          confidence: words.reduce((sum, w) => sum + w.confidence, 0) / Math.max(1, words.length),
          cells: result.cells,
          durationMs: Math.round(performance.now() - started),
        });
        if (layer.length) layers.push({ page: pageIndex, words: layer });
      }

      if (layers.length) {
        // The sans fallback (Arimo) covers Latin and Cyrillic; the engine embeds subsets.
        const load = async (font: number) => {
          const bytes = await this.glyphs.fallbackBytes(font);
          if (!bytes) throw new Error(`Could not load the font for recognized text (${fallbackFile(font)}).`);
          return bytes;
        };
        const [regular, bold] = await Promise.all([load(FALLBACK_FONT), load(fallbackId('sans', 'Bold'))]);
        check();
        this.bytes = await this.engine.addInvisibleText(docId, layers, { regular, bold });
        for (const { page } of layers) {
          this.textModels.delete(page);
          this.pageTexts.delete(page);
          this.scanInfos.delete(page);
        }
      }
      this.events.emit('textRecognized', { pages: results });
      return results;
    } catch (error) {
      if ((error as Error).name !== 'AbortError') this.events.emit('error', { error });
      throw error;
    } finally {
      this.recognizing = false;
      this.events.emit('ocrProgress', { pageIndex: -1, done: 0, total: 0 });
    }
  }

  /** One Tesseract engine for the languages asked for, made on first use. */
  private ocrEngine(languages: string[]): TesseractEngine {
    if (this.ocr?.languages !== languages.join('+')) {
      void this.ocr?.engine.terminate();
      const paths = { workerPath: `${this.ocrUrl}worker.min.js`, corePath: this.ocrUrl, langPath: `${this.ocrUrl}lang` };
      const engine = new TesseractEngine(() => import('tesseract.js'), async (raster) => rasterCanvas(raster), paths, languages);
      this.ocr = { engine, languages: languages.join('+') };
    }
    return this.ocr.engine;
  }

  /**
   * The letters of a scanned page: kept from `recognizeText`, or read now
   * (a page recognized before the file was opened, by us or another tool).
   * Null when the page can't be read; editing then falls back to Arimo.
   */
  private scanFontFor(pageIndex: number): Promise<PageScanFont | null> {
    let letters = this.scanFonts.get(pageIndex);
    if (!letters) {
      letters = this.readScanLetters(pageIndex).catch(() => null);
      this.scanFonts.set(pageIndex, letters);
    }
    return letters;
  }

  private async readScanLetters(pageIndex: number): Promise<PageScanFont | null> {
    const docId = this.docId;
    if (docId === null) return null;
    let geometry = this.geometries[pageIndex]!.scaled(OCR_DPI / 72);
    const area = geometry.width * geometry.height;
    if (area > OCR_MAX_PIXELS) geometry = geometry.scaled(geometry.scale * Math.sqrt(OCR_MAX_PIXELS / area));
    const width = Math.round(geometry.width);
    const height = Math.round(geometry.height);
    const rgba = await this.engine.raster(docId, pageIndex, width, height);
    const result = await recognizeRaster({ width, height, rgba }, this.ocrEngine(this.ocr?.languages.split('+') ?? ['ukr', 'eng']));
    return { font: ScanFont.fromPage(result.straight.image, result.straight.words), geometry, angle: result.angle };
  }

  /** The paragraph picked with the Edit text tool. */
  getSelectedParagraph(): TextParagraph | null {
    return this.selectedParagraph;
  }

  // ------------------------------------------------------------------ zoom

  getZoom(): number {
    return this.zoom;
  }

  setZoom(zoom: ZoomValue): void {
    this.zoomMode = typeof zoom === 'number' ? clampZoom(zoom) : zoom;
    this.applyZoom();
  }

  zoomIn(): void {
    this.setZoom(ZOOM_STEPS.find((step) => step > this.zoom * 1.01) ?? MAX_ZOOM);
  }

  zoomOut(): void {
    this.setZoom([...ZOOM_STEPS].reverse().find((step) => step < this.zoom / 1.01) ?? MIN_ZOOM);
  }

  // --------------------------------------------------------------- teardown

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadToken++;
    cancelAnimationFrame(this.scrollFrame);
    this.visibleObserver.disconnect();
    this.resizeObserver.disconnect();
    this.teardownDocument();
    this.engine.terminate();
    void this.ocr?.engine.terminate();
    this.toolbar?.destroy();
    this.root.remove();
    this.events.clear();
  }

  // ======================================================== internals

  private teardownDocument(): void {
    this.textSession?.destroy();
    this.textSession = null;
    for (const edit of this.textEdits.values()) edit.session.destroy();
    this.textEdits.clear();
    for (const patch of this.scanPatches.values()) void patch.then(({ href }) => URL.revokeObjectURL(href), () => undefined);
    this.scanPatches.clear();
    for (const edit of this.scanEdits.values()) if (edit.href) URL.revokeObjectURL(edit.href);
    this.scanEdits.clear();
    this.scanFonts.clear();
    this.textEditor?.el.remove();
    this.textEditor = null;
    this.interaction = null;
    for (const view of this.views) {
      this.visibleObserver.unobserve(view.el);
      view.destroy();
    }
    this.views = [];
    this.visible.clear();
    if (this.docId !== null) void this.engine.close(this.docId);
    this.docId = null;
    this.bytes = null;
  }

  private async loadFont(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the font (HTTP ${response.status}).`);
    const bytes = await response.arrayBuffer();
    // Same font in the viewer as in the exported file, so text doesn't shift on export.
    try {
      const face = new FontFace('pdfsdk-text', bytes.slice(0));
      await face.load();
      document.fonts.add(face);
      if (!this.destroyed) this.refresh();
    } catch (error) {
      this.events.emit('error', { error });
    }
    return bytes;
  }

  private measure = (text: string, fontSize: number): number => {
    if (!this.measureCtx) return text.length * fontSize * 0.55;
    this.measureCtx.font = `${fontSize}px ${TEXT_FONT_FAMILY}`;
    return this.measureCtx.measureText(text).width;
  };

  private showMessage(text: string): void {
    this.messageEl.textContent = text;
    this.messageEl.hidden = false;
  }

  private hideMessage(): void {
    this.messageEl.hidden = true;
  }

  private renderView(view: PageView): void {
    view.render().catch((error: unknown) => this.events.emit('error', { error }));
  }

  private fitWidthZoom(): number {
    const widest = Math.max(...this.views.map((view) => view.width));
    const available = this.viewportEl.clientWidth - PAGES_PADDING * 2;
    return clampZoom(available / widest);
  }

  private applyZoom(force = false): void {
    if (this.views.length === 0) return;
    const target = this.zoomMode === 'fit-width' ? this.fitWidthZoom() : this.zoomMode;
    if (!force && Math.abs(target - this.zoom) < 0.001) return;
    this.commitTextEditor();

    // Keep the same spot of the page at the top of the viewport. Anchoring to the
    // page (not to a scroll ratio) stays correct when the container itself resizes.
    const vp = this.viewportEl;
    const anchor = this.views.find((view) => view.el.offsetTop + view.el.offsetHeight > vp.scrollTop) ?? this.views[0]!;
    const offset = (vp.scrollTop - anchor.el.offsetTop) / anchor.el.offsetHeight;
    const ratioX = (vp.scrollLeft + vp.clientWidth / 2) / vp.scrollWidth;
    this.zoom = target;
    for (const view of this.views) view.setScale(target);
    vp.scrollTop = anchor.el.offsetTop + offset * anchor.el.offsetHeight;
    vp.scrollLeft = ratioX * vp.scrollWidth - vp.clientWidth / 2;

    for (const view of this.visible) this.renderView(view);
    this.textSession?.refresh();
    this.events.emit('zoomChange', { zoom: target });
  }

  private refresh(): void {
    const byPage = new Map<number, Annotation[]>();
    for (const annotation of this.annotations) {
      if (annotation.id === this.textEditor?.existing?.id) continue;
      const list = byPage.get(annotation.pageIndex) ?? [];
      list.push(annotation);
      byPage.set(annotation.pageIndex, list);
    }
    for (const view of this.views) {
      renderPageAnnotations(view, byPage.get(view.index) ?? [], this.selectedId, this.measure);
    }
  }

  private commit(next: Annotation[]): void {
    this.history.push(this.annotations);
    this.annotations = next;
    this.refresh();
    this.emitAnnotations();
    this.emitHistory();
  }

  private restore(snapshot: Annotation[]): void {
    this.annotations = snapshot;
    if (this.selectedId && !snapshot.some((a) => a.id === this.selectedId)) {
      this.selectedId = null;
      this.events.emit('selectionChange', { id: null });
    }
    this.refresh();
    this.emitAnnotations();
    this.emitHistory();
  }

  private emitAnnotations(): void {
    this.events.emit('annotationsChange', { annotations: this.getAnnotations() });
  }

  private emitHistory(): void {
    this.events.emit('historyChange', { canUndo: this.canUndo, canRedo: this.canRedo });
  }

  private newAnnotationBase(pageIndex: number, tool: DrawingTool) {
    return {
      id: createId(),
      pageIndex,
      color: this.colors[tool],
      // Whole seconds: PDF dates can't hold milliseconds, so a saved file reopens with the same value.
      createdAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      ...(this.author ? { author: this.author } : {}),
    };
  }

  private async paragraphAt(view: PageView, point: Point): Promise<TextParagraph | null> {
    // Edited paragraphs may have grown or moved: their sessions know the current extent.
    for (const session of [this.textSession, ...[...this.textEdits.values()].map((e) => e.session)]) {
      if (session && session.view === view && session.contains(point, PARAGRAPH_HIT_PADDING)) return session.paragraph;
    }
    const model = await this.getPageText(view.index);
    const pad = PARAGRAPH_HIT_PADDING;
    return (
      model.paragraphs.find(
        ({ box }) =>
          point[0] >= box.x - pad &&
          point[0] <= box.x + box.width + pad &&
          point[1] >= box.y - pad &&
          point[1] <= box.y + box.height + pad,
      ) ?? null
    );
  }

  private setHoveredParagraph(paragraph: TextParagraph | null): void {
    if (paragraph?.id === this.hoveredParagraph?.id) return;
    const previous = this.hoveredParagraph;
    this.hoveredParagraph = paragraph;
    this.root.dataset.hover = paragraph ? (paragraph.editable ? 'paragraph' : 'readonly') : '';
    this.drawParagraphOutlines(previous, paragraph);
  }

  private selectParagraph(paragraph: TextParagraph | null): void {
    if (paragraph?.id === this.selectedParagraph?.id) return;
    const previous = this.selectedParagraph;
    this.selectedParagraph = paragraph;
    this.drawParagraphOutlines(previous, paragraph);
    this.events.emit('paragraphSelect', { paragraph });
  }

  /** Redraws the outline layer of every page touched by the old or new hover/selection. */
  private drawParagraphOutlines(...touched: (TextParagraph | null)[]): void {
    const pages = new Set(
      [...touched, this.hoveredParagraph, this.selectedParagraph].filter(Boolean).map((p) => p!.pageIndex),
    );
    for (const pageIndex of pages) {
      const view = this.views[pageIndex];
      if (!view) continue;
      const outlines = [this.hoveredParagraph, this.selectedParagraph]
        .filter((p): p is TextParagraph => p?.pageIndex === pageIndex)
        .filter((p, i, list) => list.findIndex((q) => q.id === p.id) === i)
        .map((p) => {
          const outline = paragraphOutline(view, p, this.paragraphBox(p), p.id === this.selectedParagraph?.id);
          if (this.overlapsOtherText(p)) {
            outline.classList.add('pdfsdk-paragraph--overflow');
            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = 'The edited text now overlaps other content on the page.';
            outline.append(title);
          }
          return outline;
        });
      view.textChrome.replaceChildren(...outlines);
    }
  }

  /** Edited text grows downwards without moving what's below (as in Acrobat); flag when it runs into it. */
  private overlapsOtherText(paragraph: TextParagraph): boolean {
    const session = this.textSession?.paragraph.id === paragraph.id ? this.textSession : this.textEdits.get(paragraph.id)?.session;
    const model = this.pageTexts.get(paragraph.pageIndex);
    if (!session || !model) return false;
    const inset = 1;
    const meets = (a: Rect, b: Rect) =>
      a.x + inset < b.x + b.width && b.x + inset < a.x + a.width && a.y + inset < b.y + b.height && b.y + inset < a.y + a.height;
    // Only new collisions count: loose text boxes of neighbours often touch already.
    return model.paragraphs.some(
      (other) => other.id !== paragraph.id && meets(other.box, session.box) && !meets(other.box, paragraph.box),
    );
  }

  private paragraphBox(paragraph: TextParagraph): Rect {
    if (this.textSession?.paragraph.id === paragraph.id) return this.textSession.box;
    return this.textEdits.get(paragraph.id)?.session.box ?? paragraph.box;
  }

  // ------------------------------------------------------ text editing

  private createGlyphStore(docId: number): GlyphStore {
    return new GlyphStore(
      (source: FontSource, chars) => this.engine.glyphs(docId, source.page, source.object, chars),
      async (file) => {
        const response = await fetch(`${this.fallbackFontsUrl}${file}`);
        if (!response.ok) throw new Error(`Could not load the fallback font ${file} (HTTP ${response.status}).`);
        return response.arrayBuffer();
      },
    );
  }

  /** Page objects to leave out of a page's bitmap: those of every paragraph being or having been edited. */
  private hiddenObjects(pageIndex: number): number[] {
    const sessions = [this.textSession, ...[...this.textEdits.values()].map((e) => e.session)];
    return sessions
      .filter((s): s is TextEditSession => s?.paragraph.pageIndex === pageIndex)
      .flatMap((s) => s.paragraph.lines.flatMap((l) => l.chars.map((c) => c.object)));
  }

  private updateHidden(pageIndex: number): void {
    const view = this.views[pageIndex];
    if (!view) return;
    view.setHidden(this.hiddenObjects(pageIndex));
    if (this.visible.has(view)) this.renderView(view);
  }

  /** Opens a paragraph for editing in place, then puts the caret where the user clicked. */
  private async startTextEdit(paragraph: TextParagraph, point: Point, event: PointerEvent): Promise<void> {
    if (!paragraph.editable || this.readOnly) return;
    const view = this.views[paragraph.pageIndex];
    if (!view || this.textSession?.paragraph.id === paragraph.id) return;
    // Clicks that arrive while the session opens (a double click) apply once it exists.
    if (this.opening?.id === paragraph.id) {
      this.opening = { ...this.opening, point, event, clicks: this.opening.clicks + 1 };
      return;
    }
    this.endTextEdit();
    const token = ++this.openToken;
    this.opening = { id: paragraph.id, point, event, token, clicks: 1 };

    // Load every glyph the paragraph uses (plus common characters) before showing it.
    const fonts = new Map<number, { source: FontSource; chars: Set<string> }>();
    for (const char of paragraph.lines.flatMap((l) => l.chars)) {
      const entry = fonts.get(char.font) ?? { source: { page: paragraph.pageIndex, object: char.object }, chars: new Set() };
      for (const c of char.text) entry.chars.add(c);
      fonts.set(char.font, entry);
    }
    const store = this.glyphs;
    const page = await this.getPageText(paragraph.pageIndex);
    store.registerFonts(page.fonts);
    await Promise.all([...fonts].map(([font, { source, chars }]) => store.ensure(font, source, chars)));
    // Recognized text is set in the scan's own letters. Without them (the page can't be
    // read) it is set anew in a fallback font over the scan with its words erased.
    const scan = paragraph.recognized
      ? (this.scanEdits.get(paragraph.id) ?? (await this.prepareScanEdit(paragraph, page.block, page.fonts).catch(() => null)))
      : null;
    const background = paragraph.recognized && !scan ? this.scanPatch(paragraph).catch(() => null) : null;
    if (paragraph.recognized && !scan) await Promise.all([...fonts.keys()].map((font) => store.fallbackBytes(store.fallbackFor(font))));
    const ready = await background;
    const opening = this.opening;
    if (opening?.token !== token) return;
    this.opening = null;
    if (this.selectedParagraph?.id !== paragraph.id || this.tool !== 'editText' || store !== this.glyphs) return;

    const previous = this.textEdits.get(paragraph.id);
    const initial: StyledChar[] = previous
      ? previous.session.styledChars
      : scan
        ? scanChars(paragraph, scan.font)
        : paragraph.recognized
          ? recognizedChars(paragraph, (font) => store.fallbackFor(font))
          : paragraphChars(paragraph, (style, char) => store.advance(style, char));
    previous?.session.destroy();
    this.textEdits.delete(paragraph.id);
    if (scan) scan.painted = null;
    this.textSession = new TextEditSession(view, paragraph, paragraphFrame(paragraph, page.block), store, {
      onChange: () => this.drawParagraphOutlines(paragraph),
      onExit: () => this.endTextEdit(),
      ...(scan ? { paint: (session: TextEditSession) => this.paintScan(session, scan) } : {}),
    }, initial);
    this.root.dataset.editing = 'text';
    if (ready) this.textSession.setBackground({ href: ready.href, ...ready.patch });
    this.updateHidden(paragraph.pageIndex);
    this.textSession.pointerDown(opening.point, opening.event, opening.clicks);
    this.textSession.pointerUp();
  }

  /** Gets a recognized paragraph ready to edit in its scan's letters (null without them). */
  private async prepareScanEdit(
    paragraph: TextParagraph,
    block: PageText['block'],
    fonts: PageText['fonts'],
  ): Promise<ScanEdit | null> {
    const docId = this.docId;
    const letters = await this.scanFontFor(paragraph.pageIndex);
    if (!letters || docId === null) return null;
    const chars = paragraph.lines.flatMap((l) => l.chars);
    const bold = chars.filter((c) => (fonts[c.font]?.weight ?? 400) >= 600).length > chars.length / 2;
    const style = scanStyle(letters, paragraph, bold);
    const fallback = fallbackId('sans', bold ? 'Bold' : 'Regular');
    await this.glyphs.fallbackBytes(fallback);
    const font = this.nextScanFont--;
    this.glyphs.registerCustomFont(font, scanCustomFont(letters, style, fallback, scanTracking(letters, style, paragraph)));
    // Room for the text to grow: the column and two lines below.
    const erase = growErase(await this.scanEraseFor(paragraph), paragraphFrame(paragraph, block));
    const base = await this.engine.scanPatch(docId, paragraph.pageIndex, erase);
    const edit: ScanEdit = { page: letters, style, bold, font, fallback, base, href: null, painted: null, outlines: new Map() };
    this.scanEdits.set(paragraph.id, edit);
    return edit;
  }

  /** The paragraph's piece of scan with its current text drawn in. */
  private composeScan(session: TextEditSession, edit: ScanEdit): Raster {
    return composeScanParagraph({
      page: edit.page,
      style: edit.style,
      base: edit.base,
      paragraph: session.paragraph,
      chars: session.laidOutChars,
      layout: session.layout,
      fallback: (char) => this.outlineGlyph(edit, char),
    });
  }

  /** Redraws a scan paragraph after its text changed (once per change), under the session's caret. */
  private paintScan(session: TextEditSession, edit: ScanEdit): void {
    const layout = session.layout;
    if (edit.painted === layout) return;
    edit.painted = layout;
    // After the current event, so a burst of renders draws once.
    queueMicrotask(() => {
      if (edit.painted !== layout) return;
      const image = this.composeScan(session, edit);
      const canvas = new OffscreenCanvas(image.width, image.height);
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
      void canvas.convertToBlob({ type: 'image/png' }).then((blob) => {
        const href = URL.createObjectURL(blob);
        // A newer layout was drawn meanwhile, or the edit is gone.
        if (edit.painted !== layout || !this.scanEdits.has(session.paragraph.id)) {
          URL.revokeObjectURL(href);
          return;
        }
        if (edit.href) URL.revokeObjectURL(edit.href);
        edit.href = href;
        const { origin, xAxis, yAxis } = edit.base;
        session.setBackground({ href, width: image.width, height: image.height, origin, xAxis, yAxis });
      });
    });
  }

  /**
   * A letter the scan lacks, drawn from the fallback font's outline at the
   * scan's size, as a grey image like the scan's own letters.
   */
  private outlineGlyph(edit: ScanEdit, char: string): ScanGlyph | null {
    if (edit.outlines.has(char)) return edit.outlines.get(char)!;
    const { glyph } = this.glyphs.resolve(edit.fallback, char);
    let result: ScanGlyph | null = null;
    if (glyph?.path) {
      const size = edit.style.size;
      const scale = size / glyph.unitsPerEm;
      const width = Math.ceil(glyph.advance * size) + 6;
      const height = Math.ceil(size * 1.6);
      const baseline = Math.round(size * 1.2);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(scale, 0, 0, -scale, 3, baseline);
      ctx.fillStyle = '#000';
      ctx.fill(new Path2D(glyph.path));
      const data = ctx.getImageData(0, 0, width, height).data;
      let x0 = width;
      let y0 = height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4]! >= 250) continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      if (x1 >= 0) {
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        const pixels = new Uint8ClampedArray(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = data[((y0 + y) * width + x0 + x) * 4]!;
        const box = { x0: 0, y0: 0, x1: 0, y1: 0 };
        result = { char, width: w, height: h, pixels, top: y0 - baseline, size, bold: edit.bold, confidence: 0, ink: 0, line: -1, at: box };
      }
    }
    edit.outlines.set(char, result);
    return result;
  }

  private scanEraseFor(paragraph: TextParagraph): Promise<ScanErase> {
    // Stored at the scan's own resolution when it has to be rendered.
    return this.getScanInfo(paragraph.pageIndex).then(
      (info) => scanErase(paragraph, Math.min(400, Math.max(150, info.dpi || OCR_DPI)) / 72),
      () => scanErase(paragraph, OCR_DPI / 72),
    );
  }

  /** The scan under a recognized paragraph with its words erased, as an image URL (cached per paragraph). */
  private scanPatch(paragraph: TextParagraph): Promise<{ href: string; patch: Omit<ScanPatch, 'image'> & { width: number; height: number } }> {
    const docId = this.docId;
    if (docId === null) return Promise.reject(new Error('No document is open.'));
    let patch = this.scanPatches.get(paragraph.id);
    if (!patch) {
      patch = this.scanEraseFor(paragraph)
        .then((erase) => this.engine.scanPatch(docId, paragraph.pageIndex, erase))
        .then(async ({ image, ...placement }) => {
          const canvas = new OffscreenCanvas(image.width, image.height);
          canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
          const href = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
          return { href, patch: { ...placement, width: image.width, height: image.height } };
        });
      this.scanPatches.set(paragraph.id, patch);
      patch.catch((error: unknown) => {
        this.scanPatches.delete(paragraph.id);
        this.events.emit('error', { error });
      });
    }
    return patch;
  }

  /** Leaves the paragraph being edited; changed text stays on the page (written into the PDF on save, next stage). */
  private endTextEdit(): void {
    this.opening = null;
    const session = this.textSession;
    if (!session) return;
    this.textSession = null;
    this.textDragging = false;
    delete this.root.dataset.editing;
    if (session.changed) {
      session.freeze();
      this.textEdits.set(session.paragraph.id, { paragraph: session.paragraph, session });
    } else {
      session.destroy();
    }
    this.updateHidden(session.paragraph.pageIndex);
    this.drawParagraphOutlines(session.paragraph);
    this.events.emit('textEditsChange', { edits: this.getTextEdits() });
    this.root.focus({ preventScroll: true });
  }

  /** Paragraphs whose text was changed in this session of the editor. */
  getTextEdits(): { paragraphId: string; pageIndex: number; text: string }[] {
    return [...this.textEdits.values()].map(({ paragraph, session }) => ({
      paragraphId: paragraph.id,
      pageIndex: paragraph.pageIndex,
      text: session.text,
    }));
  }

  private viewFromEvent(event: Event): PageView | undefined {
    const pageEl = (event.target as Element | null)?.closest?.('.pdfsdk-page') as HTMLElement | null;
    return pageEl ? this.views[Number(pageEl.dataset.pageIndex)] : undefined;
  }

  private annotationAt(view: PageView, point: Point): Annotation | undefined {
    const tolerance = 4 / this.zoom;
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const annotation = this.annotations[i]!;
      if (annotation.pageIndex === view.index && hitTest(annotation, point, tolerance, this.measure)) return annotation;
    }
    return undefined;
  }

  private buildShape(interaction: Extract<Interaction, { kind: 'shape' }>): Annotation {
    const rect = rectFromPoints(interaction.start, interaction.current);
    const base = this.newAnnotationBase(interaction.view.index, interaction.tool);
    return interaction.tool === 'highlight'
      ? { ...base, type: 'highlight', rect, opacity: 0.4 }
      : { ...base, type: 'rectangle', rect, strokeWidth: 2 };
  }

  // ------------------------------------------------------- pointer input

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.target === this.textEditor?.el) return;
    this.commitTextEditor();
    const view = this.viewFromEvent(event);
    if (!view) {
      this.select(null);
      return;
    }
    this.root.focus({ preventScroll: true });
    const point = view.clientToPdf(event.clientX, event.clientY);

    switch (this.tool) {
      case 'editText': {
        event.preventDefault();
        const session = this.textSession;
        if (session && session.view === view && session.contains(point)) {
          session.pointerDown(point, event);
          this.textDragging = true;
          view.overlay.setPointerCapture(event.pointerId);
          return;
        }
        // Leave an open paragraph; one still opening is kept, so a double click doesn't cancel it.
        if (this.textSession) this.endTextEdit();
        void this.paragraphAt(view, point).then(
          (paragraph) => {
            this.selectParagraph(paragraph);
            if (paragraph?.editable) return this.startTextEdit(paragraph, point, event);
          },
          (error: unknown) => this.events.emit('error', { error }),
        );
        return;
      }
      case 'select': {
        const hit = this.annotationAt(view, point);
        this.select(hit?.id ?? null);
        if (!hit || this.readOnly) return;
        this.interaction = { kind: 'move', view, id: hit.id, start: point, before: this.annotations, moved: false };
        break;
      }
      case 'highlight':
      case 'rectangle':
        this.interaction = { kind: 'shape', view, tool: this.tool, start: point, current: point };
        break;
      case 'ink':
        this.interaction = { kind: 'ink', view, points: [point] };
        this.drawInkDraft(this.interaction);
        break;
      case 'text': {
        event.preventDefault();
        // Put the click roughly in the middle of the first line.
        const position: Point = [point[0], round(point[1] + DEFAULT_FONT_SIZE * 0.6)];
        this.openTextEditor(view, position, null);
        return;
      }
    }
    event.preventDefault();
    view.overlay.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const interaction = this.interaction;
    if (!interaction) {
      if (this.tool === 'editText' && this.textDragging && this.textSession) {
        const { view } = this.textSession;
        this.textSession.pointerMove(view.clientToPdf(event.clientX, event.clientY));
        return;
      }
      if (this.tool === 'editText') {
        const view = this.viewFromEvent(event);
        const token = ++this.hoverToken;
        if (!view) {
          this.setHoveredParagraph(null);
          return;
        }
        void this.paragraphAt(view, view.clientToPdf(event.clientX, event.clientY)).then(
          (paragraph) => {
            if (token === this.hoverToken) this.setHoveredParagraph(paragraph);
          },
          // Hover is best effort; a real failure surfaces on click.
          () => undefined,
        );
        return;
      }
      if (this.tool === 'select' && !this.readOnly) {
        const view = this.viewFromEvent(event);
        const hit = view && this.annotationAt(view, view.clientToPdf(event.clientX, event.clientY));
        this.root.dataset.hover = hit ? 'annotation' : '';
      }
      return;
    }
    const point = interaction.view.clientToPdf(event.clientX, event.clientY);

    switch (interaction.kind) {
      case 'shape':
        interaction.current = point;
        interaction.view.draft.replaceChildren(annotationElement(this.buildShape(interaction)));
        break;
      case 'ink': {
        const last = interaction.points[interaction.points.length - 1]!;
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.75 / this.zoom) return;
        interaction.points.push(point);
        this.drawInkDraft(interaction);
        break;
      }
      case 'move': {
        const dx = point[0] - interaction.start[0];
        const dy = point[1] - interaction.start[1];
        if (!interaction.moved && Math.hypot(dx, dy) < 2 / this.zoom) return;
        interaction.moved = true;
        // Live preview without history entries; the whole drag becomes one undo step on release.
        this.annotations = interaction.before.map((a) => (a.id === interaction.id ? translate(a, dx, dy) : a));
        this.refresh();
        break;
      }
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.textDragging) {
      this.textDragging = false;
      this.textSession?.pointerUp();
      const view = this.textSession?.view;
      if (view?.overlay.hasPointerCapture(event.pointerId)) view.overlay.releasePointerCapture(event.pointerId);
      return;
    }
    const interaction = this.interaction;
    if (!interaction) return;
    this.interaction = null;
    interaction.view.draft.replaceChildren();
    if (interaction.view.overlay.hasPointerCapture(event.pointerId)) {
      interaction.view.overlay.releasePointerCapture(event.pointerId);
    }

    switch (interaction.kind) {
      case 'shape': {
        const shape = this.buildShape(interaction);
        if (shape.type !== 'ink' && shape.type !== 'text' && shape.rect.width + shape.rect.height > 4) {
          this.commit([...this.annotations, shape]);
        }
        break;
      }
      case 'ink':
        this.commit([
          ...this.annotations,
          { ...this.newAnnotationBase(interaction.view.index, 'ink'), type: 'ink', paths: [interaction.points], strokeWidth: 2 },
        ]);
        break;
      case 'move':
        if (interaction.moved) {
          this.history.push(interaction.before);
          this.emitAnnotations();
          this.emitHistory();
        }
        break;
    }
  };

  private onPointerCancel = (): void => {
    const interaction = this.interaction;
    if (!interaction) return;
    this.interaction = null;
    interaction.view.draft.replaceChildren();
    if (interaction.kind === 'move') {
      this.annotations = interaction.before;
      this.refresh();
    }
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.tool !== 'select' || this.readOnly) return;
    const view = this.viewFromEvent(event);
    if (!view) return;
    const hit = this.annotationAt(view, view.clientToPdf(event.clientX, event.clientY));
    if (hit?.type === 'text') this.openTextEditor(view, hit.position, hit);
  };

  private drawInkDraft(interaction: Extract<Interaction, { kind: 'ink' }>): void {
    const draft = annotationElement({
      ...this.newAnnotationBase(interaction.view.index, 'ink'),
      type: 'ink',
      paths: [interaction.points],
      strokeWidth: 2,
    });
    interaction.view.draft.replaceChildren(draft);
  }

  // ------------------------------------------------------------ text box

  private openTextEditor(view: PageView, position: Point, existing: TextAnnotation | null): void {
    this.commitTextEditor();
    const fontSize = existing?.fontSize ?? DEFAULT_FONT_SIZE;
    const color = existing?.color ?? this.colors.text;
    const el = document.createElement('textarea');
    el.className = 'pdfsdk-text-editor';
    el.value = existing?.text ?? '';
    el.spellcheck = true;
    el.setAttribute('aria-label', 'Text annotation');
    el.style.color = color;
    el.style.fontFamily = TEXT_FONT_FAMILY;
    this.textEditor = { el, view, position, fontSize, color, existing };
    if (existing) this.select(null);
    this.layoutTextEditor();
    view.el.append(el);
    this.refresh();

    el.addEventListener('input', () => this.layoutTextEditor());
    el.addEventListener('blur', () => this.commitTextEditor());
    el.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        el.value = existing?.text ?? '';
        this.commitTextEditor();
        this.root.focus({ preventScroll: true });
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        this.commitTextEditor();
        this.root.focus({ preventScroll: true });
      }
    });
    // Synchronous on purpose: pointerdown is prevented, so nothing steals focus
    // afterwards, and rAF would not run at all in a background tab.
    el.focus({ preventScroll: true });
  }

  private layoutTextEditor(): void {
    const state = this.textEditor;
    if (!state) return;
    const { el, view, position, fontSize } = state;
    const size = fontSize * this.zoom;
    const lines = el.value.split('\n');
    const [left, top] = view.pdfToElement(position);
    const width = Math.max(...lines.map((line) => this.measure(line, fontSize)), fontSize * 4) * this.zoom;
    el.style.fontSize = `${size}px`;
    el.style.left = `${left - 1}px`;
    // Textarea glyphs sit lower than the SVG baseline formula; nudge so text doesn't jump on commit.
    el.style.top = `${top - size * (1.05 - TEXT_ASCENT) - 1}px`;
    el.style.width = `${width + size}px`;
    el.style.height = `${lines.length * TEXT_LINE_HEIGHT * size + 2}px`;
  }

  private commitTextEditor(): void {
    const state = this.textEditor;
    if (!state) return;
    this.textEditor = null;
    state.el.remove();
    const text = state.el.value.replace(/\s+$/, '');
    const { existing } = state;

    if (existing) {
      if (!text) this.commit(this.annotations.filter((a) => a.id !== existing.id));
      else if (text !== existing.text) {
        this.commit(this.annotations.map((a) => (a.id === existing.id ? { ...existing, text } : a)));
      } else this.refresh();
      return;
    }
    if (!text) return;
    this.commit([
      ...this.annotations,
      {
        ...this.newAnnotationBase(state.view.index, 'text'),
        color: state.color,
        type: 'text',
        position: state.position,
        text,
        fontSize: state.fontSize,
      },
    ]);
  }

  // ------------------------------------------------------- keyboard etc.

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    } else if (mod && key === 'y') {
      event.preventDefault();
      this.redo();
    } else if (mod && (key === '=' || key === '+')) {
      event.preventDefault();
      this.zoomIn();
    } else if (mod && key === '-') {
      event.preventDefault();
      this.zoomOut();
    } else if ((key === 'delete' || key === 'backspace') && this.selectedId && !this.readOnly) {
      event.preventDefault();
      this.deleteSelected();
    } else if (key === 'escape') {
      if (this.textSession) this.endTextEdit();
      else if (this.selectedParagraph) this.selectParagraph(null);
      else if (this.selectedId) this.select(null);
      else this.setTool('select');
    } else if (key.startsWith('arrow') && this.selectedId && !this.readOnly) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowdown' ? -step : key === 'arrowup' ? step : 0;
      this.commit(this.annotations.map((a) => (a.id === this.selectedId ? translate(a, dx, dy) : a)));
    } else if (!mod && !event.altKey && SHORTCUTS[key]) {
      this.setTool(SHORTCUTS[key]);
    }
  };

  private onScroll = (): void => {
    cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => {
      const probe = this.viewportEl.scrollTop + this.viewportEl.clientHeight * 0.35;
      const current = this.views.findIndex((view) => view.el.offsetTop + view.el.offsetHeight > probe);
      const pageIndex = current === -1 ? this.views.length - 1 : current;
      if (pageIndex !== this.pageIndex && pageIndex >= 0) {
        this.pageIndex = pageIndex;
        this.events.emit('pageChange', { pageIndex });
      }
    });
  };

  private onWheel = (event: WheelEvent): void => {
    // Pinch on trackpads arrives as ctrl+wheel.
    if (!event.ctrlKey || this.views.length === 0) return;
    event.preventDefault();
    this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.01));
  };
}
