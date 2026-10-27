import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { round } from '../geometry';
import type { Annotation, Point, Quad, Rect } from '../types';
import { componentsToHex, name, numbersOf, readBorderWidth, readDate, readNumber, readRect, readText } from './objects';
import { IMAGE_SOURCE_KEY } from './write-annotations';

/** `/F 2`: hidden. Such annotations are left in the file untouched. */
const HIDDEN_FLAG = 2;

const DEFAULT_COLORS: Record<string, string> = {
  Highlight: '#facc15',
  Underline: '#2f6fed',
  StrikeOut: '#ef4444',
  Square: '#ef4444',
  Ink: '#2f6fed',
  FreeText: '#000000',
  Stamp: '#000000',
};

/** A picture we saved as a stamp, as a data URL; other stamps stay in the file as they are. */
function stampImage(dict: PDFDict): string | null {
  const source = dict.lookupMaybe(name(IMAGE_SOURCE_KEY), PDFStream);
  if (!(source instanceof PDFRawStream)) return null;
  const type = source.dict.lookupMaybe(name('Subtype'), PDFName)?.decodeText() === 'image/png' ? 'png' : 'jpeg';
  const bytes = decodePDFRawStream(source).decode();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/${type};base64,${btoa(binary)}`;
}

export interface ImportResult {
  /** The PDF without the imported annotations, or the original bytes when nothing was imported. */
  bytes: Uint8Array;
  annotations: Annotation[];
}

const roundRect = ({ x, y, width, height }: Rect): Rect => ({
  x: round(x),
  y: round(y),
  width: round(width),
  height: round(height),
});

function boundingRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const top = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: top - y };
}

/**
 * The lines of a text markup annotation: the box of each quad, and the quads
 * themselves when the text runs at an angle (a box would lose its direction).
 */
function markedLines(dict: PDFDict, rect: Rect): { rect: Rect; segments?: Rect[]; quads?: Quad[] } {
  const values = numbersOf(dict.lookupMaybe(name('QuadPoints'), PDFArray));
  const boxes: Rect[] = [];
  const quads: Quad[] = [];
  for (let i = 0; i + 8 <= values.length; i += 8) {
    const xs = [values[i]!, values[i + 2]!, values[i + 4]!, values[i + 6]!];
    const ys = [values[i + 1]!, values[i + 3]!, values[i + 5]!, values[i + 7]!];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    boxes.push(roundRect({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }));
    quads.push([0, 1, 2, 3].map((k) => [round(xs[k]!), round(ys[k]!)]) as Quad);
  }
  if (!boxes.length) return { rect: roundRect(rect) };
  // Upright when each quad's top edge is level and its sides are plumb.
  const upright = quads.every(([a, b, c]) => Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - c[0]) < 0.5);
  return {
    rect: roundRect(boundingRect(boxes)),
    ...(boxes.length > 1 || !upright ? { segments: boxes } : {}),
    ...(upright ? {} : { quads }),
  };
}

function parseDefaultAppearance(da: string | undefined): { fontSize?: number; color?: string } {
  if (!da) return {};
  const size = /([\d.]+)\s+Tf/.exec(da);
  const rgbMatch = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const grayMatch = /([\d.]+)\s+g(?:\s|$)/.exec(da);
  const components = rgbMatch ? rgbMatch.slice(1, 4).map(Number) : grayMatch ? [Number(grayMatch[1])] : undefined;
  const fontSize = size ? Number(size[1]) : undefined;
  return {
    // `0 Tf` means "auto size" and is not something we can reproduce.
    fontSize: fontSize && fontSize > 0 ? fontSize : undefined,
    color: components ? componentsToHex(components) : undefined,
  };
}

/** Fill opacity set inside the normal appearance stream, which is where we (and pdf.js) write it. */
function appearanceOpacity(dict: PDFDict): number | undefined {
  const stream = dict.lookupMaybe(name('AP'), PDFDict)?.lookupMaybe(name('N'), PDFStream);
  const states = stream?.dict.lookupMaybe(name('Resources'), PDFDict)?.lookupMaybe(name('ExtGState'), PDFDict);
  if (!states) return undefined;
  for (const [key] of states.entries()) {
    const opacity = states.lookupMaybe(key, PDFDict)?.lookupMaybe(name('ca'), PDFNumber)?.asNumber();
    if (opacity !== undefined) return opacity;
  }
  return undefined;
}

function parseAnnotation(dict: PDFDict, pageIndex: number, fallbackId: string): Annotation | null {
  const subtype = dict.lookupMaybe(name('Subtype'), PDFName)?.decodeText();
  if (!subtype || !(subtype in DEFAULT_COLORS)) return null;
  if ((readNumber(dict, 'F') ?? 0) & HIDDEN_FLAG) return null;
  const rect = readRect(dict);
  if (!rect) return null;

  const created = readDate(dict, 'CreationDate') ?? readDate(dict, 'M');
  const author = readText(dict, 'T');
  const contents = readText(dict, 'Contents');
  const base = {
    id: readText(dict, 'NM') || fallbackId,
    pageIndex,
    color: componentsToHex(numbersOf(dict.lookupMaybe(name('C'), PDFArray))) ?? DEFAULT_COLORS[subtype]!,
    createdAt: (created ?? new Date()).toISOString(),
    ...(author ? { author } : {}),
  };
  const comment = contents ? { comment: contents } : {};

  switch (subtype) {
    case 'Highlight': {
      return {
        ...base,
        ...comment,
        type: 'highlight',
        ...markedLines(dict, rect),
        opacity: readNumber(dict, 'CA') ?? appearanceOpacity(dict) ?? 1,
      };
    }
    case 'Underline':
    case 'StrikeOut': {
      return {
        ...base,
        ...comment,
        type: subtype === 'Underline' ? 'underline' : 'strikeout',
        ...markedLines(dict, rect),
      };
    }
    case 'Square': {
      const strokeWidth = readBorderWidth(dict);
      // /RD gives the inset of the drawn square inside /Rect; without it the stroke is centred on the inset.
      const rd = numbersOf(dict.lookupMaybe(name('RD'), PDFArray));
      const [left, bottom, right, top] = rd.length === 4 ? (rd as [number, number, number, number]) : Array(4).fill(strokeWidth / 2);
      const inner = {
        x: rect.x + left,
        y: rect.y + bottom,
        width: rect.width - left - right,
        height: rect.height - bottom - top,
      };
      return { ...base, ...comment, type: 'rectangle', rect: roundRect(inner), strokeWidth };
    }
    case 'Ink': {
      const inkList = dict.lookupMaybe(name('InkList'), PDFArray);
      const paths: Point[][] = [];
      for (let i = 0; inkList && i < inkList.size(); i++) {
        const values = numbersOf(inkList.lookupMaybe(i, PDFArray));
        const path: Point[] = [];
        for (let j = 0; j + 1 < values.length; j += 2) path.push([round(values[j]!), round(values[j + 1]!)]);
        if (path.length) paths.push(path);
      }
      if (!paths.length) return null;
      return { ...base, ...comment, type: 'ink', paths, strokeWidth: readBorderWidth(dict) };
    }
    case 'Stamp': {
      const src = stampImage(dict);
      if (!src) return null;
      const kind = dict.lookupMaybe(name('Name'), PDFName)?.decodeText() === 'Signature' ? 'signature' : 'image';
      return { ...base, ...comment, type: 'image', kind, src, rect: roundRect(rect) };
    }
    case 'FreeText': {
      const { fontSize, color } = parseDefaultAppearance(readText(dict, 'DA'));
      return {
        ...base,
        color: color ?? DEFAULT_COLORS.FreeText!,
        type: 'text',
        position: [round(rect.x), round(rect.y + rect.height)],
        text: contents ?? '',
        fontSize: fontSize ?? 12,
      };
    }
  }
  return null;
}

/**
 * Moves the annotation types the editor can edit out of the PDF and into the
 * editor's model. Everything else (links, form fields, stamps, notes…) stays in
 * the file and is rendered by pdf.js as before. Popups that belonged to an
 * imported annotation are removed with it.
 *
 * Never throws: on any parsing problem the original bytes are returned untouched.
 */
export async function importAnnotations(bytes: Uint8Array): Promise<ImportResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return { bytes, annotations: [] };
  }

  const annotations: Annotation[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const remove = new Set<number>();
    const removedRefs = new Set<PDFRef>();
    const popupRefs = new Set<PDFRef>();

    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict) continue;
      const fallbackId = entry instanceof PDFRef ? `pdf-${entry.objectNumber}-${entry.generationNumber}` : `pdf-p${pageIndex}-${i}`;
      const annotation = parseAnnotation(dict, pageIndex, fallbackId);
      if (!annotation) continue;
      annotations.push(annotation);
      remove.add(i);
      if (entry instanceof PDFRef) removedRefs.add(entry);
      const popup = dict.get(name('Popup'));
      if (popup instanceof PDFRef) popupRefs.add(popup);
    }
    if (remove.size === 0) return;

    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const parent = annots.lookupMaybe(i, PDFDict)?.get(name('Parent'));
      if ((entry instanceof PDFRef && popupRefs.has(entry)) || (parent instanceof PDFRef && removedRefs.has(parent))) {
        remove.add(i);
      }
    }
    for (const index of [...remove].sort((a, b) => b - a)) annots.remove(index);
  });

  if (annotations.length === 0) return { bytes, annotations };
  return { bytes: await doc.save(), annotations };
}
