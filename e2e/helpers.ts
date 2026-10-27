import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { expect, type Download, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfiumDocument, initLibrary } from '../packages/editor/src/engine/pdfium-core';
import { analyzePage } from '../packages/editor/src/text/analyze';

const require = createRequire(import.meta.url);
let lib: ReturnType<typeof initLibrary> | undefined;

/** The text of every page of a PDF (opened with `password` when it needs one), read with the same engine the site uses. */
export async function pdfText(bytes: Uint8Array, password?: string): Promise<string[]> {
  lib ??= initLibrary(
    await init({ wasmBinary: readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm')) }),
  );
  const doc = new PdfiumDocument(lib, bytes, password);
  try {
    return Array.from({ length: doc.pageCount }, (_, i) =>
      doc
        .extractText(i)
        .chars.map((c) => c.text)
        .join(''),
    );
  } finally {
    doc.close();
  }
}

/** Paragraphs of the first page: text, first baseline, and the font (PostScript name) and size of each word. */
export async function pdfParagraphs(
  bytes: Uint8Array,
): Promise<{ text: string; baseline: number; fonts: Record<string, string>; sizes: Record<string, number> }[]> {
  lib ??= initLibrary(
    await init({ wasmBinary: readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm')) }),
  );
  const doc = new PdfiumDocument(lib, bytes);
  try {
    const raw = doc.extractText(0);
    return analyzePage(raw).paragraphs.map((p) => {
      const fonts: Record<string, string> = {};
      const sizes: Record<string, number> = {};
      for (const line of p.lines) {
        line.wordStarts.forEach((start, i) => {
          const chars = line.chars.slice(start, line.wordStarts[i + 1] ?? line.chars.length);
          const word = chars.map((c) => c.text).join('');
          fonts[word] = raw.fonts[chars[0]!.font]!.name;
          sizes[word] = Math.round(chars[0]!.size * 10) / 10;
        });
      }
      return { text: p.text, baseline: p.lines[0]!.baseline, fonts, sizes };
    });
  } finally {
    doc.close();
  }
}

export async function downloadBytes(download: Download): Promise<Uint8Array> {
  return new Uint8Array(readFileSync((await download.path())!));
}

/** Share of dark pixels on a rendered page; 0 while it is still blank. */
export function ink(page: Page, index = 0): Promise<number> {
  return page.locator(`.pdfsdk-page[data-page-index="${index}"] canvas`).evaluate(async (canvas: HTMLCanvasElement) => {
    if (!canvas.width || !canvas.height) return 0;
    const bitmap = await createImageBitmap(canvas);
    const copy = document.createElement('canvas');
    copy.width = bitmap.width;
    copy.height = bitmap.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && data[i]! < 128) dark++;
    return dark / (data.length / 4);
  });
}

/** Waits until a page has been drawn. */
export async function expectPainted(page: Page, index = 0): Promise<void> {
  await expect.poll(() => ink(page, index), { message: `page ${index + 1} is drawn` }).toBeGreaterThan(0.002);
}

/**
 * Waits until the app has replaced the prerendered page: before that, a
 * click or a chosen file lands on markup React is about to swap out.
 */
export async function waitForApp(page: Page): Promise<void> {
  await page.locator('html[data-app="ready"]').waitFor({ state: 'attached' });
}

export async function gotoApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await waitForApp(page);
}

export async function openSample(page: Page, name: 'A contract' | 'A scanned invoice' | 'A form'): Promise<void> {
  await gotoApp(page);
  await page.getByRole('button', { name, exact: true }).click();
  await expectPainted(page);
}

export async function openFile(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await gotoApp(page);
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expectPainted(page);
}

/** A long report: `pages` pages of text, each with its number and a word found only there. */
export async function longPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const filler =
    'The committee reviewed the quarterly figures and agreed that the budget for maintenance, training and travel stays within the limits set last year.';
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Section ${n}`, { x: 56, y: 770, size: 18, font: bold });
    for (let line = 0; line < 40; line++) {
      page.drawText(filler.slice(0, 90 + (line % 5) * 5), { x: 56, y: 730 - line * 16, size: 11, font });
    }
    page.drawText(`Marker word: checkpoint${n}`, { x: 56, y: 60, size: 11, font });
  }
  return doc.save();
}
