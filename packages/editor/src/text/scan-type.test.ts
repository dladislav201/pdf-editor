import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { ScanFont } from '../ocr/scan-font';
import { TesseractEngine } from '../ocr/tesseract';
import type { Raster } from '../ocr/types';
import { analyzePage } from './analyze';
import { paragraphFrame } from './edit-session';
import { CUSTOM_FONT_BASE, GlyphStore, fallbackId } from './glyph-store';
import { layoutParagraph, type StyledChar } from './layout';
import { scanErase } from './scan-edit';
import { composeScanParagraph, growErase, scanChars, scanCustomFont, scanStyle, scanTracking, scanWritePlan, type PageScanFont } from './scan-type';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const fontFile = (file: string) => {
  const [, family, style] = /^(\w+)-(\w+)\.ttf$/.exec(file)!;
  const folder = { Regular: '400Regular', Bold: '700Bold', Italic: '400Regular_Italic', BoldItalic: '700Bold_Italic' }[style!]!;
  const bytes = readFileSync(join(dirname(require.resolve(`@expo-google-fonts/${family!.toLowerCase()}/package.json`)), folder, `${family}_${folder}.ttf`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const FILE = process.env.SCAN_FILE ?? new URL('../../test/fixtures/scan-invoice.pdf', import.meta.url);

let lib: Awaited<ReturnType<typeof init>>;
let subsetter: Subsetter;
let recognized: Uint8Array;
let scanFont: PageScanFont;

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
  const doc = new PdfiumDocument(lib, new Uint8Array(readFileSync(FILE)));
  try {
    const info = doc.pageInfo(0);
    const geometry = new PageGeometry(info.box, info.rotation, 300 / 72);
    const width = Math.round(geometry.width);
    const height = Math.round(geometry.height);
    const result = await recognizeRaster({ width, height, rgba: doc.render(0, width, height, [], false) }, engine);
    scanFont = { font: ScanFont.fromPage(result.straight.image, result.straight.words), geometry, angle: result.angle };
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

/** Replaces `find` with `replace` in the editor's chars: the rest keep their page glyphs. */
function replaceText(chars: StyledChar[], find: string, replace: string): StyledChar[] {
  const text = chars.map((c) => c.char).join('');
  const at = text.indexOf(find);
  if (at < 0) throw new Error(`"${find}" not in "${text}"`);
  const style = chars[at]!.style;
  return [...chars.slice(0, at), ...[...replace].map((char) => ({ char, style })), ...chars.slice(at + find.length)];
}

/** The editor's path for a recognized paragraph set in the scan's letters: lay out, compose, write. */
async function editInScanLetters(starts: string, change: (chars: StyledChar[]) => StyledChar[]) {
  const doc = new PdfiumDocument(lib, recognized);
  try {
    const page = analyzePage(doc.extractText(0));
    const paragraph = page.paragraphs.find((p) => p.recognized && p.text.startsWith(starts))!;
    const bold = paragraph.lines[0]!.chars.some((c) => (page.fonts[c.font]?.weight ?? 400) >= 600);
    const store = new GlyphStore(async (src, chars) => doc.glyphs(src.page, src.object, chars), async (file) => fontFile(file));
    store.registerFonts(page.fonts);
    const style = scanStyle(scanFont, paragraph, bold);
    const fallback = fallbackId('sans', bold ? 'Bold' : 'Regular');
    store.registerCustomFont(CUSTOM_FONT_BASE, scanCustomFont(scanFont, style, fallback, scanTracking(scanFont, style, paragraph)));
    await store.fallbackBytes(fallback);
    const chars = change(scanChars(paragraph, CUSTOM_FONT_BASE));
    const layout = layoutParagraph(chars, paragraphFrame(paragraph, page.block), (s, c) => store.advance(s, c));
    const frame = paragraphFrame(paragraph, page.block);
    const base = doc.scanPatch(0, growErase(scanErase(paragraph, 300 / 72), frame));
    const image = composeScanParagraph({ page: scanFont, style, base, paragraph, chars, layout, fallback: () => null });
    const plan = scanWritePlan(paragraph, chars, layout, { ...base, image }, bold);
    const used = (b: boolean) => new Set(plan.invisible!.filter((w) => w.bold === b).flatMap((w) => [...w.text]));
    doc.applyTextPlans([plan], {
      [-1]: subsetter.subset(new Uint8Array(fontFile('Arimo-Regular.ttf')), used(false)),
      [-2]: subsetter.subset(new Uint8Array(fontFile('Arimo-Bold.ttf')), used(true)),
    });
    return { paragraph, plan, base, bytes: doc.save() };
  } finally {
    doc.close();
  }
}

function render(bytes: Uint8Array) {
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

function recognizedTexts(bytes: Uint8Array): string[] {
  const doc = new PdfiumDocument(lib, bytes);
  try {
    return analyzePage(doc.extractText(0)).paragraphs.filter((p) => p.recognized).map((p) => p.text);
  } finally {
    doc.close();
  }
}

/** Optional before/after crops for a look by eye (SCAN_DEBUG=folder). */
function dump(name: string, before: ReturnType<typeof render>, after: ReturnType<typeof render>, box: { x: number; y: number; width: number; height: number }) {
  if (!process.env.SCAN_DEBUG) return;
  const [x0, y1] = before.geometry.toViewport([box.x - 30, box.y - 12]);
  const [x1, y0] = before.geometry.toViewport([box.x + box.width + 30, box.y + box.height + 12]);
  const w = Math.round(x1 - x0);
  const h = Math.round(y1 - y0);
  const canvas = createCanvas(w, h * 2 + 6);
  const ctx = canvas.getContext('2d');
  for (const [i, page] of [before, after].entries()) {
    const data = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) data.data[(y * w + x) * 4 + k] = page.rgba[((Math.round(y0) + y) * page.width + Math.round(x0) + x) * 4 + k]!;
    ctx.putImageData(data, 0, i * (h + 6));
  }
  writeFileSync(join(process.env.SCAN_DEBUG, `${name}.png`), canvas.toBuffer('image/png'));
}

describe('editing a scan in its own letters', () => {
  it('leaves an untouched paragraph as it was', async () => {
    const before = render(recognized);
    const { bytes, paragraph, plan } = await editInScanLetters('Разом без ПДВ', (chars) => chars);
    const after = render(bytes);
    dump('scan-letters-same', before, after, paragraph.box);
    const { origin, xAxis, yAxis } = plan.patch!;
    const [px0, py1] = before.geometry.toViewport([origin[0], origin[1]]);
    const [px1, py0] = before.geometry.toViewport([origin[0] + xAxis[0] + yAxis[0], origin[1] + xAxis[1] + yAxis[1]]);
    // Every word is put back from the scan's own pixels. A viewer may place the
    // piece a fraction of a pixel apart from the page image, so compare the ink, not each pixel.
    const [x0, y1] = before.geometry.toViewport([paragraph.box.x - 2, paragraph.box.y - 2]);
    const [x1, y0] = before.geometry.toViewport([paragraph.box.x + paragraph.box.width + 2, paragraph.box.y + paragraph.box.height + 2]);
    let inkBefore = 0;
    let inkAfter = 0;
    let outside = 0;
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        const o = (y * before.width + x) * 4;
        const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
        if (inside) {
          if (before.rgba[o]! < 128) inkBefore++;
          if (after.rgba[o]! < 128) inkAfter++;
        }
        const inPatch = x >= px0 - 1 && x <= px1 + 1 && y >= py0 - 1 && y <= py1 + 1;
        if (!inPatch && before.rgba[o] !== after.rgba[o]) outside++;
      }
    }
    expect(Math.abs(inkAfter - inkBefore)).toBeLessThan(inkBefore * 0.03);
    expect(outside).toBe(0);
    expect(recognizedTexts(bytes).join('\n')).toContain(paragraph.text);
  });

  it('writes a new amount in the scan\'s letters and keeps the text searchable', async () => {
    const before = render(recognized);
    const { bytes, paragraph } = await editInScanLetters('Разом без ПДВ', (chars) => replaceText(chars, '4779,50', '5120,00'));
    const after = render(bytes);
    dump('scan-letters-total', before, after, paragraph.box);
    const texts = recognizedTexts(bytes);
    expect(texts.join('\n')).toContain('Разом без ПДВ: 5120,00 грн');
    expect(texts.join('\n')).not.toContain('4779,50');
    // About as much ink as before: same weight and size, nothing left of the old number.
    const ink = (page: ReturnType<typeof render>) => {
      const [x0, y1] = page.geometry.toViewport([paragraph.box.x, paragraph.box.y]);
      const [x1, y0] = page.geometry.toViewport([paragraph.box.x + paragraph.box.width, paragraph.box.y + paragraph.box.height]);
      let n = 0;
      for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) if (page.rgba[(y * page.width + x) * 4]! < 128) n++;
      return n;
    };
    expect(ink(after)).toBeGreaterThan(ink(before) * 0.8);
    expect(ink(after)).toBeLessThan(ink(before) * 1.2);
  });

  it('sets a word the page spells with letters from elsewhere on the page', async () => {
    const before = render(recognized);
    const { bytes, paragraph } = await editInScanLetters('Постачальник', (chars) => replaceText(chars, 'Київ', 'Одеса'));
    dump('scan-letters-city', before, render(bytes), paragraph.box);
    expect(recognizedTexts(bytes).join('\n')).toMatch(/м\. Одеса, вул\. Тестова, 12/);
  });
});
