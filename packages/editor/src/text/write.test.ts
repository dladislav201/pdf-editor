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
import { layoutParagraph, type CharStyle, type StyledChar } from './layout';
import { pushDown, type PushItem } from './push';
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

/** Opens page 1 of `source` for editing as the editor does: its text model and a glyph store with every font loaded. */
async function openPage(doc: PdfiumDocument) {
  const page = analyzePage(doc.extractText(0));
  const store = new GlyphStore(async (src, chars) => doc.glyphs(src.page, src.object, chars), loadFallback);
  store.registerFonts(page.fonts);
  const pageFonts = new Map<number, number>();
  for (const c of page.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.chars))) {
    if (!pageFonts.has(c.font)) pageFonts.set(c.font, c.object);
  }
  for (const [font, object] of pageFonts) await store.ensure(font, { page: 0, object }, []);
  return { page, store, pageFonts };
}

async function fallbackFontsOf(plans: TextWritePlan[], store: GlyphStore): Promise<Record<number, Uint8Array>> {
  const fonts: Record<number, Uint8Array> = {};
  for (const font of new Set(plans.flatMap((p) => p.fallback.map((w) => w.font)))) {
    const chars = plans.flatMap((p) => p.fallback.filter((w) => w.font === font).flatMap((w) => [...w.text]));
    fonts[font] = subsetter.subset(new Uint8Array((await store.fallbackBytes(font))!), chars);
  }
  return fonts;
}

/** Fonts (PostScript names) the saved page draws each word of a paragraph in. */
function wordFonts(bytes: Uint8Array, starts: string): Map<string, string> {
  const doc = new PdfiumDocument(lib, bytes);
  try {
    const raw = doc.extractText(0);
    const paragraph = analyzePage(raw).paragraphs.find((p) => p.text.startsWith(starts))!;
    const words = new Map<string, string>();
    for (const line of paragraph.lines) {
      line.wordStarts.forEach((start, i) => {
        const chars = line.chars.slice(start, line.wordStarts[i + 1] ?? line.chars.length);
        words.set(chars.map((c) => c.text).join(''), raw.fonts[chars[0]!.font]!.name);
      });
    }
    return words;
  } finally {
    doc.close();
  }
}

describe('bold and italic', () => {
  async function restyle(want: { bold: boolean; italic: boolean }, word: string): Promise<{ bytes: Uint8Array; plan: TextWritePlan }> {
    const source = await PDFDocument.create();
    const regular = await source.embedFont(StandardFonts.Helvetica);
    const bold = await source.embedFont(StandardFonts.HelveticaBold);
    const pdfPage = source.addPage([400, 300]);
    pdfPage.drawText('Payment terms', { x: 40, y: 270, size: 14, font: bold });
    pdfPage.drawText('Total due within thirty days of the invoice date.', { x: 40, y: 240, size: 11, font: regular });
    const doc = new PdfiumDocument(lib, await source.save());
    try {
      const { page, store, pageFonts } = await openPage(doc);
      const paragraph = page.paragraphs.find((p) => p.text.startsWith('Total due'))!;
      const chars = paragraphChars(paragraph, (style, char) => store.advance(style, char));
      const at = paragraph.text.indexOf(word);
      const styled = chars.map((c, i) => {
        if (i < at || i >= at + word.length) return c;
        const font = store.variant(c.style.font, want, pageFonts.keys())!;
        return { char: c.char, style: { ...c.style, font, base: c.style.font } };
      });
      const lay = () => layoutParagraph(withWordFallback(styled, store), paragraphFrame(paragraph, page.block), (s, c) => store.advance(s, c));
      let plan = buildWritePlan(paragraph, styled, lay(), store, pageFonts);
      await Promise.all(plan.fallback.map((w) => store.fallbackBytes(w.font)));
      plan = buildWritePlan(paragraph, styled, lay(), store, pageFonts);
      doc.applyTextPlans([plan], await fallbackFontsOf([plan], store));
      return { bytes: doc.save(), plan };
    } finally {
      doc.close();
    }
  }

  it('makes a word bold in the bold font the page already uses', async () => {
    const { bytes, plan } = await restyle({ bold: true, italic: false }, 'thirty');
    expect(plan.fallback).toEqual([]);
    const fonts = wordFonts(bytes, 'Total due');
    expect(fonts.get('thirty')).toBe('Helvetica-Bold');
    expect(fonts.get('days')).toBe('Helvetica');
    expect(paragraphTexts(bytes)).toContain('Total due within thirty days of the invoice date.');
  });

  it('makes a word italic in the matching fallback when the page has no italic', async () => {
    const { bytes, plan } = await restyle({ bold: false, italic: true }, 'invoice');
    expect(plan.fallback.map((w) => [w.text, fallbackFile(w.font)])).toEqual([['invoice', 'Arimo-Italic.ttf']]);
    expect(wordFonts(bytes, 'Total due').get('invoice')).toMatch(/Arimo-Italic/);
    expect(inkOf(bytes, plan.fallback[0]!)).toBeGreaterThan(60);
  });
});

