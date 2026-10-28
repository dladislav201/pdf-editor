import { describe, expect, it } from 'vitest';
import type { Raster } from '../ocr/types';
import { liftInk, readInk } from './ink';

const W = 400;
const H = 300;

/**
 * A phone photo of paper: bright on the left, in shadow on the right (and a
 * little warm), with a dark signature across it, a pale blue stamp ring in
 * the shadow, specks of dirt, and grain everywhere.
 */
function photo(): { image: Raster; stroke: [number, number][]; stamp: [number, number][]; specks: [number, number][] } {
  const rgba = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 8;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const light = 245 - (x / W) * 100;
      rgba.set([light + noise(), light * 0.97 + noise(), light * 0.9 + noise(), 255], (y * W + x) * 4);
    }
  }
  const paint = (x: number, y: number, ink: [number, number, number], cover: number) => {
    const i = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) rgba[i + c] = rgba[i + c]! * (1 - cover) + ((ink[c]! * (245 - (x / W) * 100)) / 245) * cover;
  };
  const stroke: [number, number][] = [];
  for (let x = 40; x < 230; x++) {
    const y = Math.round(150 + Math.sin(x / 15) * 30);
    for (let t = -2; t <= 2; t++) {
      paint(x, y + t, [30, 30, 45], 1);
      stroke.push([x, y + t]);
    }
  }
  const stamp: [number, number][] = [];
  for (let a = 0; a < 360; a += 0.5) {
    for (let r = 40; r < 46; r++) {
      const x = Math.round(310 + Math.cos((a * Math.PI) / 180) * r);
      const y = Math.round(150 + Math.sin((a * Math.PI) / 180) * r);
      // Bluer than the warm paper: its blue channel is brighter than the paper's.
      paint(x, y, [60, 80, 240], 0.45);
      stamp.push([x, y]);
    }
  }
  const specks: [number, number][] = [
    [100, 40],
    [360, 270],
    [20, 280],
  ];
  for (const [x, y] of specks) paint(x, y, [90, 90, 90], 1);
  return { image: { width: W, height: H, rgba }, stroke, stamp, specks };
}

/** The lifted pixel that was at (x, y) of the photo, given where the cut-out starts. */
const at = (out: Raster, origin: [number, number], [x, y]: [number, number]) => {
  const i = ((y - origin[1]) * out.width + (x - origin[0])) * 4;
  return [...out.rgba.subarray(i, i + 4)];
};

describe('lifting ink off a photo of paper', () => {
  const { image, stroke, stamp, specks } = photo();
  const read = readInk(image);
  const out = liftInk(read)!;
  // The cut-out spans the ink plus 6 px: from the stroke's left end to the stamp's right edge.
  const origin: [number, number] = [40 - 6, Math.min(...stroke.map((p) => p[1]), ...stamp.map((p) => p[1])) - 6];

  it('cuts the picture down to the ink', () => {
    expect(out.width).toBeGreaterThanOrEqual(355 - 40 + 12 - 2);
    expect(out.width).toBeLessThanOrEqual(357 - 40 + 12 + 2);
    expect(out.height).toBeLessThan(120);
  });

  it('makes the paper transparent, in the light and in the shadow', () => {
    for (const point of [
      [60, 60],
      [200, 60],
      [250, 100],
      [330, 150],
      [310, 150],
      [345, 115],
    ] as [number, number][]) {
      if (point[1] < origin[1]) continue;
      expect(at(out, origin, point)[3], `paper at ${point}`).toBeLessThan(20);
    }
  });

  it('keeps the signature solid and the stamp in its own blue', () => {
    const strokeAlpha = stroke.filter((_, i) => i % 5 === 2).map((p) => at(out, origin, p)[3]!);
    expect(Math.min(...strokeAlpha)).toBeGreaterThan(200);
    const ring = stamp.filter(([x, y]) => Math.hypot(x - 310, y - 150) > 41.5 && Math.hypot(x - 310, y - 150) < 44.5).map((p) => at(out, origin, p));
    const solid = ring.filter((px) => px[3]! > 128);
    expect(solid.length / ring.length).toBeGreaterThan(0.8);
    const [r, , b] = [0, 1, 2].map((c) => solid.reduce((sum, px) => sum + px[c]!, 0) / solid.length);
    expect(b! - r!).toBeGreaterThan(60);
  });

  it('drops specks of dirt', () => {
    for (const speck of specks) {
      const inside = speck[0] >= origin[0] && speck[1] >= origin[1] && speck[0] < origin[0] + out.width && speck[1] < origin[1] + out.height;
      if (inside) expect(at(out, origin, speck)[3]).toBe(0);
    }
  });

  it('sets the ink in another colour, and takes faint marks for paper when stronger', () => {
    const black = liftInk(read, { color: '#000000' })!;
    const px = at(black, origin, stroke[2]!);
    expect(px.slice(0, 3)).toEqual([0, 0, 0]);
    // The strongest setting still keeps the dark signature.
    const strong = liftInk(read, { strength: 1 })!;
    expect(at(strong, [strong.width === out.width ? origin[0] : 0, origin[1]], stroke[2]!)[3]).toBeGreaterThan(200);
  });

  it('takes a picture with a transparent background as ink on paper', () => {
    // A signature already cut out: transparent black around dark strokes.
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let x = 50; x < 350; x++) for (let t = -2; t <= 2; t++) rgba.set([20, 20, 30, 255], ((150 + t) * W + x) * 4);
    const cut = liftInk(readInk({ width: W, height: H, rgba }))!;
    let opaque = 0;
    for (let i = 3; i < cut.rgba.length; i += 4) if (cut.rgba[i]! > 128) opaque++;
    // The strokes stay; what was transparent stays transparent.
    expect(opaque).toBeGreaterThan(300 * 4);
    expect(opaque).toBeLessThan(300 * 6);
    expect(cut.height).toBeLessThan(5 + 12 + 2);
  });

  it('finds no ink on blank paper', () => {
    const blank = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < blank.length; i += 4) blank.set([240 - (i % (W * 4)) / 20, 238, 230, 255], i);
    expect(liftInk(readInk({ width: W, height: H, rgba: blank }))).toBeNull();
  });
});
