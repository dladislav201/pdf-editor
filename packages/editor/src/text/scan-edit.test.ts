import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSubsetter, type Subsetter } from '../engine/hb-subset';
import { PageGeometry } from '../engine/page-geometry';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { placeWords } from '../ocr/place';
import { recognizeRaster } from '../ocr/recognize';
import { TesseractEngine } from '../ocr/tesseract';
import type { Raster } from '../ocr/types';
import { analyzePage } from './analyze';
import { paragraphFrame } from './edit-session';
import { GlyphStore, fallbackId } from './glyph-store';
import { layoutParagraph, type StyledChar } from './layout';
import { recognizedChars, scanErase } from './scan-edit';
import { withWordFallback } from './word-fonts';
import { buildWritePlan } from './write-plan';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const fontFile = (file: string) => {
  const [, family, style] = /^(\w+)-(\w+)\.ttf$/.exec(file)!;
  const folder = { Regular: '400Regular', Bold: '700Bold', Italic: '400Regular_Italic', BoldItalic: '700Bold_Italic' }[style!]!;
  const bytes = readFileSync(join(dirname(require.resolve(`@expo-google-fonts/${family!.toLowerCase()}/package.json`)), folder, `${family}_${folder}.ttf`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

let lib: Awaited<ReturnType<typeof init>>;
let subsetter: Subsetter;
/** The synthetic scan with its recognized (invisible) text layer, as `recognizeText` leaves it. */
let recognized: Uint8Array;
const SCAN_SCALE = 200 / 72;

beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
  subsetter = await createSubsetter(readFileSync(join(dirname(require.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')));
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
  const engine = new TesseractEngine(() => import('tesseract.js'), encode, { langPath });
  const doc = new PdfiumDocument(lib, new Uint8Array(readFileSync(new URL('../../test/fixtures/scan-invoice.pdf', import.meta.url))));
  try {
    const info = doc.pageInfo(0);
    const geometry = new PageGeometry(info.box, info.rotation, 300 / 72);
    const width = Math.round(geometry.width);
    const height = Math.round(geometry.height);
    const result = await recognizeRaster({ width, height, rgba: doc.render(0, width, height, [], false) }, engine);
    const { layer } = placeWords(result.words, geometry);
    const chars = (bold: boolean) => new Set(layer.filter((w) => w.bold === bold).flatMap((w) => [...w.text]));
    doc.addInvisibleText([{ page: 0, words: layer }], {
      regular: subsetter.subset(new Uint8Array(fontFile('Arimo-Regular.ttf')), chars(false)),
      bold: subsetter.subset(new Uint8Array(fontFile('Arimo-Bold.ttf')), chars(true)),
    });
    recognized = doc.save();
  } finally {
    await engine.terminate();
    doc.close();
  }
}, 120_000);

/** The editor's save path for a recognized paragraph: set anew, plan, erase the scan, write. */
async function editRecognized(starts: string, change: (text: string) => string) {
  const doc = new PdfiumDocument(lib, recognized);
  try {
    const page = analyzePage(doc.extractText(0));
    const paragraph = page.paragraphs.find((p) => p.text.startsWith(starts))!;
    const store = new GlyphStore(async (src, chars) => doc.glyphs(src.page, src.object, chars), async (file) => fontFile(file));
    store.registerFonts(page.fonts);
    const initial = recognizedChars(paragraph, (font) => store.fallbackFor(font));
    for (const font of new Set(initial.map((c) => c.style.font))) await store.fallbackBytes(font);
    const text = change(paragraph.text);
    const style = initial[0]!.style;
    const chars: StyledChar[] = [...text].map((char, i) => ({ char, style: initial[Math.min(i, initial.length - 1)]?.style ?? style }));
    const layout = layoutParagraph(withWordFallback(chars, store), paragraphFrame(paragraph, page.block), (s, c) => store.advance(s, c));
    const plan = { ...buildWritePlan(paragraph, chars, layout, store), erase: scanErase(paragraph, SCAN_SCALE) };
    const fonts: Record<number, Uint8Array> = {};
    for (const font of new Set(plan.fallback.map((w) => w.font))) {
      const used = plan.fallback.filter((w) => w.font === font).flatMap((w) => [...w.text]);
      fonts[font] = subsetter.subset(new Uint8Array((await store.fallbackBytes(font))!), used);
    }
    doc.applyTextPlans([plan], fonts);
    return { paragraph, plan, initial, bytes: doc.save() };
  } finally {
    doc.close();
  }
}

function render(bytes: Uint8Array): { rgba: Uint8ClampedArray; geometry: PageGeometry; width: number; height: number } {
  const doc = new PdfiumDocument(lib, bytes);
  try {
    const info = doc.pageInfo(0);
    const geometry = new PageGeometry(info.box, info.rotation, 2);
    const width = Math.round(geometry.width);
    const height = Math.round(geometry.height);
    return { rgba: doc.render(0, width, height), geometry, width, height };
  } finally {
    doc.close();
  }
}

/** Dark pixels of a render inside a user-space rectangle. */
function inkIn(page: ReturnType<typeof render>, rect: { x: number; y: number; width: number; height: number }): number {
  const [x0, y1] = page.geometry.toViewport([rect.x, rect.y]);
  const [x1, y0] = page.geometry.toViewport([rect.x + rect.width, rect.y + rect.height]);
  let dark = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(page.height, y1); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(page.width, x1); x++) if (page.rgba[(y * page.width + x) * 4]! < 128) dark++;
  }
  return dark;
}

function texts(bytes: Uint8Array): { visible: string[]; recognized: string[] } {
  const doc = new PdfiumDocument(lib, bytes);
  try {
    const paragraphs = analyzePage(doc.extractText(0)).paragraphs;
    return {
      visible: paragraphs.filter((p) => !p.recognized).map((p) => p.text),
      recognized: paragraphs.filter((p) => p.recognized).map((p) => p.text),
    };
  } finally {
    doc.close();
  }
}

function dump(name: string, before: ReturnType<typeof render>, after: ReturnType<typeof render>, region: { x: number; y: number; width: number; height: number }) {
  const [x0, y1] = before.geometry.toViewport([region.x - 4, region.y - 4]);
  const [x1, y0] = before.geometry.toViewport([region.x + region.width + 4, region.y + region.height + 4]);
  const w = Math.round(x1 - x0);
  const h = Math.round(y1 - y0);
  const canvas = createCanvas(w, h * 2 + 4);
  const ctx = canvas.getContext('2d');
  for (const [i, page] of [before, after].entries()) {
    const data = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data.data[(y * w + x) * 4 + c] = page.rgba[((Math.round(y0) + y) * page.width + Math.round(x0) + x) * 4 + c]!;
    ctx.putImageData(data, 0, i * (h + 4));
  }
  const big = createCanvas(w * 4, (h * 2 + 4) * 4);
  const bctx = big.getContext('2d');
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(canvas, 0, 0, w * 4, (h * 2 + 4) * 4);
  require('node:fs').writeFileSync(`${process.env.SCAN_DEBUG}/${name}.png`, big.toBuffer('image/png'));
}

/** Pixels that differ between two renders outside a user-space rectangle. */
function changedOutside(before: ReturnType<typeof render>, after: ReturnType<typeof render>, region: { x: number; y: number; width: number; height: number }): number {
  const [rx0, ry1] = before.geometry.toViewport([region.x, region.y]);
  const [rx1, ry0] = before.geometry.toViewport([region.x + region.width, region.y + region.height]);
  let changed = 0;
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      if (x >= rx0 - 1 && x <= rx1 + 1 && y >= ry0 - 1 && y <= ry1 + 1) continue;
      const o = (y * before.width + x) * 4;
      if (before.rgba[o] !== after.rgba[o]) changed++;
    }
  }
  return changed;
}

describe('editing recognized text of a scan', () => {
  it('sets recognized text in the fallback font of its weight, at the size and colour of the scan', async () => {
    const doc = new PdfiumDocument(lib, recognized);
    try {
      const page = analyzePage(doc.extractText(0));
      const store = new GlyphStore(async () => ({ font: 0, ascent: 0.9, descent: -0.2, glyphs: {} }), null);
      store.registerFonts(page.fonts);
      const title = page.paragraphs.find((p) => p.text.startsWith('Видаткова накладна'))!;
      const body = page.paragraphs.find((p) => p.text.startsWith('Постачальник'))!;
      expect(title).toMatchObject({ recognized: true, editable: true });
      const [titleChar] = recognizedChars(title, (font) => store.fallbackFor(font));
      const [bodyChar] = recognizedChars(body, (font) => store.fallbackFor(font));
      expect(titleChar!.style.font).toBe(fallbackId('sans', 'Bold'));
      expect(bodyChar!.style.font).toBe(fallbackId('sans', 'Regular'));
      // Made with 14 pt bold and 10 pt regular text.
      expect(titleChar!.style.size).toBeCloseTo(14, 0);
      expect(bodyChar!.style.size).toBeCloseTo(10, 0);
      expect(Number.parseInt(bodyChar!.style.color.slice(1, 3), 16)).toBeLessThan(0x40);
    } finally {
      doc.close();
    }
  });

  it('erases the edited words from the scan and writes the new text in their place', async () => {
    const before = render(recognized);
    const { bytes, plan, paragraph } = await editRecognized('Разом без ПДВ', (text) => text.replace('4779,50', '5120,00'));
    expect(plan.fallback.map((w) => w.text)).toContain('5120,00');
    expect(plan.remove.length).toBeGreaterThan(0);

    const result = texts(bytes);
    expect(result.visible).toEqual(['Разом без ПДВ: 5120,00 грн']);
    // The rest of the page keeps its recognized text, the edited paragraph's layer is gone.
    expect(result.recognized.join('\n')).not.toContain('4779,50');
    expect(result.recognized.join('\n')).toContain('Видаткова накладна');

    // Outside the cleaned area nothing changed; inside it the text is new, not doubled.
    const after = render(bytes);
    const region = plan.erase!.region;
    if (process.env.SCAN_DEBUG) dump('total', before, after, region);
    expect(changedOutside(before, after, region)).toBe(0);
    const line = paragraph.lines[0]!;
    const ink = (page: ReturnType<typeof render>) => inkIn(page, line.box);
    // Same text length, same weight: about as much ink as the scan had, not twice as much.
    expect(ink(after)).toBeGreaterThan(ink(before) * 0.6);
    expect(ink(after)).toBeLessThan(ink(before) * 1.4);
  });

  it('keeps table borders when it erases text inside a cell', async () => {
    const { bytes, plan } = await editRecognized('2671,50', () => '2700,00');
    expect(texts(bytes).visible).toEqual(['2700,00']);
    const before = render(recognized);
    const after = render(bytes);
    if (process.env.SCAN_DEBUG) dump('cell', before, after, plan.erase!.region);
    // Only the number's own area changes: the cell's borders around it stay pixel for pixel.
    expect(changedOutside(before, after, plan.erase!.region)).toBe(0);
  });
});
