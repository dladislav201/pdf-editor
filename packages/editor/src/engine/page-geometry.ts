import type { Point } from '../types';

export type Rotation = 0 | 90 | 180 | 270;

/** Affine matrix `[a, b, c, d, e, f]`, as in PDF. */
export type Matrix = [number, number, number, number, number, number];

/**
 * Maps PDF user space (points, y up, origin at the box corner) to display
 * pixels (y down) for a page with a visible box, a /Rotate value and a zoom.
 * Same convention as pdf.js' PageViewport, so annotation geometry is unchanged.
 */
export class PageGeometry {
  readonly width: number;
  readonly height: number;
  readonly transform: Matrix;
  private readonly inverse: Matrix;

  constructor(
    /** Visible page box in user space: `[x0, y0, x1, y1]`. */
    readonly box: [number, number, number, number],
    readonly rotation: Rotation,
    readonly scale = 1,
  ) {
    const [x0, y0, x1, y1] = box;
    const centerX = (x0 + x1) / 2;
    const centerY = (y0 + y1) / 2;
    const [a, b, c, d] = {
      0: [1, 0, 0, -1],
      90: [0, 1, 1, 0],
      180: [-1, 0, 0, 1],
      270: [0, -1, -1, 0],
    }[rotation] as [number, number, number, number];

    let offsetX: number;
    let offsetY: number;
    if (a === 0) {
      offsetX = Math.abs(centerY - y0) * scale;
      offsetY = Math.abs(centerX - x0) * scale;
      this.width = Math.abs(y1 - y0) * scale;
      this.height = Math.abs(x1 - x0) * scale;
    } else {
      offsetX = Math.abs(centerX - x0) * scale;
      offsetY = Math.abs(centerY - y0) * scale;
      this.width = Math.abs(x1 - x0) * scale;
      this.height = Math.abs(y1 - y0) * scale;
    }
    this.transform = [
      a * scale,
      b * scale,
      c * scale,
      d * scale,
      offsetX - a * scale * centerX - c * scale * centerY,
      offsetY - b * scale * centerX - d * scale * centerY,
    ];
    const [ta, tb, tc, td, te, tf] = this.transform;
    const det = ta * td - tb * tc;
    this.inverse = [td / det, -tb / det, -tc / det, ta / det, (tc * tf - td * te) / det, (tb * te - ta * tf) / det];
  }

  scaled(scale: number): PageGeometry {
    return new PageGeometry(this.box, this.rotation, scale);
  }

  /** PDF user space → display pixels. */
  toViewport([x, y]: Point): Point {
    const [a, b, c, d, e, f] = this.transform;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  /** Display pixels → PDF user space. */
  toPdf([x, y]: Point): Point {
    const [a, b, c, d, e, f] = this.inverse;
    return [a * x + c * y + e, b * x + d * y + f];
  }
}
