import type { PDFPageProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport';
import type { Point } from './types';

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
  /** Shapes that are being drawn right now. */
  readonly draft: SVGGElement;
  /** Selection outline; drawn in overlay pixels so it is not mirrored with the content. */
  readonly chrome: SVGGElement;

  /** Page geometry at zoom 1, used for the overlay's viewBox and coordinate conversion. */
  readonly baseViewport: PageViewport;
  private viewport: PageViewport;
  private canvas: HTMLCanvasElement | null = null;
  private renderTask: RenderTask | null = null;
  private renderedScale = 0;

  constructor(
    readonly index: number,
    private readonly page: PDFPageProxy,
    scale: number,
  ) {
    this.baseViewport = page.getViewport({ scale: 1 });
    this.viewport = this.baseViewport;

    this.el = document.createElement('div');
    this.el.className = 'pdfsdk-page';
    this.el.dataset.pageIndex = String(index);
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', `Page ${index + 1}`);

    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.classList.add('pdfsdk-page__overlay');
    this.overlay.setAttribute('viewBox', `0 0 ${this.baseViewport.width} ${this.baseViewport.height}`);
    this.overlay.setAttribute('preserveAspectRatio', 'none');

    const userSpace = document.createElementNS(SVG_NS, 'g');
    userSpace.setAttribute('transform', `matrix(${this.baseViewport.transform.join(' ')})`);
    this.content = document.createElementNS(SVG_NS, 'g');
    this.draft = document.createElementNS(SVG_NS, 'g');
    userSpace.append(this.content, this.draft);
    this.chrome = document.createElementNS(SVG_NS, 'g');
    this.overlay.append(userSpace, this.chrome);
    this.el.append(this.overlay);

    this.setScale(scale);
  }

  get width(): number {
    return this.baseViewport.width;
  }

  setScale(scale: number): void {
    this.viewport = this.page.getViewport({ scale });
    this.el.style.width = `${Math.floor(this.viewport.width)}px`;
    this.el.style.height = `${Math.floor(this.viewport.height)}px`;
  }

  get scale(): number {
    return this.viewport.scale;
  }

  /** Renders the canvas at the current zoom, unless it is already up to date. */
  async render(): Promise<void> {
    const scale = this.viewport.scale;
    if (this.renderedScale === scale && this.canvas) return;
    this.cancelRender();

    const cssWidth = this.viewport.width;
    const cssHeight = this.viewport.height;
    const outputScale = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)),
    );

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(cssWidth * outputScale);
    canvas.height = Math.floor(cssHeight * outputScale);
    canvas.setAttribute('aria-hidden', 'true');

    const task = this.page.render({
      canvas,
      viewport: this.page.getViewport({ scale: scale * outputScale }),
    });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      if ((error as { name?: string }).name === 'RenderingCancelledException') return;
      throw error;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
    }

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
    const x = ((clientX - box.left) / box.width) * this.baseViewport.width;
    const y = ((clientY - box.top) / box.height) * this.baseViewport.height;
    const [px, py] = this.baseViewport.convertToPdfPoint(x, y) as [number, number];
    // 0.01 pt is far below what anyone can see, and keeps saved JSON compact.
    return [Math.round(px * 100) / 100, Math.round(py * 100) / 100];
  }

  /** Converts a PDF user-space point to CSS pixels inside the page element. */
  pdfToElement(point: Point): Point {
    const [x, y] = this.viewport.convertToViewportPoint(point[0], point[1]) as [number, number];
    return [x, y];
  }

  /** Converts a PDF user-space point to overlay viewBox units (zoom 1 pixels). */
  pdfToOverlay(point: Point): Point {
    const [x, y] = this.baseViewport.convertToViewportPoint(point[0], point[1]) as [number, number];
    return [x, y];
  }

  destroy(): void {
    this.release();
    this.page.cleanup();
    this.el.remove();
  }
}