describe('text size and typeface', () => {
  /** Two lines of Helvetica 11 pt, and a line in Times so the page has a second family. */
  async function source(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const times = await pdf.embedFont(StandardFonts.TimesRoman);
    const page = pdf.addPage([400, 300]);
    page.drawText('Total due within thirty days of the invoice date', { x: 40, y: 240, size: 11, font: helvetica });
    page.drawText('by bank transfer to the account below.', { x: 40, y: 226, size: 11, font: helvetica });
    page.drawText('Signed in Kyiv', { x: 40, y: 120, size: 12, font: times });
    page.drawText('Approved', { x: 40, y: 100, size: 12, font: bold });
    return pdf.save();
  }

  /** Restyles `word` of the paragraph, saves, and reads the paragraph back: each word's font and size, and line baselines. */
  async function restyle(word: string, change: (style: CharStyle, store: GlyphStore, fonts: number[]) => CharStyle) {
    const doc = new PdfiumDocument(lib, await source());
    try {
      const { page, store, pageFonts } = await openPage(doc);
      const paragraph = page.paragraphs.find((p) => p.text.startsWith('Total due'))!;
      const chars = paragraphChars(paragraph, (style, char) => store.advance(style, char));
      const at = paragraph.text.indexOf(word);
      const styled = chars.map((c, i) => (i < at || i >= at + word.length ? c : { char: c.char, style: change(c.style, store, [...pageFonts.keys()]) }));
      const lay = () => layoutParagraph(withWordFallback(styled, store), paragraphFrame(paragraph, page.block), (st, c) => store.advance(st, c));
      let plan = buildWritePlan(paragraph, styled, lay(), store, pageFonts);
      await Promise.all(plan.fallback.map((w) => store.fallbackBytes(w.font)));
      plan = buildWritePlan(paragraph, styled, lay(), store, pageFonts);
      doc.applyTextPlans([plan], await fallbackFontsOf([plan], store));
      const bytes = doc.save();
      const saved = new PdfiumDocument(lib, bytes);
      try {
        const raw = saved.extractText(0);
        // Lines set apart by larger text may read as paragraphs of their own: look at every line.
        const lines = analyzePage(raw).paragraphs.flatMap((p) => p.lines);
        const after = analyzePage(raw).paragraphs.find((p) => p.text.startsWith('Total due'))!;
        const words = new Map<string, { font: string; size: number }>();
        for (const line of lines) {
          line.wordStarts.forEach((start, i) => {
            const glyphs = line.chars.slice(start, line.wordStarts[i + 1] ?? line.chars.length);
            words.set(glyphs.map((c) => c.text).join(''), { font: raw.fonts[glyphs[0]!.font]!.name, size: Math.round(glyphs[0]!.size * 10) / 10 });
          });
        }
        // The paragraph's first line, and the one with "bank" (set anew, the first line may now wrap earlier).
        const baselines = ['Total due', 'bank'].map((word) => lines.find((l) => l.text.includes(word))!.baseline);
        return { words, baselines, text: after.text, families: store.families(pageFonts.keys()) };
      } finally {
        saved.close();
      }
    } finally {
      doc.close();
    }
  }

  it('offers the families the page uses, then the standard ones', async () => {
    const { families } = await restyle('thirty', (style) => style);
    expect(families.map((f) => f.name)).toEqual(['Helvetica', 'Times', 'Arimo', 'Tinos', 'Cousine']);
    expect(families.map((f) => f.kind)).toEqual(['document', 'document', 'standard', 'standard', 'standard']);
  });

  it('sets a word larger and gives its line more room', async () => {
    const first = await restyle('thirty', (style) => ({ ...style, size: 18 }));
    expect(first.text).toContain('Total due within thirty days of the invoice date');
    expect(first.words.get('thirty')).toEqual({ font: 'Helvetica', size: 18 });
    expect(first.words.get('days')).toEqual({ font: 'Helvetica', size: 11 });
    // The first line keeps its top: its baseline moves down by the larger ascent, and the next line follows.
    expect(first.baselines[0]).toBeLessThan(240 - 4);
    expect(first.baselines[0]! - first.baselines[1]!).toBeCloseTo(14, 0);
    // Larger text on the second line: the first stays, the second moves away from it.
    const second = await restyle('bank', (style) => ({ ...style, size: 18 }));
    expect(second.baselines[0]).toBeCloseTo(240, 1);
    expect(second.baselines[0]! - second.baselines[1]!).toBeGreaterThan(14 * 1.4);
  });

  it('sets a word in another family of the page, or in a standard one keeping bold', async () => {
    const times = await restyle('thirty', (style, store, fonts) => ({ ...style, font: store.familyFont('doc:times', { bold: false, italic: false }, fonts)! }));
    expect(times.words.get('thirty')?.font).toBe('Times-Roman');
    const bold = await restyle('thirty', (style, store, fonts) => ({ ...style, font: store.familyFont('serif', { bold: true, italic: false }, fonts)! }));
    expect(bold.words.get('thirty')?.font).toMatch(/Tinos-Bold/);
    // Helvetica's bold is on the page: bold in Helvetica's family uses it, not a fallback.
    const own = await restyle('days', (style, store, fonts) => ({ ...style, font: store.familyFont('doc:helvetica', { bold: true, italic: false }, fonts)! }));
    expect(own.words.get('days')?.font).toBe('Helvetica-Bold');
  });
});

