import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../export';
import type { Annotation } from '../types';
import { importAnnotations } from './read-annotations';

const require = createRequire(import.meta.url);
const fontBytes = readFileSync(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')).buffer as ArrayBuffer;

async function blankPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return doc.save();
}

/** Adds a raw annotation dictionary to page 1, the way another PDF tool would. */
async function withRawAnnotations(build: (doc: PDFDocument) => PDFDict[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await blankPdf(1));
  const page = doc.getPage(0);
  for (const dict of build(doc)) page.node.addAnnot(doc.context.register(dict));
  return doc.save();
}

async function annotationSubtypes(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return [];
  return Array.from({ length: annots.size() }, (_, i) =>
    annots.lookup(i, PDFDict).lookup(PDFName.of('Subtype'), PDFName).decodeText(),
  );
}

const base = { createdAt: '2026-10-21T09:00:00.000Z', author: 'Олена', comment: 'Check this' };

const sample: Annotation[] = [
  {
    ...base,
    id: 'h1',
    pageIndex: 0,
    color: '#facc15',
    type: 'highlight',
    rect: { x: 60, y: 700, width: 300, height: 30 },
    segments: [
      { x: 60, y: 715, width: 300, height: 15 },
      { x: 60, y: 700, width: 120, height: 15 },
    ],
    opacity: 0.4,
  },
  {
    ...base,
    id: 'u1',
    pageIndex: 0,
    color: '#2f6fed',
    type: 'underline',
    rect: { x: 60, y: 640, width: 300, height: 30 },
    segments: [
      { x: 60, y: 655, width: 300, height: 15 },
      { x: 60, y: 640, width: 80, height: 15 },
    ],
  },
  { ...base, id: 'x1', pageIndex: 0, color: '#ef4444', type: 'strikeout', rect: { x: 60, y: 600, width: 140, height: 15 } },
  // Text up the side of the page: its quad turned a quarter, its box the bounding box.
  {
    ...base,
    id: 'h2',
    pageIndex: 0,
    color: '#22c55e',
    type: 'highlight',
    rect: { x: 488, y: 100, width: 14, height: 80 },
    segments: [{ x: 488, y: 100, width: 14, height: 80 }],
    quads: [
      [
        [488, 100],
        [488, 180],
        [502, 100],
        [502, 180],
      ],
    ],
    opacity: 0.4,
  },
  { ...base, id: 'r1', pageIndex: 0, color: '#ef4444', type: 'rectangle', rect: { x: 50, y: 400, width: 200, height: 100 }, strokeWidth: 2 },
  {
    ...base,
    id: 'i1',
    pageIndex: 1,
    color: '#2f6fed',
    type: 'ink',
    paths: [
      [[100, 100], [150, 120], [200, 110]],
      [[300, 300]],
    ],
    strokeWidth: 3,
  },
  {
    id: 't1',
    pageIndex: 1,
    color: '#111827',
    createdAt: base.createdAt,
    author: 'Олена',
    type: 'text',
    position: [72, 760],
    text: 'Перевірити дати\nдругий рядок',
    fontSize: 14,
  },
  {
    ...base,
    id: 's1',
    pageIndex: 1,
    color: '#000000',
    type: 'image',
    kind: 'signature',
    // A 1×1 PNG: what goes in comes back byte for byte.
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    rect: { x: 380, y: 90, width: 150, height: 50 },
  },
];

