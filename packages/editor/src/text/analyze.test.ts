import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  setTextRenderingMode,
} from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { analyzePage } from './analyze';
import type { PageText } from './types';

const require = createRequire(import.meta.url);
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));
let lib: Awaited<ReturnType<typeof init>>;

beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
});

function analyze(bytes: Uint8Array, pageIndex = 0): PageText {
  const doc = new PdfiumDocument(lib, bytes);
  try {
    return analyzePage(doc.extractText(pageIndex));
  } finally {
    doc.close();
  }
}

const fontNames = (page: PageText, index: number) =>
  [...new Set(page.paragraphs[index]!.lines.flatMap((l) => l.runs).map((r) => page.fonts[r.font]!.name.replace(/^[A-Z]{6}\+/, '')))];

describe('layout analysis', () => {
  it('reads a Chrome document: headings, mixed styles, justified text, Cyrillic', () => {
    const page = analyze(fixture('chrome-contract.pdf'));
    expect(page.paragraphs.map((p) => p.text.slice(0, 24))).toEqual([
      'Software Services Agreem',
      'Agreement No. NW-2026-04',
      'This Software Services A',
      '2. Fees and Payment',
      'Customer shall pay a mon',
      'The initial term is twen',
      '3. Українською',
      'Замовник сплачує щомісяч',
    ]);
    expect(page.paragraphs.map((p) => p.align)).toEqual(['left', 'left', 'left', 'left', 'justify', 'left', 'left', 'left']);
    expect(page.paragraphs.map((p) => p.lines.length)).toEqual([1, 1, 2, 1, 3, 2, 1, 2]);
    expect(page.paragraphs.every((p) => p.editable)).toBe(true);

    // Bold and italic words inside a paragraph are runs, not separate paragraphs.
    expect(fontNames(page, 2)).toEqual(['ArialMT', 'Arial-BoldMT', 'Arial-ItalicMT']);
    expect(page.paragraphs[2]!.text).toContain('between Northwind Software Ltd., a company registered in Ireland, and Contoso');

    // 11 pt × line-height 1.45; sizes come out in visible points, not text-space units.
    expect(page.paragraphs[4]!.leading).toBeCloseTo(15.95, 0);
    expect(page.paragraphs[4]!.lines[0]!.size).toBeCloseTo(11, 1);
    expect(page.paragraphs[0]!.lines[0]!.size).toBeCloseTo(18, 1);
    expect(page.paragraphs[4]!.text).toContain('EUR 4,800 for up to 250 named users');
  });

  it('separates columns, table cells, list items and indented paragraphs', () => {
    const page = analyze(fixture('chrome-layouts.pdf'));
    const texts = page.paragraphs.map((p) => p.text);
    const find = (start: string) => page.paragraphs.find((p) => p.text.startsWith(start))!;

    expect(find('Centered Title').align).toBe('center');
    expect(find('Prepared for').align).toBe('right');
    expect(find('Prepared for').lines).toHaveLength(2);

    const first = find('The first paragraph');
    const second = find('The second paragraph');
    expect([first.lines.length, second.lines.length]).toEqual([3, 2]);
    expect([first.align, second.align]).toEqual(['justify', 'justify']);
    expect(first.indent).toBeCloseTo(17.25, 0); // text-indent 1.5em at 11.5pt

    expect(find('Left column').text).not.toContain('Right column');
    expect(find('Right column').lines.length).toBeGreaterThan(1);

    for (const cell of ['Severity', 'First response', 'Resolution', 'Critical', '30 minutes', '4 hours', 'High', '2 hours', '1 business day']) {
      expect(texts).toContain(cell);
    }
    expect(texts).toContain('First bullet point with a short sentence.');
    expect(find('Second bullet point').lines).toHaveLength(2);

    // Sub/superscripts stay inside their line.
    expect(texts).toContain('Water is H2O and the area is 25 m2, see note1 below.');
    expect(texts.filter((t) => /^\d$/.test(t))).toEqual([]);
  });

  it('reads a macOS Quartz document with one text object per line', () => {
    const page = analyze(fixture('quartz-invoice.pdf'));
    expect(page.paragraphs.map((p) => p.text)).toEqual([
      'Invoice INV-2026-118',
      'Amount due: EUR 4,800.00 payable within 30 days. Thank you for your business.',
    ]);
    // Monospaced text with natural spaces is not mistaken for justified text.
    expect(page.paragraphs[1]!.align).toBe('left');
    expect(page.paragraphs[1]!.lines[0]!.size).toBeCloseTo(12, 1);
  });

  it('reads invisible (OCR) text as recognized, ignores rotated text and marks text in form XObjects read-only', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 400]);
    page.drawText('Visible text', { x: 40, y: 350, size: 12, font });
    page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
    page.drawText('Invisible OCR layer', { x: 40, y: 300, size: 12, font });
    page.pushOperators(popGraphicsState());
    page.drawText('Rotated text', { x: 300, y: 100, size: 12, font, rotate: degrees(90) });

    const source = await PDFDocument.create();
    source.addPage([200, 50]).drawText('Inside a form', { x: 10, y: 20, size: 12, font: await source.embedFont(StandardFonts.Helvetica) });
    const [embedded] = await doc.embedPdf(await source.save());
    page.drawPage(embedded!, { x: 40, y: 200 });

    const result = analyze(await doc.save());
    expect(result.paragraphs.map((p) => p.text)).toEqual(['Visible text', 'Invisible OCR layer', 'Inside a form']);
    expect(result.paragraphs[0]!.editable).toBe(true);
    expect(result.paragraphs[1]).toMatchObject({ editable: true, recognized: true });
    expect(result.paragraphs[2]).toMatchObject({ editable: false, reason: expect.stringContaining('form XObject') });
  });

  it('marks paragraphs that share a page object with other text as read-only', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([500, 200]);
    // One text-show operation spanning two "cells".
    page.drawText(`Left cell${' '.repeat(30)}Right cell`, { x: 20, y: 150, size: 11, font });
    page.drawText('On its own', { x: 20, y: 100, size: 11, font });

    const result = analyze(await doc.save());
    expect(result.paragraphs.map((p) => [p.text, p.editable])).toEqual([
      ['Left cell', false],
      ['Right cell', false],
      ['On its own', true],
    ]);
  });

  it('keeps ragged-right paragraphs left aligned and joins hyphenated lines', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 400]);
    // Greedy wrapping at 180 pt, breaking "left-aligned" after its hyphen, like a word processor.
    const text = 'A ragged paragraph whose lines end at different places, as plain left-aligned text does when it wraps naturally inside its column.';
    const tokens = text.split(' ').flatMap((word) => (word === 'left-aligned' ? ['left-', 'aligned'] : [word]));
    const lines: string[] = [];
    for (const token of tokens) {
      const current = lines[lines.length - 1];
      const joined = current === undefined ? token : current.endsWith('-') ? current + token : `${current} ${token}`;
      if (current !== undefined && font.widthOfTextAtSize(joined, 11) <= 180) lines[lines.length - 1] = joined;
      else lines.push(token);
    }
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 350 - i * 14, size: 11, font }));

    const [paragraph] = analyze(await doc.save()).paragraphs;
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.some((line) => line.endsWith('left-'))).toBe(true);
    expect(paragraph!.lines).toHaveLength(lines.length);
    expect(paragraph!.align).toBe('left');
    expect(paragraph!.leading).toBeCloseTo(14, 1);
    expect(paragraph!.text).toBe(text);
  });
});
