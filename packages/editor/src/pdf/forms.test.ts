import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { exportPdf } from '../export';
import { readFormFields } from './forms';

const require = createRequire(import.meta.url);
const fontBytes = readFileSync(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')).buffer as ArrayBuffer;

/** A two-page form with one field of each kind. */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const first = doc.addPage([595, 842]);
  const second = doc.addPage([595, 842]);
  const form = doc.getForm();
  form.createTextField('name').addToPage(first, { x: 50, y: 700, width: 200, height: 24 });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(first, { x: 50, y: 560, width: 300, height: 100 });
  form.createCheckBox('agree').addToPage(first, { x: 50, y: 500, width: 16, height: 16 });
  const plan = form.createRadioGroup('plan');
  plan.addOptionToPage('basic', first, { x: 50, y: 450, width: 16, height: 16 });
  plan.addOptionToPage('pro', first, { x: 120, y: 450, width: 16, height: 16 });
  const country = form.createDropdown('country');
  country.addOptions(['Poland', 'Ukraine', 'Germany']);
  country.addToPage(second, { x: 50, y: 700, width: 150, height: 24 });
  return doc.save();
}

describe('PDF forms', () => {
  it('reads every fillable field with its widgets and page', async () => {
    const fields = readFormFields(await PDFDocument.load(await formPdf()));
    expect(fields.map((f) => [f.name, f.type, f.widgets.map((w) => w.pageIndex)])).toEqual([
      ['name', 'text', [0]],
      ['notes', 'text', [0]],
      ['agree', 'checkbox', [0]],
      ['plan', 'radio', [0, 0]],
      ['country', 'dropdown', [1]],
    ]);
    expect(fields[1]).toMatchObject({ multiline: true, value: '' });
    expect(fields[3]!.widgets.map((w) => w.option)).toEqual(['basic', 'pro']);
    expect(fields[4]).toMatchObject({ options: ['Poland', 'Ukraine', 'Germany'] });
    // pdf-lib widens the widget by half its 1 pt border on each side.
    expect(fields[0]!.widgets[0]!.rect).toEqual({ x: 49.5, y: 699.5, width: 201, height: 25 });
  });

  it('saves filled-in values, any script included, and reads them back', async () => {
    const saved = await exportPdf(await formPdf(), [], {
      fontBytes,
      formValues: { name: 'Олена Коваль', notes: 'Line one\nLine two', agree: true, plan: 'pro', country: 'Ukraine' },
    });
    const fields = readFormFields(await PDFDocument.load(saved));
    expect(Object.fromEntries(fields.map((f) => [f.name, f.value]))).toEqual({
      name: 'Олена Коваль',
      notes: 'Line one\nLine two',
      agree: true,
      plan: 'pro',
      country: 'Ukraine',
    });
  });

  it('burns the fields into the pages when flattening', async () => {
    const saved = await exportPdf(await formPdf(), [], { formValues: { name: 'Jane' }, flatten: true });
    expect(readFormFields(await PDFDocument.load(saved))).toEqual([]);
  });

  it('leaves a PDF without a form as it is', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const saved = await exportPdf(await doc.save(), [], { flatten: true });
    expect((await PDFDocument.load(saved)).catalog.get((await import('pdf-lib')).PDFName.of('AcroForm'))).toBeUndefined();
  });
});