describe('PDF annotations', () => {
  it('round-trips every annotation type through a saved file', async () => {
    const saved = await exportPdf(await blankPdf(), sample, { fontBytes });
    const { annotations, bytes } = await importAnnotations(saved);

    expect(annotations).toEqual(sample);
    // The editable annotations are moved out of the file the viewer renders.
    expect(await annotationSubtypes(bytes, 0)).toEqual([]);
    expect(await annotationSubtypes(bytes, 1)).toEqual([]);
  });

  it('writes standard annotation objects with appearance streams', async () => {
    const saved = await exportPdf(await blankPdf(), sample, { fontBytes });
    expect(await annotationSubtypes(saved, 0)).toEqual(['Highlight', 'Underline', 'StrikeOut', 'Highlight', 'Square']);
    expect(await annotationSubtypes(saved, 1)).toEqual(['Ink', 'FreeText', 'Stamp']);

    const doc = await PDFDocument.load(saved);
    const annots = doc.getPage(0).node.Annots()!;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i, PDFDict);
      expect(dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))).toBeDefined();
      expect(dict.lookup(PDFName.of('F'))?.toString()).toBe('4');
    }
  });

  it('keeps the saved file free of annotations when flattening', async () => {
    const saved = await exportPdf(await blankPdf(), sample, { fontBytes, flatten: true });
    expect(await annotationSubtypes(saved, 0)).toEqual([]);
    // The signature is drawn into the page itself.
    const page = (await PDFDocument.load(saved)).getPage(1);
    expect(page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict).keys().length).toBe(1);
    expect((await importAnnotations(saved)).annotations).toEqual([]);
  });

  it('returns the original bytes when there is nothing to import', async () => {
    const original = await blankPdf();
    const result = await importAnnotations(original);
    expect(result.bytes).toBe(original);
    expect(result.annotations).toEqual([]);
  });

  it('returns the original bytes for files it cannot parse', async () => {
    const garbage = new TextEncoder().encode('not a pdf at all');
    const result = await importAnnotations(garbage);
    expect(result.bytes).toBe(garbage);
  });

  it('imports annotations written by other tools', async () => {
    const bytes = await withRawAnnotations((doc) => [
      // Two-line text highlight in CMYK, no /NM, quads in Acrobat order.
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [70, 600, 400, 640],
        C: [0, 0, 1, 0],
        QuadPoints: [70, 640, 400, 640, 70, 622, 400, 622, 70, 620, 250, 620, 70, 600, 250, 600],
        CA: 0.5,
        T: PDFString.of('Reviewer'),
        Contents: PDFHexString.fromText('Looks wrong'),
      }),
      // Square with a /RD inset and a legacy /Border width.
      doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 210, 160], Border: [0, 0, 4], RD: [5, 5, 5, 5], C: [0] }),
      // FreeText whose color and size only exist in /DA.
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: [300, 300, 420, 320],
        Contents: PDFString.of('Approved'),
        DA: PDFString.of('/Helv 11 Tf 0.5 g'),
      }),
    ]);

    const { annotations } = await importAnnotations(bytes);
    const [highlight, square, text] = annotations;

    expect(highlight).toMatchObject({
      type: 'highlight',
      color: '#ffff00',
      author: 'Reviewer',
      comment: 'Looks wrong',
      opacity: 0.5,
      rect: { x: 70, y: 600, width: 330, height: 40 },
      segments: [
        { x: 70, y: 622, width: 330, height: 18 },
        { x: 70, y: 600, width: 180, height: 20 },
      ],
    });
    expect(highlight!.id).toMatch(/^pdf-\d+-0$/);
    expect(square).toMatchObject({ type: 'rectangle', color: '#000000', strokeWidth: 4, rect: { x: 105, y: 105, width: 100, height: 50 } });
    expect(text).toMatchObject({ type: 'text', text: 'Approved', fontSize: 11, color: '#808080', position: [300, 320] });
  });

  it('leaves unsupported and hidden annotations in place and drops popups of imported ones', async () => {
    const bytes = await withRawAnnotations((doc) => {
      const popupRef = doc.context.nextRef();
      const highlight = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [10, 10, 50, 20],
        QuadPoints: [10, 20, 50, 20, 10, 10, 50, 10],
        Popup: popupRef,
      });
      const highlightRef = doc.context.register(highlight);
      doc.context.assign(popupRef, doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [60, 60, 200, 120], Parent: highlightRef }));
      const page = doc.getPage(0);
      page.node.addAnnot(highlightRef);
      page.node.addAnnot(popupRef);
      return [
        doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] }),
        doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10], F: 2 }),
      ];
    });

    const { annotations, bytes: stripped } = await importAnnotations(bytes);
    expect(annotations.map((a) => a.type)).toEqual(['highlight']);
    expect(await annotationSubtypes(stripped)).toEqual(['Link', 'Square']);
  });

  it('keeps unsupported annotations when saving again', async () => {
    const bytes = await withRawAnnotations((doc) => [
      doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] }),
      doc.context.obj({ Type: 'Annot', Subtype: 'Ink', Rect: [0, 0, 50, 50], InkList: [[1, 1, 40, 40]] }),
    ]);
    const { bytes: stripped, annotations } = await importAnnotations(bytes);
    const saved = await exportPdf(stripped, annotations);
    // The ink is written back once, not duplicated next to the original.
    expect(await annotationSubtypes(saved)).toEqual(['Link', 'Ink']);
  });
});
