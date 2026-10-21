import fontkit from '@pdf-lib/fontkit';
import { BlendMode, LineCapStyle, PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { textBaselines, textLines } from './geometry';
import { hexToRgb } from './pdf/objects';
import { writeAnnotations } from './pdf/write-annotations';
import { pathData } from './render-annotations';
import type { Annotation } from './types';

export interface ExportOptions {
  /** TTF/OTF bytes for text annotations. Without it only Latin-1 text can be written. */
  fontBytes?: ArrayBuffer;
  /**
   * Burn annotations into the page content instead of saving them as PDF
   * annotations. The result can't be edited further; use it for print or archive.
   */
  flatten?: boolean;
}

/** Characters Helvetica can encode (WinAnsi), so we can fail with a clear message instead of a cryptic one. */
const WIN_ANSI = /^[\x20-\x7e\xa0-\xff\n]*$/;

async function textFont(doc: PDFDocument, annotations: Annotation[], options: ExportOptions): Promise<PDFFont | null> {
  const texts = annotations.filter((a) => a.type === 'text');
  if (texts.length === 0) return null;
  if (options.fontBytes) {
    doc.registerFontkit(fontkit);
    return doc.embedFont(options.fontBytes, { subset: true });
  }
  if (texts.some((a) => !WIN_ANSI.test(a.text))) {
    throw new Error(
      'Text annotations contain characters the built-in font cannot encode. Pass `fontUrl` to the editor to export non-Latin text.',
    );
  }
  return doc.embedFont(StandardFonts.Helvetica);
}

function flattenAnnotations(doc: PDFDocument, annotations: Annotation[], font: PDFFont | null): void {
  const pages = doc.getPages();
  for (const annotation of annotations) {
    const page = pages[annotation.pageIndex];
    if (!page) continue;
    const color = hexToRgb(annotation.color);

    switch (annotation.type) {
      case 'highlight':
        for (const rect of annotation.segments ?? [annotation.rect]) {
          page.drawRectangle({ ...rect, color, opacity: annotation.opacity, blendMode: BlendMode.Multiply });
        }
        break;
      case 'rectangle':
        page.drawRectangle({ ...annotation.rect, borderColor: color, borderWidth: annotation.strokeWidth });
        break;
      case 'ink':
        for (const path of annotation.paths) {
          const points = path.length === 1 ? [path[0]!, path[0]!] : path;
          // drawSvgPath flips y (SVG is y-down), so feed it negated user-space y.
          page.drawSvgPath(pathData(points.map(([x, y]) => [x, -y])), {
            x: 0,
            y: 0,
            borderColor: color,
            borderWidth: annotation.strokeWidth,
            borderLineCap: LineCapStyle.Round,
          });
        }
        break;
      case 'text': {
        if (!font) break;
        const baselines = textBaselines(annotation);
        textLines(annotation).forEach((line, i) => {
          if (line) page.drawText(line, { x: annotation.position[0], y: baselines[i]!, size: annotation.fontSize, font, color });
        });
        break;
      }
    }
  }
}

/**
 * Writes the annotations into a copy of `base`, as real PDF annotations by
 * default or burned into the pages with `flatten`. `base` is not modified.
 */
export async function exportPdf(
  base: Uint8Array,
  annotations: Annotation[],
  options: ExportOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const font = await textFont(doc, annotations, options);
  if (options.flatten) flattenAnnotations(doc, annotations, font);
  else writeAnnotations(doc, annotations, font);
  return doc.save();
}
