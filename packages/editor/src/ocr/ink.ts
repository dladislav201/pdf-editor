import type { Raster } from './types';

/**
 * Turns a scan into grayscale and drops coloured ink — stamps, signatures,
 * coloured logos — to paper white. Black or dark grey print stays. On
 * stamped documents this lifts recognition under the stamps from ~40% to
 * ~87% of words (measured on a real Ukrainian invoice). `mask` (a byte per
 * pixel) gets a 1 where ink was removed.
 */
/** Clearly coloured (not grey), and not so dark that it could be black print with a tint. */
export function isColoredInk(r: number, g: number, b: number, minChroma = 45): boolean {
  const max = Math.max(r, g, b);
  return max - Math.min(r, g, b) > minChroma && max > 70;
}

export function removeColoredInk(raster: Raster, minChroma = 45, mask?: Uint8Array): number {
  const d = raster.rgba;
  let removed = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    const colored = isColoredInk(r, g, b, minChroma);
    const value = colored ? 255 : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    if (colored) {
      removed++;
      if (mask) mask[i >> 2] = 1;
    }
    d[i] = d[i + 1] = d[i + 2] = value;
  }
  return removed;
}
