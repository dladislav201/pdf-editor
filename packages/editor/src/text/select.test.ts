import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { beforeAll, describe, expect, it } from 'vitest';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import type { Point } from '../types';
import { analyzePage } from './analyze';
import { nearestPosition, positionAt, selectableLines, selection } from './select';
import type { PageText, TextLine } from './types';

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

/** The middle of a line's `i`-th glyph's left or right edge. */
const edge = (line: TextLine, i: number, side: 'left' | 'right'): Point => {
  const box = line.chars[i]!.box;
  return [side === 'left' ? box.x + 0.5 : box.x + box.width - 0.5, box.y + box.height / 2];
};

describe('selecting page text by dragging', () => {
  it('selects the words between two points on a line, with one box', () => {
    const lines = selectableLines(page);
    const index = lines.findIndex((l) => l.line.text.split(' ').length >= 4);
    const line = lines[index]!.line;
    const [first, second] = line.wordStarts;
    const third = line.wordStarts[2]!;
    const start = positionAt(lines, edge(line, first!, 'left'))!;
    const end = positionAt(lines, edge(line, third - 1, 'right'))!;
    expect(start).toEqual({ line: index, at: first });
    const picked = selection(lines, start, end);
    expect(picked.text).toBe(line.text.split(' ').slice(0, 2).join(' '));
    expect(picked.rects).toHaveLength(1);
    const [rect] = picked.rects;
    expect(rect!.x).toBeCloseTo(line.chars[first!]!.box.x, 1);
    expect(rect!.x + rect!.width).toBeGreaterThan(line.chars[second! - 1]!.box.x);
    // Dragging back from the end gives the same.
    expect(selection(lines, end, start)).toEqual(picked);
  });

  it('follows the text onto the next line, a box per line', () => {
    const paragraph = page.paragraphs.find((p) => p.lines.length > 2)!;
    const lines = selectableLines(page);
    const top = lines.findIndex((l) => l.line === paragraph.lines[0]);
    const [first, , third] = paragraph.lines;
    const start = positionAt(lines, edge(first!, first!.chars.length - 3, 'left'))!;
    const end = positionAt(lines, edge(third!, 2, 'right'))!;
    const picked = selection(lines, start, end);
    expect(picked.rects).toHaveLength(3);
    // The middle line is selected whole.
    expect(picked.rects[1]!.x).toBeCloseTo(paragraph.lines[1]!.box.x, 0);
    expect(picked.rects[1]!.width).toBeCloseTo(paragraph.lines[1]!.box.width, 0);
    expect(picked.text.startsWith(first!.text.slice(-3))).toBe(true);
    expect(picked.text).toContain(paragraph.lines[1]!.text);
    expect(start.line).toBe(top);
  });

  it('starts only on text, but carries on to the nearest line from anywhere', () => {
    const lines = selectableLines(page);
    expect(positionAt(lines, [2, 2])).toBeNull();
    const last = lines.at(-1)!.line;
    // Far right of the last line, and below the text: its end.
    const below: Point = [last.box.x + last.box.width + 40, last.box.y - 4];
    expect(nearestPosition(lines, below)).toEqual({ line: lines.length - 1, at: last.chars.length });
  });

  it('leaves out paragraphs being edited and moves pushed ones', () => {
    const [paragraph] = page.paragraphs;
    const line = paragraph!.lines[0]!;
    const point = edge(line, 0, 'left');
    expect(positionAt(selectableLines(page, { skip: (id) => id === paragraph!.id }), point)?.line).not.toBe(0);
    const pushed = selectableLines(page, { shift: (id) => (id === paragraph!.id ? 30 : 0) });
    expect(positionAt(pushed, [point[0], point[1] - 30])).toEqual({ line: 0, at: 0 });
    const { rects } = selection(pushed, { line: 0, at: 0 }, { line: 0, at: 1 });
    expect(rects[0]!.y).toBeCloseTo(line.chars[0]!.box.y - 30, 3);
  });
});
