import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { beforeAll, describe, expect, it } from 'vitest';
import { PageGeometry } from '../engine/page-geometry';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { recognizeRaster } from './recognize';
import { TesseractEngine } from './tesseract';
import type { Raster } from './types';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));

// The models the editor ships.
const langPath = mkdtempSync(join(tmpdir(), 'pdfsdk-ocr-langs-'));
for (const lang of ['eng', 'deu', 'nor', 'swe']) {
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

async function read(file: string, languages: string[]): Promise<string> {
  const doc = new PdfiumDocument(lib, fixture(file));
  const engine = new TesseractEngine(() => import('tesseract.js'), encode, { langPath }, languages);
  try {
    const info = doc.pageInfo(0);
    const geometry = new PageGeometry(info.box, info.rotation, 300 / 72);
    const width = Math.round(geometry.width);
    const height = Math.round(geometry.height);
    const result = await recognizeRaster({ width, height, rgba: doc.render(0, width, height, [], false) }, engine);
    return result.words.map((w) => w.text).join(' ');
  } finally {
    await engine.terminate();
    doc.close();
  }
}

describe('reading scans in German, Norwegian and Swedish', () => {
  // With the English model alone the German scan comes out as "Miller & S6hne", "Munchen", "Backerei GroBmann".
  it.each([
    [
      'scan-invoice-de.pdf',
      ['deu', 'eng'],
      ['Müller', 'Söhne', 'Hauptstraße', 'München', 'Bäckerei', 'Großmann', 'Köln', 'dreihundertachtundfünfzig', 'Büropapier', 'Nr.', '268,50'],
    ],
    ['scan-invoice-nb.pdf', ['nor', 'eng'], ['Leverandør:', 'Bjørn', 'Ødegård', 'Tromsø', 'Kafé', 'Beløp', 'Kopipapir', '2685,00']],
    [
      'scan-invoice-sv.pdf',
      ['swe', 'eng'],
      ['Leverantör:', 'Åkesson', 'Öberg', 'Göteborg', 'Väst', 'Malmö', 'bokstäver:', 'Häftklamrar', '2847,00'],
    ],
  ])('%s with %j', async (file, languages, words) => {
    const text = await read(file, languages);
    for (const word of words) expect(text).toContain(word);
    // No Cyrillic clean-ups without Ukrainian: "Nr." isn't turned into "№".
    expect(text).not.toContain('№');
  }, 120_000);
});
