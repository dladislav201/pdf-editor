import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { PageGeometry } from '../engine/page-geometry';
import { createSubsetter, type Subsetter } from '../engine/hb-subset';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { exportPdf } from '../export';
import { analyzePage } from './analyze';
import { paragraphChars, paragraphFrame } from './edit-session';
import { GlyphStore, fallbackFile } from './glyph-store';
import { layoutParagraph, type StyledChar } from './layout';
import type { TextParagraph } from './types';
import { withWordFallback } from './word-fonts';
import { buildWritePlan, type TextWritePlan } from './write-plan';

const require = createRequire(import.meta.url);
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
/** Fallback fonts straight from their packages, by the names the editor serves them under. */
async function loadFallback(file: string): Promise<ArrayBuffer> {
  const [, family, style] = /^(\w+)-(\w+)\.ttf$/.exec(file)!;
  const folder = { Regular: '400Regular', Bold: '700Bold', Italic: '400Regular_Italic', BoldItalic: '700Bold_Italic' }[style!]!;
  const bytes = readFileSync(join(dirname(require.resolve(`@expo-google-fonts/${family!.toLowerCase()}/package.json`)), folder, `${family}_${folder}.ttf`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));
let lib: Awaited<ReturnType<typeof init>>;
let subsetter: Subsetter;

beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
  subsetter = await createSubsetter(readFileSync(join(dirname(require.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')));
});

/** Replaces the first occurrence of `find` with `replace`, typed in the style of the text it replaces. */
function replaceText(chars: StyledChar[], find: string, replace: string): StyledChar[] {
  const text = chars.map((c) => c.char).join('');
  const at = text.indexOf(find);
  if (at < 0) throw new Error(`"${find}" not in "${text}"`);
  const style = chars[at]!.style;
  return [...chars.slice(0, at), ...[...replace].map((char) => ({ char, style })), ...chars.slice(at + find.length)];
}

interface Edited {
  paragraph: TextParagraph;
  plan: TextWritePlan;
  bytes: Uint8Array;
  /** Vertical band (user space) the paragraph occupies before or after the edit. */
  band: [number, number];
}

/** Runs the editor's save path headlessly: read, edit, lay out, plan, write, export. */
async function editParagraph(
  source: Uint8Array,
  starts: string,
  change: (chars: StyledChar[]) => StyledChar[],
): Promise<Edited> {
  const doc = new PdfiumDocument(lib, source);
  try {
    const page = analyzePage(doc.extractText(0));
    const paragraph = page.paragraphs.find((p) => p.text.startsWith(starts))!;
    const store = new GlyphStore(async (src, chars) => doc.glyphs(src.page, src.object, chars), loadFallback);
    store.registerFonts(page.fonts);
    for (const c of paragraph.lines.flatMap((l) => l.chars)) {
      await store.ensure(c.font, { page: 0, object: c.object }, [...paragraph.text]);
    }
    const chars = change(paragraphChars(paragraph, (style, char) => store.advance(style, char)));
    for (const c of paragraph.lines.flatMap((l) => l.chars)) {
      await store.ensure(c.font, { page: 0, object: c.object }, chars.map((x) => x.char));
    }
    const layout = layoutParagraph(withWordFallback(chars, store), paragraphFrame(paragraph, page.block), (style, char) =>
      store.advance(style, char),
    );
    let plan = buildWritePlan(paragraph, chars, layout, store);
    // Fallback fonts load on first use; once they're in, lay out again with their real advances.
    if (plan.fallback.length) {
      await Promise.all(plan.fallback.map((word) => store.fallbackBytes(word.font)));
      const settled = layoutParagraph(withWordFallback(chars, store), paragraphFrame(paragraph, page.block), (style, char) =>
        store.advance(style, char),
      );
      plan = buildWritePlan(paragraph, chars, settled, store);
    }
    // As the worker does: each fallback font goes in subset to the characters its words use.
    const fallbackFonts: Record<number, Uint8Array> = {};
    for (const font of new Set(plan.fallback.map((w) => w.font))) {
      const chars = plan.fallback.filter((w) => w.font === font).flatMap((w) => [...w.text]);
      fallbackFonts[font] = subsetter.subset(new Uint8Array((await store.fallbackBytes(font))!), chars);
    }
    doc.applyTextPlans([plan], fallbackFonts);
    const bytes = await exportPdf(doc.save(), []);
    const last = layout.lines[layout.lines.length - 1]!;
    const size = Math.max(...chars.map((c) => c.style.size));
    const band: [number, number] = [
      Math.min(paragraph.box.y, last.baseline - size),
      paragraph.box.y + paragraph.box.height,
    ];
    return { paragraph, plan, bytes, band };
  } finally {
    doc.close();
  }
}

function render(bytes: Uint8Array): { rgba: Uint8ClampedArray; geometry: PageGeometry; width: number } {
  const doc = new PdfiumDocument(lib, bytes);
  try {
    const info = doc.pageInfo(0);
    const geometry = new PageGeometry(info.box, info.rotation, 1);
    const width = Math.round(geometry.width);
    return { rgba: doc.render(0, width, Math.round(geometry.height)), geometry, width };
  } finally {
    doc.close();
  }
}

/** Rows (in page points, y up) where two renders differ. */
function changedRows(a: Uint8Array, b: Uint8Array): number[] {
  const before = render(a);
  const after = render(b);
  const rows = new Set<number>();
  for (let i = 0; i < before.rgba.length; i += 4) {
    if (Math.abs(before.rgba[i]! - after.rgba[i]!) + Math.abs(before.rgba[i + 1]! - after.rgba[i + 1]!) > 0) {
      const row = Math.floor(i / 4 / before.width);
      rows.add(Math.round(before.geometry.toPdf([0, row])[1]));
    }
  }
  return [...rows].sort((x, y) => x - y);
}

/** Dark pixels inside a word's box: a glyph that didn't embed renders as nothing. */
function inkOf(bytes: Uint8Array, word: { x: number; y: number; size: number; text: string }): number {
  const { rgba, geometry, width } = render(bytes);
  const [x0, y0] = geometry.toViewport([word.x, word.y + word.size * 0.75]);
  const [x1, y1] = geometry.toViewport([word.x + word.text.length * word.size * 0.5, word.y]);
  let dark = 0;
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) if (rgba[(y * width + x) * 4]! < 140) dark++;
  }
  return dark;
}

function paragraphTexts(bytes: Uint8Array): string[] {
  const doc = new PdfiumDocument(lib, bytes);
  try {
    return analyzePage(doc.extractText(0)).paragraphs.map((p) => p.text);
  } finally {
    doc.close();
  }
}

describe('writing edited text into the PDF', () => {
  it('rewrites an unchanged paragraph without changing a single pixel', async () => {
    const original = fixture('chrome-contract.pdf');
    const { plan, bytes } = await editParagraph(original, 'Customer shall pay', (chars) => chars);
    // Every glyph keeps its own page object in place: nothing is removed, added or redrawn.
    expect(plan).toMatchObject({ remove: [], moves: [], words: [], fallback: [] });
    expect(changedRows(original, bytes)).toEqual([]);
  });

  it('replaces a number in justified text and only touches that paragraph', async () => {
    const original = fixture('chrome-contract.pdf');
    const { bytes, band, plan } = await editParagraph(original, 'Customer shall pay', (chars) =>
      replaceText(chars, '4,800', '5,250'),
    );
    expect(plan.words.map((w) => w.text)).toEqual(['5,250']);
    const texts = paragraphTexts(bytes);
    expect(texts.find((t) => t.startsWith('Customer shall pay'))).toContain('fee of EUR 5,250 for up to 250 named users');
    expect(texts).toHaveLength(8);
    for (const row of changedRows(original, bytes)) {
      expect(row).toBeGreaterThanOrEqual(Math.floor(band[0]));
      expect(row).toBeLessThanOrEqual(Math.ceil(band[1]));
    }
  });

  it('writes characters a subset font lacks in the fallback font', async () => {
    const original = fixture('chrome-contract.pdf');
    const { bytes, plan } = await editParagraph(original, 'Customer shall pay', (chars) =>
      replaceText(chars, 'named users', 'named users (Жовква)'),
    );
    // The whole word goes to the fallback font, not just the letters the subset lacks.
    expect(plan.fallback.map((w) => w.text)).toContain('(Жовква),');
    const text = paragraphTexts(bytes).find((t) => t.startsWith('Customer shall pay'))!;
    expect(text).toContain('Жовква');
    // And it is actually drawn: every letter of the fallback word leaves ink.
    const word = plan.fallback.find((w) => w.text === '(Жовква),')!;
    expect(inkOf(bytes, word)).toBeGreaterThan(word.text.length * 8);
  });

  it('picks a fallback that matches the family: serif text gets Tinos, not a sans font', async () => {
    const original = fixture('chrome-contract.pdf');
    // The Times subset has no "x", so "thirty-six" needs the fallback.
    const { bytes, plan } = await editParagraph(original, 'The initial term', (chars) =>
      replaceText(chars, 'twenty-four (24)', 'thirty-six (36)'),
    );
    expect(plan.fallback.map((w) => [w.text, fallbackFile(w.font)])).toContainEqual(['thirty-six', 'Tinos-Regular.ttf']);
    expect(inkOf(bytes, plan.fallback.find((w) => w.text === 'thirty-six')!)).toBeGreaterThan(60);
    expect(paragraphTexts(bytes).find((t) => t.startsWith('The initial term'))).toContain('thirty-six (36) months');
  });

  it('edits a line drawn as one text object (macOS Quartz)', async () => {
    const original = fixture('quartz-invoice.pdf');
    const { bytes, plan } = await editParagraph(original, 'Amount due', (chars) => replaceText(chars, '4,800.00', '8,400.00'));
    // One object per line: the touched lines are redrawn as words, the old objects removed.
    expect(plan.remove.length).toBeGreaterThan(0);
    expect(plan.fallback).toEqual([]);
    expect(paragraphTexts(bytes)[1]).toBe('Amount due: EUR 8,400.00 payable within 30 days. Thank you for your business.');
  });

  it('edits text in a standard font that is not embedded', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('Total due within thirty days of the invoice date.', { x: 40, y: 250, size: 11, font });
    const original = await doc.save();
    const { bytes } = await editParagraph(original, 'Total due', (chars) => replaceText(chars, 'thirty', 'fourteen'));
    expect(paragraphTexts(bytes)).toEqual(['Total due within fourteen days of the invoice date.']);
  });
});
