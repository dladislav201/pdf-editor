import type { Raster } from '../ocr/types';

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Lifting ink (a signature, a stamp) off a photo or scan of paper: the paper
 * becomes transparent, the ink stays, in its own colour or another. Works on
 * phone photos too, whose paper is lit unevenly: the paper's brightness is
 * found area by area, so a shadow across the page goes with the paper.
 */

/** A photo read for lifting its ink: how much darker than the paper around it each pixel is, and its colour with the light evened out. */
export interface InkPhoto {
  width: number;
  height: number;
  /** 0 for paper, towards 1 for dark ink: in the darkest channel, so coloured ink (a blue stamp) counts as much as black. */
  darkness: Float32Array;
  /** RGB as if the paper were white everywhere. */
  color: Uint8ClampedArray;
  /** Where the photo's ink starts, by its darkness: a little above the paper's grain. */
  threshold: number;
}

export interface LiftOptions {
  /** How much is taken for paper, 0–1: higher removes faint marks and shadows, lower keeps light ink. Default 0.5. */
  strength?: number;
  /** Ink colour as CSS hex (`#1b1b1f`); null keeps the photo's own colours. Default null. */
  color?: string | null;
}

/** The value below which `fraction` of `values` lie. */
function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
}

/**
 * The paper's colour everywhere: in each block, that of its brightest pixels
 * (ink is darker than paper, even a blue stamp that is bluer than it); a
 * block full of ink takes the brightest of its neighbours' instead. Then
 * smoothed and stretched back to every pixel, per channel.
 */
function paper(image: Raster): Float32Array[] {
  const { width, height, rgba } = image;
  const block = Math.max(8, Math.round(Math.min(width, height) / 32));
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const blocks = cols * rows;
  const light = new Float32Array(blocks);
  const colors = [0, 1, 2].map(() => new Float32Array(blocks));
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const samples: number[] = [];
      for (let y = by * block; y < Math.min(height, (by + 1) * block); y += 2) {
        for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x += 2) {
          const i = (y * width + x) * 4;
          samples.push(i);
        }
      }
      const lum = (i: number) => luminance(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
      samples.sort((a, b) => lum(b) - lum(a));
      // The brightest fifth, past the very brightest (a glint): the paper.
      const top = samples.slice(Math.floor(samples.length * 0.02), Math.max(1, Math.ceil(samples.length * 0.2)));
      const b = by * cols + bx;
      for (let c = 0; c < 3; c++) colors[c]![b] = top.reduce((sum, i) => sum + rgba[i + c]!, 0) / top.length;
      light[b] = luminance(colors[0]![b]!, colors[1]![b]!, colors[2]![b]!);
    }
  }
  const around = (x: number, y: number) => {
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) out.push(ny * cols + nx);
      }
    }
    return out;
  };
  // Each block takes the colour of its brightest neighbour (paper wins over ink).
  const brightest = new Int32Array(blocks);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      brightest[y * cols + x] = around(x, y).reduce((best, b) => (light[b]! > light[best]! ? b : best));
    }
  }
  const grow = (grid: Float32Array, reduce: (values: number[]) => number) => {
    const out = new Float32Array(grid.length);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) out[y * cols + x] = reduce(around(x, y).map((b) => grid[b]!));
    }
    return out;
  };
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return colors.map((grid) => {
    // Two passes of smoothing.
    const smooth = grow(grow(grid.map((_, b) => grid[brightest[b]!]!), mean), mean);
    const full = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
      const y0 = Math.floor(gy);
      const y1 = Math.min(rows - 1, y0 + 1);
      const ty = gy - y0;
      for (let x = 0; x < width; x++) {
        const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / block - 0.5));
        const x0 = Math.floor(gx);
        const x1 = Math.min(cols - 1, x0 + 1);
        const tx = gx - x0;
        const top = smooth[y0 * cols + x0]! * (1 - tx) + smooth[y0 * cols + x1]! * tx;
        const bottom = smooth[y1 * cols + x0]! * (1 - tx) + smooth[y1 * cols + x1]! * tx;
        full[y * width + x] = Math.max(1, top * (1 - ty) + bottom * ty);
      }
    }
    return full;
  });
}

/** Reads a photo for `liftInk`: done once, then lifting with other settings is quick. */
export function readInk(image: Raster): InkPhoto {
  const { width, height, rgba } = image;
  const [pr, pg, pb] = paper(image);
  const darkness = new Float32Array(width * height);
  const color = new Uint8ClampedArray(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const r = (rgba[i]! / pr![p]!) * 255;
    const g = (rgba[i + 1]! / pg![p]!) * 255;
    const b = (rgba[i + 2]! / pb![p]!) * 255;
    color.set([r, g, b], p * 3);
    darkness[p] = Math.max(0, Math.min(1, 1 - Math.min(r, g, b) / 255));
  }
  // Most of a photo is paper: its grain is about as dark as the middle of the picture; ink starts clearly above that.
  const sample: number[] = [];
  for (let p = 0; p < darkness.length; p += 7) sample.push(darkness[p]!);
  const grain = percentile(sample, 0.6);
  return { width, height, darkness, color, threshold: Math.min(0.35, Math.max(0.08, grain + 0.07)) };
}

/** Clears specks: groups of ink pixels smaller than `minimum`, touching nothing bigger. */
function despeckle(alpha: Float32Array, width: number, height: number, minimum: number): void {
  const seen = new Uint8Array(alpha.length);
  const stack: number[] = [];
  const group: number[] = [];
  for (let start = 0; start < alpha.length; start++) {
    if (seen[start] || alpha[start]! < 0.05) continue;
    stack.push(start);
    seen[start] = 1;
    group.length = 0;
    while (stack.length) {
      const p = stack.pop()!;
      group.push(p);
      const x = p % width;
      const y = (p - x) / width;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (!seen[n] && alpha[n]! >= 0.05) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (group.length < minimum) for (const p of group) alpha[p] = 0;
  }
}

/**
 * The ink of a photo read by `readInk`, on a transparent background and cut
 * down to it (with a little room around): a signature or a stamp ready to
 * place. Null when there is no ink.
 */
export function liftInk(photo: InkPhoto, options: LiftOptions = {}): Raster | null {
  const { width, height, darkness, color, threshold } = photo;
  const strength = Math.min(1, Math.max(0, options.strength ?? 0.5));
  // Ink fades in over a soft edge, starting further up the stronger the setting.
  const low = threshold * (0.5 + strength);
  const high = low + 0.1;
  const alpha = new Float32Array(width * height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = Math.min(1, Math.max(0, (darkness[p]! - low) / (high - low)));
  despeckle(alpha, width, height, Math.max(6, Math.round(width * height * 0.00003)));

  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x]! < 0.05) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return null;

  const fixed = options.color ? [1, 3, 5].map((i) => parseInt(options.color!.slice(i, i + 2), 16)) : null;
  const pad = 6;
  const left = Math.max(0, x0 - pad);
  const top = Math.max(0, y0 - pad);
  const w = Math.min(width, x1 + pad + 1) - left;
  const h = Math.min(height, y1 + pad + 1) - top;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (top + y) * width + left + x;
      const a = alpha[p]!;
      if (a <= 0) continue;
      const o = (y * w + x) * 4;
      if (fixed) {
        rgba.set(fixed, o);
      } else {
        // The ink's own colour: what the pixel shows, less the paper showing through its soft edge.
        const cover = Math.max(a, 0.35);
        for (let c = 0; c < 3; c++) rgba[o + c] = 255 - (255 - color[p * 3 + c]!) / cover;
      }
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return { width: w, height: h, rgba };
}
