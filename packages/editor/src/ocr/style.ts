import type { PixelBox, Raster } from './types';

const lum = (rgba: Uint8ClampedArray, o: number) => 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');

/**
 * Average stroke thickness of the ink in a box, in pixels: dark pixels per
 * horizontal run of dark pixels. Bold type has thicker strokes for its size.
 */
export function strokeWidth(image: Raster, box: PixelBox): number {
  const x0 = Math.max(0, Math.floor(box.x0));
  const x1 = Math.min(image.width, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0));
  const y1 = Math.min(image.height, Math.ceil(box.y1));
  let dark = 0;
  let runs = 0;
  for (let y = y0; y < y1; y++) {
    let inRun = false;
    for (let x = x0; x < x1; x++) {
      const isDark = image.rgba[(y * image.width + x) * 4]! < 128;
      if (isDark) {
        dark++;
        if (!inRun) runs++;
      }
      inRun = isDark;
    }
  }
  return runs ? dark / runs : 0;
}

/**
 * The colour of the ink in a box of the original scan: the mean of the darker
 * half of its dark, unsaturated pixels (edges are lighter from anti-aliasing
 * and JPEG; coloured stamp ink crossing the word is left out).
 */
export function inkColor(image: Raster, box: PixelBox): [number, number, number] | null {
  const x0 = Math.max(0, Math.floor(box.x0));
  const x1 = Math.min(image.width, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0));
  const y1 = Math.min(image.height, Math.ceil(box.y1));
  const { rgba } = image;
  const ink: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      if (lum(rgba, o) >= 110) continue;
      if (Math.max(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!) - Math.min(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!) > 45) continue;
      ink.push(o);
    }
  }
  if (!ink.length) return null;
  ink.sort((a, b) => lum(rgba, a) - lum(rgba, b));
  const darker = ink.slice(0, Math.max(1, ink.length >> 1));
  const mean = (channel: number) => darker.reduce((sum, o) => sum + rgba[o + channel]!, 0) / darker.length;
  return [mean(0), mean(1), mean(2)];
}

/** One colour for a line: the per-channel median of its words' ink. */
export function lineColor(colors: ([number, number, number] | null)[]): string {
  const known = colors.filter((c): c is [number, number, number] => c !== null);
  if (!known.length) return '#000000';
  const median = (channel: number) => known.map((c) => c[channel]!).sort((a, b) => a - b)[known.length >> 1]!;
  return `#${hex(median(0))}${hex(median(1))}${hex(median(2))}`;
}

/** Letters (and digits) that reach cap height; words without them only show the x-height. */
const TALL = /[A-ZА-ЯЁІЇЄҐ0-9bdfhklбдф]/u;
/** Cap height and x-height of typical sans text, in ems (Arial/Arimo). */
const CAP_HEIGHT = 0.71;
const X_HEIGHT = 0.53;

/**
 * Font size of a line in pixels, from how high its ink rises above the
 * baseline: words with capitals, digits or ascenders show the cap height,
 * the rest only the x-height. `fallback` is used when nothing rises.
 */
export function lineSize(words: { text: string; ascent: number }[], fallback: number): number {
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!;
  const tall = words.filter((w) => TALL.test(w.text) && w.ascent > 0).map((w) => w.ascent / CAP_HEIGHT);
  if (tall.length) return median(tall);
  const short = words.filter((w) => w.ascent > 0).map((w) => w.ascent / X_HEIGHT);
  return short.length ? median(short) : fallback;
}
