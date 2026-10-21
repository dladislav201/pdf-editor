import type { PixelBox, Raster } from './types';

const lum = (rgba: Uint8ClampedArray, o: number) => 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
/**
 * Darker than the paper by this much is ink. Low on purpose: JPEG leaves a
 * pale halo around bold type that otherwise stays behind as a ghost.
 */
const INK_CONTRAST = 12;
/** Ruling lines are dark and long: at least this many text sizes across, or most of the area tall. */
const RULE_LENGTH = 3;

/**
 * Removes the ink of `words` from a piece of a scan, for text that is about
 * to be drawn anew in its place: dark pixels inside the word boxes take the
 * paper's colour. Table borders and rules running through the area are kept:
 * dark runs much longer than the text is high (horizontal) or crossing the
 * whole area (vertical) are not letters. `size` is the text size in pixels.
 * Works in place and returns the image.
 */
export function eraseInk(image: Raster, words: PixelBox[], size: number): Raster {
  const { width: w, height: h, rgba } = image;

  // Paper: the median colour of the light pixels.
  const light: number[] = [];
  for (let o = 0; o < rgba.length; o += 4) if (lum(rgba, o) > 170) light.push(o);
  const channel = (c: number) => {
    if (!light.length) return 255;
    const values = light.map((o) => rgba[o + c]!).sort((a, b) => a - b);
    return values[values.length >> 1]!;
  };
  const paper = [channel(0), channel(1), channel(2)] as const;
  const paperLum = 0.299 * paper[0] + 0.587 * paper[1] + 0.114 * paper[2];
  const isInk = (x: number, y: number) => lum(rgba, (y * w + x) * 4) < paperLum - INK_CONTRAST;
  const isDark = (x: number, y: number) => lum(rgba, (y * w + x) * 4) < 140;
  // A scanned rule is rarely exactly level or plumb: let a run step a pixel aside.
  const darkAcross = (x: number, y: number) => isDark(x, y) || (y > 0 && isDark(x, y - 1)) || (y + 1 < h && isDark(x, y + 1));
  const darkDown = (x: number, y: number) => isDark(x, y) || (x > 0 && isDark(x - 1, y)) || (x + 1 < w && isDark(x + 1, y));

  // Rules, widened by a pixel for their anti-aliased edges.
  const rule = new Uint8Array(w * h);
  const mark = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < w && py < h) rule[py * w + px] = 1;
      }
    }
  };
  const minAcross = Math.max(RULE_LENGTH * size, 20);
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && darkAcross(x, y)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= minAcross) for (let k = start; k < x; k++) if (isDark(k, y)) mark(k, y);
        start = -1;
      }
    }
  }
  const minDown = Math.max(Math.min(0.85 * h, RULE_LENGTH * size), 1.6 * size);
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      if (y < h && darkDown(x, y)) {
        if (start < 0) start = y;
      } else if (start >= 0) {
        if (y - start >= minDown) for (let k = start; k < y; k++) if (isDark(x, k)) mark(x, k);
        start = -1;
      }
    }
  }

  // Ink in the word boxes, grown by a pixel to take the edge of the halo too.
  const erase = new Uint8Array(w * h);
  for (const box of words) {
    const x0 = Math.max(0, Math.floor(box.x0));
    const x1 = Math.min(w, Math.ceil(box.x1));
    const y0 = Math.max(0, Math.floor(box.y0));
    const y1 = Math.min(h, Math.ceil(box.y1));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!isInk(x, y)) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = x + dx;
            const py = y + dy;
            if (px >= x0 && py >= y0 && px < x1 && py < y1) erase[py * w + px] = 1;
          }
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (!erase[i] || rule[i]) continue;
    rgba[i * 4] = paper[0];
    rgba[i * 4 + 1] = paper[1];
    rgba[i * 4 + 2] = paper[2];
  }
  return image;
}
