import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { PdfiumDocument, initLibrary } from './pdfium-core';

const require = createRequire(import.meta.url);
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
// The contract fixture saved by macOS PDFKit with a password to open ("secret"), and with an owner password only.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));
let lib: Awaited<ReturnType<typeof init>>;

beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
});

const textOf = (doc: PdfiumDocument) =>
  doc
    .extractText(0)
    .chars.map((c) => c.text)
    .join('');

describe('protected PDFs', () => {
  it('asks for the password to open', () => {
    expect(() => new PdfiumDocument(lib, fixture('protected-user.pdf'))).toThrow(expect.objectContaining({ name: 'PasswordException' }));
    expect(() => new PdfiumDocument(lib, fixture('protected-user.pdf'), 'wrong')).toThrow(
      expect.objectContaining({ name: 'PasswordException' }),
    );
  });

  it('opens with it and saves a copy without protection', async () => {
    const doc = new PdfiumDocument(lib, fixture('protected-user.pdf'), 'secret');
    const plain = doc.save({ decrypt: true });
    doc.close();
    // pdf-lib (annotations, export) refuses encrypted files; the copy is plain.
    await expect(PDFDocument.load(fixture('protected-user.pdf'))).rejects.toThrow();
    expect((await PDFDocument.load(plain)).getPageCount()).toBeGreaterThan(0);
    const reopened = new PdfiumDocument(lib, plain);
    expect(textOf(reopened)).toContain('Software Services Agreement');
    reopened.close();
  });

  it('opens a file with only an owner password as it is, and frees it of its restrictions', async () => {
    const doc = new PdfiumDocument(lib, fixture('protected-owner.pdf'));
    expect(textOf(doc)).toContain('Software Services Agreement');
    const plain = doc.save({ decrypt: true });
    doc.close();
    expect((await PDFDocument.load(plain)).getPageCount()).toBeGreaterThan(0);
  });
});
