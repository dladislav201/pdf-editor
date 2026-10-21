import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../types';
import { PageGeometry, type Rotation } from './page-geometry';
import { analyzePage } from '../text/analyze';
import { PdfiumDocument, initLibrary } from './pdfium-core';

const require = createRequire(import.meta.url);
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url));
let lib: Awaited<ReturnType<typeof init>>;

beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
});

/**
 * A 400×300 page whose visible box is offset by a crop box, with a red
 * square at user-space (150..170, 120..140) and a blue one at (290..310, 230..250).
 */
async function markedPdf(rotation: Rotation): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.setCropBox(50, 20, 270, 240); // x, y, width, height → box [50, 20, 320, 260]
  page.setRotation(degrees(rotation));
  page.drawRectangle({ x: 150, y: 120, width: 20, height: 20, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 290, y: 230, width: 20, height: 20, color: rgb(0, 0, 1) });
  return doc.save();
}

function pixel(rgba: Uint8ClampedArray, width: number, [x, y]: Point): number[] {
  const i = (Math.floor(y) * width + Math.floor(x)) * 4;
  return Array.from(rgba.subarray(i, i + 3));
}

describe('PDFium engine', () => {
  for (const rotation of [0, 90, 180, 270] as Rotation[]) {
    it(`maps user space to rendered pixels at /Rotate ${rotation}`, async () => {
      const doc = new PdfiumDocument(lib, await markedPdf(rotation));
      try {
        const info = doc.pageInfo(0);
        expect(info.rotation).toBe(rotation);
        expect(info.box).toEqual([50, 20, 320, 260]);

        const geometry = new PageGeometry(info.box, info.rotation, 2);
        const rotated = rotation % 180 !== 0;
        expect([geometry.width, geometry.height]).toEqual(rotated ? [480, 540] : [540, 480]);

        const rgba = doc.render(0, geometry.width, geometry.height);
        // Centres of the squares must land on their colors in the bitmap.
        expect(pixel(rgba, geometry.width, geometry.toViewport([160, 130]))).toEqual([255, 0, 0]);
        expect(pixel(rgba, geometry.width, geometry.toViewport([300, 240]))).toEqual([0, 0, 255]);
        // And a point outside both squares is the white page.
        expect(pixel(rgba, geometry.width, geometry.toViewport([100, 60]))).toEqual([255, 255, 255]);
      } finally {
        doc.close();
      }
    });
  }

  it('converts back and forth between user space and pixels', () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const geometry = new PageGeometry([50, 20, 320, 260], rotation, 1.75);
      const [x, y] = geometry.toPdf(geometry.toViewport([123.4, 210.9]));
      expect(x).toBeCloseTo(123.4, 6);
      expect(y).toBeCloseTo(210.9, 6);
    }
  });

  it('reports a clear error for files that are not PDFs', () => {
    expect(() => new PdfiumDocument(lib, new TextEncoder().encode('not a pdf'))).toThrow(
      expect.objectContaining({ name: 'InvalidPDFException' }),
    );
  });

  it('opens several documents and renders every page after the page cache evicts', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 12; i++) doc.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(0, i / 12, 0) });
    const bytes = await doc.save();
    const a = new PdfiumDocument(lib, bytes);
    const b = new PdfiumDocument(lib, await markedPdf(0));
    try {
      expect(a.pageCount).toBe(12);
      for (const index of [0, 11, 3, 0]) {
        const rgba = a.render(index, 10, 10);
        expect(pixel(rgba, 10, [5, 5])).toEqual([0, Math.round((index / 12) * 255), 0]);
      }
      expect(b.pageCount).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it('tells which characters a subset font really has', () => {
    const doc = new PdfiumDocument(lib, fixture('chrome-contract.pdf'));
    try {
      const page = analyzePage(doc.extractText(0));
      const body = page.paragraphs.find((p) => p.text.startsWith('Customer shall pay'))!;
      const glyph = body.lines[0]!.chars[0]!;
      const { glyphs, ascent, descent } = doc.glyphs(0, glyph.object, ['C', 'u', '4', ' ', 'Q', 'Ж', 'z']);
      // Characters the paragraph uses are in the subset; others fall back to the ".notdef" box.
      expect(glyphs.C).toMatchObject({ advance: expect.closeTo(0.722, 2), path: expect.stringMatching(/^M/) });
      expect(glyphs['4']).not.toBeNull();
      expect(glyphs[' ']).toMatchObject({ path: '' });
      expect([glyphs.Q, glyphs['Ж'], glyphs.z]).toEqual([null, null, null]);
      expect(ascent).toBeCloseTo(0.905, 2);
      expect(descent).toBeCloseTo(-0.212, 2);
    } finally {
      doc.close();
    }
  });

  it('reports glyphs missing from a simple subset font by their zero width', () => {
    const doc = new PdfiumDocument(lib, fixture('quartz-invoice.pdf'));
    try {
      const glyph = analyzePage(doc.extractText(0)).paragraphs[0]!.lines[0]!.chars[0]!;
      const { glyphs } = doc.glyphs(0, glyph.object, ['4', '5', 'I']);
      expect(glyphs['4']).not.toBeNull();
      expect(glyphs['5']).toBeNull(); // the invoice never uses a "5"
      expect(glyphs.I!.advance).toBeCloseTo(0.6, 2); // Monaco is monospaced
    } finally {
      doc.close();
    }
  });

  it('renders a page without the objects of a paragraph being edited', () => {
    const doc = new PdfiumDocument(lib, fixture('chrome-contract.pdf'));
    try {
      const geometry = new PageGeometry(doc.pageInfo(0).box, 0, 1);
      const title = analyzePage(doc.extractText(0)).paragraphs[0]!;
      const objects = [...new Set(title.lines.flatMap((l) => l.chars.map((c) => c.object)))];
      const width = Math.round(geometry.width);
      const height = Math.round(geometry.height);
      const dark = (rgba: Uint8ClampedArray) => {
        let count = 0;
        const [x0, y0] = geometry.toViewport([title.box.x, title.box.y + title.box.height]);
        const [x1, y1] = geometry.toViewport([title.box.x + title.box.width, title.box.y]);
        for (let y = Math.floor(y0); y < y1; y++) {
          for (let x = Math.floor(x0); x < x1; x++) if (rgba[(y * width + x) * 4]! < 128) count++;
        }
        return count;
      };
      expect(dark(doc.render(0, width, height))).toBeGreaterThan(500);
      expect(dark(doc.render(0, width, height, objects))).toBe(0);
      // Hiding is temporary: the next render draws the title again.
      expect(dark(doc.render(0, width, height))).toBeGreaterThan(500);
    } finally {
      doc.close();
    }
  });
});
