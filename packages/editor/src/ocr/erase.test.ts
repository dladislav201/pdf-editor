import { describe, expect, it } from 'vitest';
import { eraseInk } from './erase';
import type { Raster } from './types';

const PAPER = [250, 249, 244];
const STAMP = [40, 80, 190];
const BLACK = [20, 20, 22];

/** A 120×40 piece of a scan: three black strokes ("letters") and a blue stamp over the right half. */
function scan(): Raster {
  const width = 120;
  const height = 40;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const set = (x: number, y: number, [r, g, b]: number[]) => rgba.set([r!, g!, b!, 255], (y * width + x) * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const letter = y >= 10 && y < 30 && [10, 30, 50].some((l) => x >= l && x < l + 5);
      set(x, y, letter ? BLACK : x >= 40 ? STAMP : PAPER);
    }
  }
  return { width, height, rgba };
}

const at = (image: Raster, x: number, y: number) =>
  Array.from(image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
const near = (actual: number[], expected: number[], tolerance = 12) =>
  actual.every((v, i) => Math.abs(v - expected[i]!) <= tolerance);

describe('erasing words from a scan', () => {
  it('takes letters on paper back to the paper', () => {
    const image = eraseInk(scan(), [{ x0: 8, y0: 8, x1: 37, y1: 32 }], 20);
    expect(at(image, 12, 20)).toEqual(PAPER);
    expect(at(image, 32, 20)).toEqual(PAPER);
  });

  it('keeps a stamp over the words and fills the letters under it with its colour', () => {
    const image = eraseInk(scan(), [{ x0: 8, y0: 8, x1: 57, y1: 32 }], 20);
    // The stamp inside the word box stays as it was...
    expect(at(image, 44, 20)).toEqual(STAMP);
    expect(at(image, 56, 12)).toEqual(STAMP);
    // ...and the letter under it becomes stamp, not a white hole.
    expect(near(at(image, 52, 20), STAMP)).toBe(true);
    // The letter on plain paper is still taken to the paper.
    expect(at(image, 12, 20)).toEqual(PAPER);
  });
});