describe('a paragraph that grows', () => {
  /** A column: a paragraph of three lines, a rule under it and a paragraph after that. */
  async function column(): Promise<Uint8Array> {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    const page = source.addPage([400, 400]);
    const lines = [
      'The supplier delivers the goods to the address',
      'given in the order within ten working days and',
      'informs the customer of the delivery date.',
    ];
    lines.forEach((text, i) => page.drawText(text, { x: 40, y: 350 - i * 14, size: 11, font }));
    page.drawLine({ start: { x: 40, y: 300 }, end: { x: 300, y: 300 }, thickness: 1 });
    page.drawText('Payment is due within thirty days.', { x: 40, y: 280, size: 11, font });
    return source.save();
  }

  it('pushes the rule and the text below down, in the file as on screen', async () => {
    const doc = new PdfiumDocument(lib, await column());
    try {
      const { page, store } = await openPage(doc);
      const paragraph = page.paragraphs.find((p) => p.text.startsWith('The supplier'))!;
      const chars = paragraphChars(paragraph, (s, c) => store.advance(s, c));
      const style = chars[chars.length - 1]!.style;
      const longer = [...chars, ...[...' Partial deliveries are allowed if the customer agrees.'].map((char) => ({ char, style }))];
      const layout = layoutParagraph(longer, paragraphFrame(paragraph, page.block), (s, c) => store.advance(s, c));
      const growth = paragraph.lines[paragraph.lines.length - 1]!.baseline - layout.lines[layout.lines.length - 1]!.baseline;
      expect(layout.lines.length).toBeGreaterThan(paragraph.lines.length);

      const items: PushItem[] = [
        ...page.paragraphs.map((p) => ({ id: p.id, box: p.box, ...(p.id === paragraph.id ? { growth } : {}) })),
        ...page.graphics.map((g) => ({ id: `g${g.object}`, box: g.box, graphic: true })),
      ];
      const shifts = pushDown(items, { keepGap: paragraph.leading * 2, page: { x: 0, y: 0, width: 400, height: 400 } })!;
      const after = page.paragraphs.find((p) => p.text.startsWith('Payment'))!;
      expect(shifts.get(after.id)).toBeCloseTo(growth, 1);
      expect(page.graphics).toHaveLength(1);
      expect(shifts.get(`g${page.graphics[0]!.object}`)).toBeCloseTo(growth, 1);

      const moves = [
        ...after.lines.flatMap((l) => l.chars.map((c) => c.object)),
        page.graphics[0]!.object,
      ].map((object) => ({ object, dx: 0, dy: -growth }));
      // The editor shows the moves by rendering with them; saving must look the same.
      const shown = doc.render(0, 400, 400, [], false, [...new Map(moves.map((m) => [m.object, m])).values()]);
      const plan = buildWritePlan(paragraph, longer, layout, store);
      plan.moves.push(...new Map(moves.map((m) => [m.object, m])).values());
      doc.applyTextPlans([plan], {});
      const saved = new PdfiumDocument(lib, doc.save());
      try {
        const text = analyzePage(saved.extractText(0));
        const moved = text.paragraphs.find((p) => p.text.startsWith('Payment'))!;
        expect(moved.lines[0]!.baseline).toBeCloseTo(after.lines[0]!.baseline - growth, 1);
        expect(text.graphics[0]!.box.y).toBeCloseTo(page.graphics[0]!.box.y - growth, 1);
        // Nothing overlaps: the grown paragraph ends above the rule.
        const grown = text.paragraphs.find((p) => p.text.startsWith('The supplier'))!;
        expect(grown.box.y).toBeGreaterThan(text.graphics[0]!.box.y + text.graphics[0]!.box.height);
        // Below the edited paragraph the screen and the file agree.
        const final = saved.render(0, 400, 400, [], false);
        const rule = page.graphics[0]!.box;
        let differ = 0;
        for (let row = Math.floor(400 - (rule.y + rule.height - growth)); row < 400; row++) {
          for (let x = 0; x < 400 * 4; x++) if (shown[row * 1600 + x] !== final[row * 1600 + x]) differ++;
        }
        expect(differ).toBe(0);
      } finally {
        saved.close();
      }
    } finally {
      doc.close();
    }
  });

  it('pulls the rule and the text below up when it gets shorter, in the file as on screen', async () => {
    const doc = new PdfiumDocument(lib, await column());
    try {
      const { page, store } = await openPage(doc);
      const paragraph = page.paragraphs.find((p) => p.text.startsWith('The supplier'))!;
      const chars = paragraphChars(paragraph, (s, c) => store.advance(s, c));
      // Without its last line: "… within ten working days."
      const end = paragraph.text.indexOf(' and informs');
      const shorter = [...chars.slice(0, end), { char: '.', style: chars[end - 1]!.style }];
      const layout = layoutParagraph(shorter, paragraphFrame(paragraph, page.block), (s, c) => store.advance(s, c));
      const growth = paragraph.lines[paragraph.lines.length - 1]!.baseline - layout.lines[layout.lines.length - 1]!.baseline;
      expect(layout.lines).toHaveLength(2);
      expect(growth).toBeCloseTo(-14, 1);

      const items: PushItem[] = [
        ...page.paragraphs.map((p) => ({ id: p.id, box: p.box, ...(p.id === paragraph.id ? { growth } : {}) })),
        ...page.graphics.map((g) => ({ id: `g${g.object}`, box: g.box, graphic: true })),
      ];
      const shifts = pushDown(items, { keepGap: paragraph.leading * 2, page: { x: 0, y: 0, width: 400, height: 400 } })!;
      const after = page.paragraphs.find((p) => p.text.startsWith('Payment'))!;
      const rule = page.graphics[0]!;
      expect(shifts.get(after.id)).toBeCloseTo(-14, 1);
      expect(shifts.get(`g${rule.object}`)).toBeCloseTo(-14, 1);

      const moves = [...new Set([...after.lines.flatMap((l) => l.chars.map((c) => c.object)), rule.object])].map((object) => ({
        object,
        dx: 0,
        dy: 14,
      }));
      const plan = buildWritePlan(paragraph, shorter, layout, store);
      plan.moves.push(...moves);
      doc.applyTextPlans([plan], {});
      const saved = new PdfiumDocument(lib, doc.save());
      try {
        const text = analyzePage(saved.extractText(0));
        expect(text.paragraphs.find((p) => p.text.startsWith('The supplier'))!.text).toBe(
          'The supplier delivers the goods to the address given in the order within ten working days.',
        );
        expect(text.paragraphs.find((p) => p.text.startsWith('Payment'))!.lines[0]!.baseline).toBeCloseTo(after.lines[0]!.baseline + 14, 1);
        expect(text.graphics[0]!.box.y).toBeCloseTo(rule.box.y + 14, 1);
      } finally {
        saved.close();
      }
    } finally {
      doc.close();
    }
  });
});
