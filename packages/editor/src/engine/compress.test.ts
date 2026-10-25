import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init } from '@embedpdf/pdfium';
import { PDFDocument, rgb } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { PdfiumDocument, initLibrary, type EncodeJpeg } from './pdfium-core';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
const wasm = readFileSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
let lib: Awaited<ReturnType<typeof init>>;
beforeAll(async () => {
  lib = initLibrary(await init({ wasmBinary: wasm }));
});

/** What the worker does with OffscreenCanvas, here with @napi-rs/canvas. */
const encode: EncodeJpeg = async (rgba, width, height, targetWidth, targetHeight, quality) => {
  const source = createCanvas(width, height);
  const data = source.getContext('2d').createImageData(width, height);
  data.data.set(rgba);
  source.getContext('2d').putImageData(data, 0, 0);
  const target = createCanvas(targetWidth, targetHeight);
  target.getContext('2d').drawImage(source, 0, 0, targetWidth, targetHeight);
  return new Uint8Array(target.toBuffer('image/jpeg', Math.round(quality * 100)));
};

function compress(bytes: Uint8Array, options: { dpi: number; quality: number }) {
  const doc = new PdfiumDocument(lib, bytes);
  return doc
    .compressImages(options, encode)
    .then((result) => ({ ...result, bytes: doc.save() }))
    .finally(() => doc.close());
}

/** Mean difference (0–255) between two renders of page 1. */
function difference(a: Uint8Array, b: Uint8Array): number {
  const render = (bytes: Uint8Array) => {
    const doc = new PdfiumDocument(lib, bytes);
    try {
      return doc.render(0, 300, 424);
    } finally {
      doc.close();
    }
  };
  const x = render(a);
  const y = render(b);
  let sum = 0;
  for (let i = 0; i < x.length; i += 4) sum += Math.abs(x[i]! - y[i]!);
  return sum / (x.length / 4);
}

describe('compressing a PDF', () => {
  it('scales a scan down to the target resolution and keeps it looking the same', async () => {
    const original = new Uint8Array(readFileSync(new URL('../../test/fixtures/scan-invoice.pdf', import.meta.url)));
    const result = await compress(original, { dpi: 110, quality: 0.6 });
    expect(result).toMatchObject({ images: 1, recompressed: 1 });
    expect(result.bytes.length).toBeLessThan(original.length * 0.6);
    expect(difference(original, result.bytes)).toBeLessThan(6);
  });

  it('leaves pictures with transparency and small pictures alone', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    // A big picture with a transparent hole, and a small one.
    const big = createCanvas(900, 900);
    const ctx = big.getContext('2d');
    ctx.fillStyle = '#3366cc';
    ctx.fillRect(0, 0, 900, 900);
    ctx.clearRect(300, 300, 300, 300);
    page.drawImage(await doc.embedPng(big.toBuffer('image/png')), { x: 0, y: 0, width: 100, height: 100 });
    const small = createCanvas(100, 100);
    small.getContext('2d').fillRect(0, 0, 100, 100);
    page.drawImage(await doc.embedPng(small.toBuffer('image/png')), { x: 200, y: 200, width: 50, height: 50 });
    page.drawText('text stays', { x: 20, y: 300, size: 12, color: rgb(0, 0, 0) });
    const result = await compress(await doc.save(), { dpi: 72, quality: 0.5 });
    expect(result).toMatchObject({ images: 2, recompressed: 0 });
  });
});
