import type { RenderHandle } from './engine/client';
import type { PageGeometry } from './engine/page-geometry';
import type { Point } from './types';

/** Asks the engine for a bitmap of this page at a pixel size, leaving out `hidden` page objects. */
export type PageRenderer = (width: number, height: number, hidden: number[]) => RenderHandle;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Above this many canvas pixels mobile Safari silently refuses to draw. */
const MAX_CANVAS_PIXELS = 16_777_216;

/**
 * One page: a canvas with the rendered PDF content and an SVG overlay for
 * annotations. The overlay works in PDF user space (its group carries the
 * page transform), so zooming only resizes it, nothing is redrawn.
 */
export class PageView {
  readonly el: HTMLDivElement;
  readonly overlay: SVGSVGElement;
  /** Annotation elements go here, in PDF user-space coordinates. */
  readonly content: SVGGElement;
  /** Search results, under everything else, in user space. */
  readonly marks: SVGGElement;
  /** Page text being edited, drawn from glyph outlines in user space, under the annotations. */
  readonly textLayer: SVGGElement;
  /** Shapes that are being drawn right now. */
  readonly draft: SVGGElement;
  /** Selection outline; drawn in overlay pixels so it is not mirrored with the content. */
  readonly chrome: SVGGElement;
  /** Paragraph outlines of the Edit text tool, in overlay pixels. */
  readonly textChrome: SVGGElement;
  /** Form fields as HTML inputs, positioned in percentages of the page so zoom only scales them. */
  readonly fields: HTMLDivElement;

  private geometry: PageGeometry;
  private canvas: HTMLCanvasElement | null = null;
  private renderTask: RenderHandle | null = null;
  private renderedScale = 0;
  /** Page objects left out of the bitmap (their text is drawn by an edit session instead). */
  private hidden: number[] = [];

  constructor(
    readonly index: number,
    /** Page geometry at zoom 1, used for the overlay's viewBox and coordinate conversion. */
    readonly base: PageGeometry,
    private readonly renderer: PageRenderer,
    scale: number,
  ) {
    this.geometry = base;

    this.el = document.createElement('div');
    this.el.className = 'pdfsdk-page';
    this.el.dataset.pageIndex = String(index);
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', `Page ${index + 1}`);

    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.classList.add('pdfsdk-page__overlay');
    this.overlay.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    this.overlay.setAttribute('preserveAspectRatio', 'none');

    const userSpace = document.createElementNS(SVG_NS, 'g');
    userSpace.setAttribute('transform', `matrix(${base.transform.join(' ')})`);
    this.marks = document.createElementNS(SVG_NS, 'g');
    this.textLayer = document.createElementNS(SVG_NS, 'g');
    this.content = document.createElementNS(SVG_NS, 'g');
    this.draft = document.createElementNS(SVG_NS, 'g');
    userSpace.append(this.marks, this.textLayer, this.content, this.draft);
    this.chrome = document.createElementNS(SVG_NS, 'g');
    this.textChrome = document.createElementNS(SVG_NS, 'g');
    this.overlay.append(userSpace, this.chrome, this.textChrome);
    this.fields = document.createElement('div');
    this.fields.className = 'pdfsdk-fields';
    this.el.append(this.overlay, this.fields);

    this.setScale(scale);
  }

  get width(): number {
    return this.base.width;
  }

  setScale(scale: number): void {
    this.geometry = this.base.scaled(scale);
    // Field text sizes follow the zoom through this.
    this.el.style.setProperty('--pdfsdk-scale', String(scale));
    this.el.style.width = `${Math.floor(this.geometry.width)}px`;
    this.el.style.height = `${Math.floor(this.geometry.height)}px`;
  }

  get scale(): number {
    return this.geometry.scale;
  }

  /** Sets the page objects to leave out of the bitmap; the next `render()` redraws. */
  setHidden(objects: number[]): void {
    const next = [...new Set(objects)].sort((a, b) => a - b);
    if (next.join() === this.hidden.join()) return;
    this.hidden = next;
    // A render in flight was asked for the old set; drop it so it can't mark the page as current.
    this.cancelRender();
    this.renderedScale = 0;
  }

  /** Renders the canvas at the current zoom, unless it is already up to date. */
  async render(): Promise<void> {
    const scale = this.geometry.scale;
    if (this.renderedScale === scale && this.canvas) return;
    this.cancelRender();

    const cssWidth = this.geometry.width;
    const cssHeight = this.geometry.height;
    const outputScale = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)),
    );

    const width = Math.max(1, Math.floor(cssWidth * outputScale));
    const height = Math.max(1, Math.floor(cssHeight * outputScale));
    const task = this.renderer(width, height, this.hidden);
    this.renderTask = task;
    let bitmap: ImageBitmap;
    try {
      bitmap = await task.promise;
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      throw error;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('aria-hidden', 'true');
    // Hands the bitmap to the canvas without copying pixels.
    canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap);

    // Swap only after the new bitmap is complete, so zooming never flashes a blank page.
    this.canvas?.remove();
    this.canvas = canvas;
    this.el.prepend(canvas);
    this.renderedScale = scale;
  }

  /** Frees the bitmap of a page that scrolled far out of view. */
  release(): void {
    this.cancelRender();
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
      this.canvas = null;
    }
    this.renderedScale = 0;
  }

  private cancelRender(): void {
    this.renderTask?.cancel();
    this.renderTask = null;
  }

  /** Converts a pointer position to PDF user space. */
  clientToPdf(clientX: number, clientY: number): Point {
    const box = this.overlay.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * this.base.width;
    const y = ((clientY - box.top) / box.height) * this.base.height;
    const [px, py] = this.base.toPdf([x, y]);
    // 0.01 pt is far below what anyone can see, and keeps saved JSON compact.
    return [Math.round(px * 100) / 100, Math.round(py * 100) / 100];
  }

  /** Converts a PDF user-space point to CSS pixels inside the page element. */
  pdfToElement(point: Point): Point {
    return this.geometry.toViewport(point);
  }

  /** Converts a PDF user-space point to overlay viewBox units (zoom 1 pixels). */
  pdfToOverlay(point: Point): Point {
    return this.base.toViewport(point);
  }

  destroy(): void {
    this.release();
    this.el.remove();
  }
}
