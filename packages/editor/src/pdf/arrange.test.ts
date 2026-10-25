import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../export';
import { arrangePages } from './arrange';

/** A PDF whose pages are told apart by their widths. */
async function pdf(widths: number[], title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  for (const width of widths) doc.addPage([width, 400]);
  return doc.save();
}

async function describePages(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => ({
    width: page.getWidth(),
    rotation: page.getRotation().angle,
    annotations: page.node.Annots()?.size() ?? 0,
  }));
}

describe('arranging pages', () => {
  it('reorders, turns and leaves out pages', async () => {
    const source = await pdf([301, 302, 303, 304]);
    const result = await arrangePages([source], [
      { source: 0, page: 3 },
      { source: 0, page: 0, rotate: 90 },
      { source: 0, page: 2, rotate: 270 },
    ]);
    expect(await describePages(result)).toEqual([
      { width: 304, rotation: 0, annotations: 0 },
      { width: 301, rotation: 90, annotations: 0 },
      { width: 303, rotation: 270, annotations: 0 },
    ]);
  });

  it('adds rotation to a page that is already turned', async () => {
    const doc = await PDFDocument.load(await pdf([301]));
    doc.getPage(0).setRotation(degrees(270));
    const result = await arrangePages([await doc.save()], [{ source: 0, page: 0, rotate: 180 }]);
    expect((await describePages(result))[0]!.rotation).toBe(90);
  });

  it('merges pages of several PDFs and keeps their annotations', async () => {
    const first = await exportPdf(await pdf([301, 302], 'Contract'), [
      { id: 'a', type: 'rectangle', pageIndex: 1, color: '#ef4444', createdAt: '2026-10-25T00:00:00Z', rect: { x: 10, y: 10, width: 50, height: 20 }, strokeWidth: 2 },
    ]);
    const second = await pdf([401, 402]);
    const result = await arrangePages([first, second], [
      { source: 0, page: 0 },
      { source: 1, page: 1 },
      { source: 0, page: 1 },
      { source: 1, page: 0 },
    ]);
    expect((await describePages(result)).map((p) => [p.width, p.annotations])).toEqual([
      [301, 0],
      [402, 0],
      [302, 1],
      [401, 0],
    ]);
    expect((await PDFDocument.load(result)).getTitle()).toBe('Contract');
  });

  it('extracts some pages into a file of their own, the same page twice included', async () => {
    const source = await pdf([301, 302, 303]);
    const result = await arrangePages([source], [{ source: 0, page: 1 }, { source: 0, page: 1 }]);
    expect((await describePages(result)).map((p) => p.width)).toEqual([302, 302]);
  });

  it('refuses a page that does not exist', async () => {
    await expect(arrangePages([await pdf([301])], [{ source: 0, page: 5 }])).rejects.toThrow('no page 6');
  });
});
