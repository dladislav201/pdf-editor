import { EngineClient } from './engine/client';
import { PageGeometry } from './engine/page-geometry';
import { Emitter } from './events';
import { exportPdf, type ExportOptions } from './export';
import { TEXT_ASCENT, TEXT_LINE_HEIGHT, hitTest, rectFromPoints, round, translate } from './geometry';
import { History } from './history';
import { importAnnotations } from './pdf/read-annotations';
import { PageView } from './page-view';
import { TEXT_FONT_FAMILY, annotationElement, renderPageAnnotations } from './render-annotations';
import { injectStyles } from './styles';
import { createToolbar } from './toolbar';
import type {
  Annotation,
  DocumentSource,
  EditorEventMap,
  EditorOptions,
  Point,
  TextAnnotation,
  ToolName,
  ZoomValue,
} from './types';

type DrawingTool = Exclude<ToolName, 'select'>;

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
const SHORTCUTS: Record<string, ToolName> = { v: 'select', h: 'highlight', r: 'rectangle', d: 'ink', t: 'text' };

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
    const { workerUrl } = options;
    this.engine = new EngineClient(
      () =>
        workerUrl
          ? new Worker(workerUrl, { type: 'module' })
          : // Literal `new URL(…, import.meta.url)` so bundlers emit the worker as its own file.
            new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' }),
      `${this.assetsUrl}pdfium.wasm`,
    );

    this.root = document.createElement('div');
    this.root.className = 'pdfsdk-root';
    this.root.tabIndex = 0;
    this.root.dataset.theme = options.theme ?? 'auto';
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
      this.views = pages.map(
        (info, i) =>
          new PageView(i, new PageGeometry(info.box, info.rotation), (w, h) => this.engine.render(docId, i, w, h), this.zoom),
      );
      this.pagesEl.append(...this.views.map((view) => view.el));
      for (const view of this.views) this.visibleObserver.observe(view.el);

      this.annotations = this.initialAnnotations ?? imported;
      this.initialAnnotations = undefined;
      this.history.reset();
      this.selectedId = null;
      this.pageIndex = 0;
      this.hideMessage();
      this.applyZoom(true);
      this.refresh();
      this.viewportEl.scrollTo(0, 0);

      this.events.emit('documentLoaded', { pageCount: pages.length });
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
    if (!this.bytes) throw new Error('No document is open.');
    const fontBytes = this.fontBytes ? await this.fontBytes : undefined;
    try {
      return await exportPdf(this.bytes, this.annotations, { fontBytes, flatten: options.flatten });
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
    this.events.emit('toolChange', { tool });
    this.events.emit('colorChange', { color: this.getColor() });
  }

  /** Color of the selected annotation, else of the active drawing tool. */
  getColor(): string | null {
    const selected = this.annotations.find((a) => a.id === this.selectedId);
    if (selected) return selected.color;
    return this.tool === 'select' ? null : this.colors[this.tool];
  }

  /** Recolors the selection, and sets the color for new annotations of the active tool. */
  setColor(color: string): void {
    if (this.tool !== 'select') this.colors[this.tool] = color;
    if (this.selectedId) {
      this.commit(this.annotations.map((a) => (a.id === this.selectedId ? { ...a, color } : a)));
    }
    this.events.emit('colorChange', { color: this.getColor() });
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
    this.toolbar?.destroy();
    this.root.remove();
    this.events.clear();
  }

  // ======================================================== internals

  private teardownDocument(): void {
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
      if (this.selectedId) this.select(null);
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
