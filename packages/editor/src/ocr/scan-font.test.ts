import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { init } from '@embedpdf/pdfium';
import { beforeAll, describe, expect, it } from 'vitest';
import { PageGeometry } from '../engine/page-geometry';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { recognizeRaster } from './recognize';
import { ScanFont, letterInk, type ScanGlyph } from './scan-font';
import { TesseractEngine } from './tesseract';
import type { PixelBox, Raster } from './types';

const require = createRequire(import.meta.url);
const { createCanvas, Path2D } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));

/** A white raster with dark rectangles, as [x0, y0, x1, y1]. */
function rects(width: number, height: number, boxes: [number, number, number, number][]): Raster {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1] of boxes) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  return { width, height, rgba };
}
const box = (x0: number, x1: number, y0 = 10, y1 = 50): PixelBox => ({ x0, y0, x1, y1 });
const darkAt = (cut: { box: PixelBox; width: number; pixels: Uint8ClampedArray }, x: number, y: number) =>
  cut.pixels[(y - cut.box.y0) * cut.width + (x - cut.box.x0)]! < 128;

describe('cutting letters out of a scan', () => {
  it('cuts each letter by its ink when OCR boxes overlap or miss a bit of it', () => {
    // An "i" (stem and dot) and a stem 4 px to its right; OCR's boxes run into each other.
    const image = rects(80, 60, [
      [10, 20, 18, 50],
      [11, 10, 17, 16],
      [22, 20, 34, 50],
    ]);
    const [first, second] = letterInk(image, [{ box: box(10, 28) }, { box: box(16, 31) }], 40);
    expect(first!.box).toEqual({ x0: 10, y0: 10, x1: 18, y1: 50 });
    expect(second!.box).toEqual({ x0: 22, y0: 20, x1: 34, y1: 50 });
    // The dot came along with its stem; nothing of the other letter did.
    expect(darkAt(first!, 12, 12)).toBe(true);
    expect([...first!.pixels].filter((p) => p < 128)).toHaveLength(8 * 30 + 6 * 6);
  });

  it('leaves out letters whose ink runs together', () => {
    const image = rects(80, 60, [[10, 20, 40, 50]]);
    expect(letterInk(image, [{ box: box(10, 24) }, { box: box(26, 40) }], 40)).toEqual([null, null]);
  });
});

describe('the typeface of a scan', () => {
  const langPath = mkdtempSync(join(tmpdir(), 'pdfsdk-ocr-'));
  for (const lang of ['ukr', 'eng']) {
    const data = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    copyFileSync(join(data, '4.0.0_best_int', `${lang}.traineddata.gz`), join(langPath, `${lang}.traineddata.gz`));
  }
  const encode = async ({ width, height, rgba }: Raster) => {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(width, height);
    data.data.set(rgba);
    ctx.putImageData(data, 0, 0);
    return canvas.toBuffer('image/png');
  };
  let lib: Awaited<ReturnType<typeof init>>;
  beforeAll(async () => {
    lib = initLibrary(await init({ wasmBinary: wasm }));
  });

  async function lettersOf(file: string): Promise<ScanFont> {
    const doc = new PdfiumDocument(lib, new Uint8Array(readFileSync(new URL(`../../test/fixtures/${file}`, import.meta.url))));
    const engine = new TesseractEngine(() => import('tesseract.js'), encode, { langPath });
    try {
      const info = doc.pageInfo(0);
      const geometry = new PageGeometry(info.box, info.rotation, 300 / 72);
      const width = Math.round(geometry.width);
      const height = Math.round(geometry.height);
      const result = await recognizeRaster({ width, height, rgba: doc.render(0, width, height, [], false) }, engine, { cells: false });
      return ScanFont.fromPage(result.straight.image, result.straight.words);
    } finally {
      await engine.terminate();
      doc.close();
    }
  }

  /** A standard typeface's letters drawn as the editor draws them, cropped to their ink. */
  function typeface(name: 'Arimo' | 'Tinos' | 'Cousine'): (char: string) => ScanGlyph | null {
    const dir = dirname(require.resolve(`@expo-google-fonts/${name.toLowerCase()}/package.json`));
    const font = fontkit.create(new Uint8Array(readFileSync(join(dir, '400Regular', `${name}_400Regular.ttf`))));
    const size = 64;
    return (char) => {
      const code = char.codePointAt(0)!;
      if (!font.hasGlyphForCodePoint(code)) return null;
      const glyph = font.glyphForCodePoint(code);
      const scale = size / font.unitsPerEm;
      const width = Math.ceil(glyph.advanceWidth * scale) + 8;
      const height = Math.ceil(size * 1.6);
      const baseline = Math.round(size * 1.2);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(scale, 0, 0, -scale, 4, baseline);
      ctx.fillStyle = '#000';
      ctx.fill(new Path2D(glyph.path.toSVG()));
      const data = ctx.getImageData(0, 0, width, height).data;
      let [x0, y0, x1, y1] = [width, height, -1, -1];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4]! >= 250) continue;
          [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
        }
      }
      if (x1 < 0) return null;
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      const pixels = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = data[((y0 + y) * width + x0 + x) * 4]!;
      return { char, width: w, height: h, pixels, top: y0 - baseline, size, bold: false, confidence: 0, ink: 0, line: -1, at: { x0, y0, x1, y1 } };
    };
  }
  const faces = { sans: typeface('Arimo'), serif: typeface('Tinos'), mono: typeface('Cousine') };
  const closest = (font: ScanFont) =>
    Object.entries(faces)
      .map(([family, draw]) => ({ family, ...font.likeness(draw)! }))
      .sort((a, b) => a.distance - b.distance)[0]!;

  it('cuts letters whose serifs and OCR boxes run into their neighbours, and tells the scan is set with serifs', async () => {
    const letters = await lettersOf('scan-invoice-serif.pdf');
    // These touch a neighbour's box almost everywhere on the page; they used to be left out.
    for (const char of ['п', 'у', 'г', 'С', 'Р']) expect(letters.chars).toContain(char);
    // A "№" read as "Мо" gives no "М".
    expect(letters.chars).not.toContain('М');
    const match = closest(letters);
    expect(match.family).toBe('serif');
    expect(match.scale).toBeGreaterThan(0.9);
    expect(match.scale).toBeLessThan(1.1);
  }, 120_000);

  it('tells a sans scan from a serif one', async () => {
    const match = closest(await lettersOf('scan-invoice.pdf'));
    expect(match.family).toBe('sans');
    expect(match.scale).toBeGreaterThan(0.9);
    expect(match.scale).toBeLessThan(1.1);
  }, 120_000);
});
