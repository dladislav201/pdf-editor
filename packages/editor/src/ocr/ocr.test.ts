import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSubsetter, type Subsetter } from '../engine/hb-subset';
import { PageGeometry } from '../engine/page-geometry';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { analyzePage } from '../text/analyze';
import { estimateSkew, rotate } from './deskew';
import { detectTableCells } from './grid';
import { removeColoredInk } from './ink';
import { placeWords } from './place';
import { fixLine, isNoise } from './post';
import { recognizeRaster } from './recognize';
import { TesseractEngine } from './tesseract';
import type { Raster } from './types';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));
const arimo = () => {
  const bytes = readFileSync(join(dirname(require.resolve('@expo-google-fonts/arimo/package.json')), '400Regular', 'Arimo_400Regular.ttf'));
  return new Uint8Array(bytes);
};

let lib: Awaited<ReturnType<typeof init>>;
let subsetter: Subsetter;
beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
  subsetter = await createSubsetter(readFileSync(join(dirname(require.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')));
});

/** A white raster with `draw` applied through a 2D canvas. */
function raster(width: number, height: number, draw: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void): Raster {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  draw(ctx);
  return { width, height, rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data) };
}

const pixel = (image: Raster, x: number, y: number) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];

describe('scan clean-up', () => {
  it('drops coloured ink (stamps, signatures) and keeps black and grey text', () => {
    const image = raster(60, 20, (ctx) => {
      ctx.fillStyle = '#2b4db8';
      ctx.fillRect(0, 0, 20, 20);
      ctx.fillStyle = '#1d1d1d';
      ctx.fillRect(20, 0, 20, 20);
      ctx.fillStyle = '#888';
      ctx.fillRect(40, 0, 20, 20);
    });
    removeColoredInk(image);
    expect(pixel(image, 10, 10)).toEqual([255, 255, 255]);
    expect(pixel(image, 30, 10)).toEqual([29, 29, 29]);
    expect(pixel(image, 50, 10)).toEqual([136, 136, 136]);
  });

  it('measures the skew of a page and straightens it', () => {
    const angle = (0.6 * Math.PI) / 180;
    const page = raster(1200, 800, (ctx) => {
      ctx.translate(600, 400);
      ctx.rotate(angle);
      ctx.fillStyle = '#000';
      for (let y = -300; y < 300; y += 60) ctx.fillRect(-500, y, 1000, 3);
    });
    expect(Math.abs(estimateSkew(page) - angle)).toBeLessThan(0.002);
    expect(Math.abs(estimateSkew(rotate(page, estimateSkew(page))))).toBeLessThan(0.0005);
  });

  it('finds the cells of a ruled table', () => {
    const page = raster(800, 300, (ctx) => {
      ctx.fillStyle = '#000';
      for (const y of [20, 80, 140, 200]) ctx.fillRect(20, y, 700, 2);
      for (const x of [20, 120, 500, 718]) ctx.fillRect(x, 20, 2, 182);
    });
    const cells = detectTableCells(page);
    expect(cells).toHaveLength(9);
    expect(cells[0]).toMatchObject({ x0: expect.closeTo(22, -1), y0: expect.closeTo(22, -1), x1: expect.closeTo(120, -1) });
  });

  it('maps Latin look-alikes in Cyrillic text back to Cyrillic, but leaves real Latin words', () => {
    expect(fixLine(['Ne', '17', 'TOBAPUCTBO', 'BASF', 'Germany'])).toEqual(['№', '17', 'TOBAPUCTBO', 'BASF', 'Germany']);
    expect(fixLine(['Видаткова', 'Ha', 'cyмy', 'Ne17', 'Мо', '24'])).toEqual(['Видаткова', 'На', 'суму', '№17', '№', '24']);
    expect(isNoise('—', 50)).toBe(true);
    expect(isNoise('1740,00', 50)).toBe(false);
    expect(isNoise('шт', 20)).toBe(true);
  });
});

describe('recognizing a scanned page', () => {
  // Tesseract.js with the same Ukrainian + English models the editor ships.
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

  it('reads the scan, writes an invisible text layer and finds the text again', async () => {
    const original = fixture('scan-invoice.pdf');
    const doc = new PdfiumDocument(lib, original);
    const engine = new TesseractEngine(() => import('tesseract.js'), encode, { langPath });
    try {
      expect(doc.scanInfo(0)).toEqual({ scanned: true, recognized: false, dpi: 200 });
      const info = doc.pageInfo(0);
      const geometry = new PageGeometry(info.box, info.rotation, 300 / 72);
      const width = Math.round(geometry.width);
      const height = Math.round(geometry.height);
      const page = { width, height, rgba: doc.render(0, width, height, [], false) };

      const result = await recognizeRaster(page, engine);
      expect(result.angle * (180 / Math.PI)).toBeCloseTo(0.6, 1);
      expect(result.cells).toBeGreaterThanOrEqual(12);
      const text = result.words.map((w) => w.text).join(' ');
      for (const expected of ['Видаткова', 'накладна', 'Постачальник', 'Toner', 'cartridge', '1740,00', '2671,50', '368,00', '4779,50', 'грн']) {
        expect(text).toContain(expected);
      }
      // The stamp's text is not read: it was blue.
      expect(text).not.toContain('ЄДРПОУ');

      const { words, layer } = placeWords(result.words, geometry);
      const total = words.find((w) => w.text === '4779,50')!;
      // "Разом без ПДВ: 4779,50 грн" sits about 285 pt below the top of the page, around x = 470 pt.
      expect(total.box.x).toBeGreaterThan(440);
      expect(total.box.x).toBeLessThan(500);
      expect(841.89 - total.baseline).toBeGreaterThan(275);
      expect(841.89 - total.baseline).toBeLessThan(295);

      const chars = new Set(layer.flatMap((w) => [...w.text]));
      doc.addInvisibleText([{ page: 0, words: layer }], subsetter.subset(arimo(), chars));
      const saved = doc.save();

      const reopened = new PdfiumDocument(lib, saved);
      try {
        expect(reopened.scanInfo(0)).toMatchObject({ scanned: true, recognized: true });
        // Invisible: the page looks exactly as before.
        const before = new PdfiumDocument(lib, original);
        try {
          expect(reopened.render(0, 595, 842)).toEqual(before.render(0, 595, 842));
        } finally {
          before.close();
        }
        const model = analyzePage(reopened.extractText(0));
        expect(model.paragraphs.length).toBeGreaterThan(5);
        expect(model.paragraphs.every((p) => p.recognized && !p.editable)).toBe(true);
        const all = model.paragraphs.map((p) => p.text).join('\n');
        expect(all).toContain('Видаткова накладна');
        expect(all).toMatch(/Разом без ПДВ: 4779,50 грн/);
        // Words of a line stay one line although the scan is skewed.
        const line = model.paragraphs.flatMap((p) => p.lines).find((l) => l.text.includes('Постачальник'))!;
        expect(line.text).toMatch(/^Постачальник: ТОВ .*Київ/);
      } finally {
        reopened.close();
      }
    } finally {
      await engine.terminate();
      doc.close();
    }
  }, 120_000);
});
