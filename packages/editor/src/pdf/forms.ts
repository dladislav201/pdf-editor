import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  type PDFFont,
  type PDFWidgetAnnotation,
} from 'pdf-lib';
import type { Rect } from '../types';

export type FormValue = string | boolean | string[];

/** One fillable field of the PDF's form and where its widgets are drawn. */
export interface FormField {
  /** The field's full name, unique in the form. */
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';
  /** Text, on/off, the selected option (radio, dropdown) or options (list). */
  value: FormValue;
  /** Choices of a radio group, dropdown or list. */
  options?: string[];
  multiline?: boolean;
  maxLength?: number;
  readOnly?: boolean;
  /** Font size from the field's default appearance; 0 means "fit". */
  fontSize?: number;
  widgets: { pageIndex: number; rect: Rect; /** For radio buttons: the option this button stands for. */ option?: string }[];
}

function widgetRect(widget: PDFWidgetAnnotation): Rect {
  const { x, y, width, height } = widget.getRectangle();
  return { x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) };
}

/** The page a widget sits on: its /P entry, else the page whose /Annots holds it. */
function widgetPage(doc: PDFDocument, widget: PDFWidgetAnnotation): number {
  const pages = doc.getPages();
  const ref = widget.P();
  if (ref) {
    const index = pages.findIndex((page) => page.ref === ref);
    if (index >= 0) return index;
  }
  return pages.findIndex((page) => {
    const annots = page.node.Annots();
    for (let i = 0; annots && i < annots.size(); i++) if (annots.lookupMaybe(i, PDFDict) === widget.dict) return true;
    return false;
  });
}

const fontSizeOf = (da: string | undefined) => {
  const match = da && /([\d.]+)\s+Tf/.exec(da);
  return match ? Number(match[1]) : undefined;
};

/** The form fields of a PDF file (none when it can't be read). */
export async function loadFormFields(bytes: Uint8Array): Promise<FormField[]> {
  try {
    return readFormFields(await PDFDocument.load(bytes, { updateMetadata: false }));
  } catch {
    return [];
  }
}

/** Reads the fields a user can fill (text, check boxes, radio groups, dropdowns, lists). Buttons and signatures are left out. */
export function readFormFields(doc: PDFDocument): FormField[] {
  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch {
    return [];
  }
  const out: FormField[] = [];
  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    const placed = widgets
      .map((widget) => ({ widget, pageIndex: widgetPage(doc, widget), rect: widgetRect(widget) }))
      .filter((w) => w.pageIndex >= 0 && w.rect.width > 0 && w.rect.height > 0);
    if (!placed.length) continue;
    const base = {
      name: field.getName(),
      readOnly: field.isReadOnly(),
      widgets: placed.map(({ pageIndex, rect }) => ({ pageIndex, rect })),
    };
    if (field instanceof PDFTextField) {
      out.push({
        ...base,
        type: 'text',
        value: field.getText() ?? '',
        multiline: field.isMultiline(),
        ...(field.getMaxLength() !== undefined ? { maxLength: field.getMaxLength() } : {}),
        fontSize: fontSizeOf(field.acroField.getDefaultAppearance()) ?? 0,
      });
    } else if (field instanceof PDFCheckBox) {
      out.push({ ...base, type: 'checkbox', value: field.isChecked() });
    } else if (field instanceof PDFRadioGroup) {
      const options = field.getOptions();
      out.push({
        ...base,
        type: 'radio',
        value: field.getSelected() ?? '',
        options,
        // Buttons follow the options in order; without /Opt each one's own "on" name.
        widgets: placed.map(({ widget, pageIndex, rect }) => ({
          pageIndex,
          rect,
          option: options[widgets.indexOf(widget)] ?? widget.getOnValue()?.decodeText() ?? '',
        })),
      });
    } else if (field instanceof PDFDropdown) {
      out.push({ ...base, type: 'dropdown', value: field.getSelected()[0] ?? '', options: field.getOptions() });
    } else if (field instanceof PDFOptionList) {
      out.push({ ...base, type: 'list', value: field.getSelected(), options: field.getOptions() });
    }
  }
  return out;
}

/**
 * Writes filled-in values into the form and redraws the fields' appearances
 * (with `font`, needed for text outside Latin-1). `flatten` burns the fields
 * into the pages so they can't be changed any more.
 */
export function fillForm(doc: PDFDocument, values: Record<string, FormValue>, font: PDFFont | null, flatten = false): void {
  const names = Object.keys(values);
  // No form in the file: nothing to fill, and no empty form to add.
  if ((!names.length && !flatten) || !doc.catalog.get(PDFName.of('AcroForm'))) return;
  const form = doc.getForm();
  for (const name of names) {
    const value = values[name]!;
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    if (field instanceof PDFTextField && typeof value === 'string') field.setText(value || undefined);
    else if (field instanceof PDFCheckBox) {
      if (value) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup && typeof value === 'string') {
      if (value) field.select(value);
      else field.clear();
    } else if (field instanceof PDFDropdown && typeof value === 'string') {
      if (value) field.select(value);
      else field.clear();
    } else if (field instanceof PDFOptionList && Array.isArray(value)) {
      if (value.length) field.select(value);
      else field.clear();
    }
  }
  if (font) form.updateFieldAppearances(font);
  if (flatten) form.flatten({ updateFieldAppearances: !font });
}
