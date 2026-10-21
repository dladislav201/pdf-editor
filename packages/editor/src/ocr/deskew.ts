import type { PixelBox, Raster } from './types';

/**
 * Scans are rarely straight: 0.3–1° is normal, phone photos more. A tilted
 * ruling line smears over many pixel rows, which breaks table detection and
 * hurts recognition. The angle is estimated from long near-horizontal dark
 * runs (rules, underlines, table borders): every row a tilted line crosses
 * holds one stretch of it, and those stretches' centres lie on the line.
 */
export function estimateSkew(raster: Raster): number {
  const { width: w, height: h, rgba } = raster;
  const minRun = Math.round(w * 0.04);
  const runs: { y: number; cx: number; len: number }[] = [];
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && rgba[(y * w + x) * 4]! < 128) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= minRun) runs.push({ y, cx: (start + x) / 2, len: x - start });
        start = -1;
      }
    }
  }
  // Chain stretches in consecutive rows into lines; each chain gives a slope.
  const chains: (typeof runs)[] = [];
  for (const run of runs) {
    const chain = chains.find((c) => {
      const last = c[c.length - 1]!;
      return run.y - last.y <= 2 && Math.abs(run.cx - last.cx) < last.len;
    });
    if (chain) chain.push(run);
    else chains.push([run]);
  }
  // Each line's slope from the centre of its ink column by column. Lines that
  // are already level (one or two rows) count too, or the estimate leans steep.
  const dark = (x: number, y: number) => rgba[(y * w + x) * 4]! < 128;
  const slopes: { slope: number; weight: number }[] = [];
  for (const chain of chains) {
    const top = Math.max(0, chain[0]!.y - 1);
    const bottom = Math.min(h - 1, chain[chain.length - 1]!.y + 1);
    const left = Math.max(0, Math.round(Math.min(...chain.map((r) => r.cx - r.len / 2))));
    const right = Math.min(w - 1, Math.round(Math.max(...chain.map((r) => r.cx + r.len / 2))));
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let x = left; x <= right; x += 2) {
      let count = 0;
      let sum = 0;
      for (let y = top; y <= bottom; y++) {
        if (dark(x, y)) {
          count++;
          sum += y;
        }
      }
      if (!count) continue;
      const cy = sum / count;
      n++;
      sx += x;
      sy += cy;
      sxy += x * cy;
      sxx += x * x;
    }
    const denominator = n * sxx - sx * sx;
    if (n < 10 || denominator === 0) continue;
    slopes.push({ slope: (n * sxy - sx * sy) / denominator, weight: right - left });
  }
  if (!slopes.length) return 0;
  // Weighted median: robust against the odd diagonal stroke.
  slopes.sort((a, b) => a.slope - b.slope);
  const half = slopes.reduce((s, x) => s + x.weight, 0) / 2;
  let acc = 0;
  for (const s of slopes) {
    acc += s.weight;
    if (acc >= half) return Math.atan(s.slope);
  }
  return 0;
}

/** Rotates a raster by `-angle` about its centre (bilinear, white fill). */
export function rotate(raster: Raster, angle: number): Raster {
  const { width: w, height: h, rgba } = raster;
  const out = new Uint8ClampedArray(rgba.length).fill(255);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Where this output pixel comes from in the tilted source.
      const sx = cos * (x - cx) - sin * (y - cy) + cx;
      const sy = sin * (x - cx) + cos * (y - cy) + cy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = (y0 * w + x0) * 4;
      const v =
        rgba[i]! * (1 - fx) * (1 - fy) +
        rgba[i + 4]! * fx * (1 - fy) +
        rgba[i + w * 4]! * (1 - fx) * fy +
        rgba[i + w * 4 + 4]! * fx * fy;
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, rgba: out };
}

/** Maps a box found in the straightened raster back onto the original scan. */
/** Maps a point of the straightened raster back to the original one. */
export function unrotatePoint([x, y]: [number, number], angle: number, width: number, height: number): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = width / 2;
  const cy = height / 2;
  return [cos * (x - cx) - sin * (y - cy) + cx, sin * (x - cx) + cos * (y - cy) + cy];
}

export function unrotateBox(box: PixelBox, angle: number, width: number, height: number): PixelBox {
  const corners = (
    [
      [box.x0, box.y0],
      [box.x1, box.y0],
      [box.x0, box.y1],
      [box.x1, box.y1],
    ] as [number, number][]
  ).map((corner) => unrotatePoint(corner, angle, width, height));
  return {
    x0: Math.min(...corners.map((c) => c[0]!)),
    y0: Math.min(...corners.map((c) => c[1]!)),
    x1: Math.max(...corners.map((c) => c[0]!)),
    y1: Math.max(...corners.map((c) => c[1]!)),
  };
}
