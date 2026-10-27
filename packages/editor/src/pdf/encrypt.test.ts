import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { PdfiumDocument, initLibrary } from '../engine/pdfium-core';
import { exportPdf } from '../export';
import { encryptPdf } from './encrypt';

const require = createRequire(import.meta.url);
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));
let lib: ReturnType<typeof initLibrary>;

beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
});

const textOf = (bytes: Uint8Array, password?: string) => {
  const doc = new PdfiumDocument(lib, bytes, password);
  try {
    return doc
      .extractText(0)
      .chars.map((c) => c.text)
      .join('');
  } finally {
    doc.close();
  }
};
/** The title and the first annotation's comment as a reader that ignores encryption sees them. */
async function readable(bytes: Uint8Array): Promise<{ title?: string; comment?: string }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const annotation = doc.getPage(0).node.Annots()?.lookup(0, PDFDict);
  return { title: doc.getTitle(), comment: annotation?.lookup(PDFName.of('Contents'), PDFHexString).decodeText() };
}

async function letter(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Salary review');
  const page = pdf.addPage([400, 300]);
  page.drawText('Confidential: the salary rises to 5000.', { x: 40, y: 250, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return exportPdf(await pdf.save(), [
    {
      id: 'note',
      pageIndex: 0,
      color: '#facc15',
      createdAt: '2026-10-27T10:00:00.000Z',
      type: 'highlight',
      rect: { x: 40, y: 245, width: 120, height: 16 },
      opacity: 0.4,
      comment: 'Approved by HR',
    },
  ]);
}

describe('saving a PDF with a password', () => {
  it('opens only with the password, and then reads as before', async () => {
    const plain = await letter();
    const locked = await encryptPdf(plain, { password: 'secret' });
    expect(() => new PdfiumDocument(lib, locked)).toThrow(expect.objectContaining({ name: 'PasswordException' }));
    expect(() => new PdfiumDocument(lib, locked, 'wrong')).toThrow(expect.objectContaining({ name: 'PasswordException' }));
    expect(textOf(locked, 'secret')).toBe(textOf(plain));
  });

  it('leaves nothing readable in the file: text, title and comments are encrypted', async () => {
    const plain = await letter();
    expect(await readable(plain)).toEqual({ title: 'Salary review', comment: 'Approved by HR' });
    const locked = await encryptPdf(plain, { password: 'secret' });
    const seen = await readable(locked);
    expect(seen.title).not.toContain('Salary');
    expect(seen.comment).not.toContain('Approved');
    expect(Buffer.from(locked).includes('/AESV3')).toBe(true);
  });

  it('takes a password in any script', async () => {
    const locked = await encryptPdf(await letter(), { password: 'Пароль ünd 密码' });
    expect(textOf(locked, 'Пароль ünd 密码')).toContain('salary rises');
    // Spelled as Preview and Safari do ("u" and a combining mark): it opens too.
    expect(textOf(locked, 'Пароль ünd 密码'.normalize('NFD'))).toContain('salary rises');
    expect(() => new PdfiumDocument(lib, locked, 'Пароль')).toThrow();
  });

  it('protects a real document page for page, pixel for pixel', async () => {
    const plain = fixture('chrome-contract.pdf');
    const locked = await encryptPdf(plain, { password: 'secret' });
    const render = (bytes: Uint8Array, password?: string) => {
      const doc = new PdfiumDocument(lib, bytes, password);
      try {
        return { pages: doc.pageCount, pixels: doc.render(0, 300, 400, [], false) };
      } finally {
        doc.close();
      }
    };
    const before = render(plain);
    const after = render(locked, 'secret');
    expect(after.pages).toBe(before.pages);
    expect(Buffer.from(after.pixels).equals(Buffer.from(before.pixels))).toBe(true);
  });

  it('refuses an empty password and a file that is protected already', async () => {
    await expect(encryptPdf(await letter(), { password: '' })).rejects.toThrow();
    const locked = await encryptPdf(await letter(), { password: 'secret' });
    await expect(encryptPdf(locked, { password: 'other' })).rejects.toThrow();
  });
});
