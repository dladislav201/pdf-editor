import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { beforeAll, describe, expect, it } from 'vitest';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { analyzePage } from './analyze';
import { searchPage } from './search';
import type { PageText } from './types';

const require = createRequire(import.meta.url);
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
let page: PageText;

beforeAll(async () => {
  const lib = initLibrary(await init({ wasmBinary: wasm }));
  const doc = new PdfiumDocument(lib, new Uint8Array(readFileSync(new URL('../../test/fixtures/chrome-contract.pdf', import.meta.url))));
  try {
    page = analyzePage(doc.extractText(0));
  } finally {
    doc.close();
  }
});

describe('searching page text', () => {
  it('finds a phrase with its box on the page', () => {
    const [match, ...rest] = searchPage(page, 'EUR 4,800');
    expect(rest).toEqual([]);
    expect(match).toMatchObject({ pageIndex: 0, text: 'EUR 4,800' });
    expect(match!.rects).toHaveLength(1);
    const { x, y, width, height } = match!.rects[0]!;
    // Inside the page, about one line high and a few words wide.
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(5);
    expect(height).toBeLessThan(20);
    expect(width).toBeGreaterThan(30);
  });

  it('ignores case and extra spaces unless asked not to', () => {
    const loose = searchPage(page, '  customer   SHALL ');
    expect(loose.length).toBeGreaterThan(0);
    expect(loose[0]!.text).toBe('Customer shall');
    expect(searchPage(page, 'customer SHALL', { caseSensitive: true })).toEqual([]);
  });

  it('finds a phrase that wraps onto the next line, with a box on each', () => {
    const paragraph = page.paragraphs.find((p) => p.lines.length > 1)!;
    const end = paragraph.lines[0]!.text.split(' ').at(-1)!;
    const start = paragraph.lines[1]!.text.split(' ')[0]!;
    const matches = searchPage(page, `${end} ${start}`);
    expect(matches.some((m) => m.rects.length === 2)).toBe(true);
  });

  it('finds nothing for an empty query', () => {
    expect(searchPage(page, '   ')).toEqual([]);
  });
});
