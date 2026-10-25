import { isColoredInk } from './ink';
import type { PixelBox, Raster } from './types';

const lum = (rgba: Uint8ClampedArray, o: number) => 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
/**
 * Darker than the paper by this much is ink. Low on purpose: JPEG leaves a
 * pale halo around bold type that otherwise stays behind as a ghost.
 */
const INK_CONTRAST = 12;
/** Ruling lines are dark and long: at least this many text sizes across, or most of the area tall. */
const RULE_LENGTH = 3;
/** Coloured ink covering this share of the area means a stamp runs over the words. */
const STAMP_SHARE = 0.01;
/** Ink less colourful than this (max − min channel) is black or grey: letters. */
const NEUTRAL = 24;
/** Under a stamp, blends of black and its colour up to this lightness are letters; lighter is the stamp's tint. */
const BLEND_LUM = 170;

/**
 * Removes the ink of `words` from a piece of a scan, for text that is about
 * to be drawn anew in its place: dark pixels inside the word boxes take the
 * paper's colour. Table borders and rules running through the area are kept:
 * dark runs much longer than the text is high (horizontal) or crossing the
 * whole area (vertical) are not letters. A stamp over the words stays: its
 * coloured ink isn't erased, and letters under it take the stamp's colour
 * around them rather than leaving paper-coloured holes in it. `size` is the
 * text size in pixels. Works in place and returns the image.
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
  const chroma = (o: number) => Math.max(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!) - Math.min(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
  const colored = (o: number) => isColoredInk(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
  // A stamp over the words: enough clearly coloured ink, and how colourful it typically is.
  const chromas: number[] = [];
  for (let o = 0; o < rgba.length; o += 4) if (colored(o)) chromas.push(chroma(o));
  chromas.sort((a, b) => a - b);
  const stamped = chromas.length > STAMP_SHARE * w * h;
  const stampChroma = chromas[chromas.length >> 1] ?? 0;
  const isInk = (x: number, y: number) => lum(rgba, (y * w + x) * 4) < paperLum - INK_CONTRAST;
  // Letters are black or grey ink; under a stamp also where black blends into its colour (dark,
  // and well less colourful than the stamp). The stamp's own strokes and pale tints stay.
  const isLetter = (x: number, y: number) => {
    if (!isInk(x, y)) return false;
    const o = (y * w + x) * 4;
    const c = chroma(o);
    return !stamped || c < NEUTRAL || (c < 0.5 * stampChroma && lum(rgba, o) < BLEND_LUM);
  };
  // Rules are black or grey; a stamp's long strokes are not rules.
  const isDark = (x: number, y: number) => lum(rgba, (y * w + x) * 4) < 140 && !colored((y * w + x) * 4);
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
        if (!isLetter(x, y)) continue;
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
  // The halo around letters takes neighbours too; never the stamp's own ink or a rule.
  const keepInk = (i: number) => stamped && isInk(i % w, Math.floor(i / w)) && !isLetter(i % w, Math.floor(i / w));
  for (let i = 0; i < w * h; i++) if (rule[i] || (erase[i] && keepInk(i))) erase[i] = 0;

  // What goes where a letter was: paper, or under a stamp the average of the stamp and paper
  // around it (letters and rules left out), so the stamp runs on instead of showing a hole.
  const radius = Math.min(12, Math.max(3, Math.round(size * 0.3)));
  const fills: [number, number, number, number][] = [];
  for (let i = 0; i < w * h; i++) {
    if (!erase[i]) continue;
    if (!stamped) {
      fills.push([i, ...paper]);
      continue;
    }
    const x = i % w;
    const y = (i - x) / w;
    let count = 0;
    let stampCount = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let py = Math.max(0, y - radius); py <= Math.min(h - 1, y + radius); py++) {
      for (let px = Math.max(0, x - radius); px <= Math.min(w - 1, x + radius); px++) {
        const j = py * w + px;
        if (erase[j] || rule[j] || isLetter(px, py)) continue;
        count++;
        if (colored(j * 4)) stampCount++;
        r += rgba[j * 4]!;
        g += rgba[j * 4 + 1]!;
        b += rgba[j * 4 + 2]!;
      }
    }
    fills.push(stampCount ? [i, r / count, g / count, b / count] : [i, ...paper]);
  }
  for (const [i, r, g, b] of fills) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
  }
  return image;
}
