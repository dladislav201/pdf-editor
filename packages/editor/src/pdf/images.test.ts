import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { imagesToPdf } from './images';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');

function picture(width: number, height: number, type: 'png' | 'jpeg') {
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').fillRect(0, 0, width / 2, height / 2);
  return { bytes: new Uint8Array(type === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg')), type };
}

describe('pictures to PDF', () => {
  it('puts each picture on a page of its own size at 150 dpi', async () => {
    const pdf = await PDFDocument.load(await imagesToPdf([picture(1240, 1754, 'jpeg'), picture(300, 150, 'png')]));
    const sizes = pdf.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
    // 1240 × 1754 px at 150 dpi is A4 (595 × 842 pt).
    expect(sizes).toEqual([
      [595, 842],
      [144, 72],
    ]);
  });

  it('refuses an empty list', async () => {
    await expect(imagesToPdf([])).rejects.toThrow('No pictures');
  });
});
