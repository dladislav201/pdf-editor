import fontkit from '@pdf-lib/fontkit';
import { BlendMode, LineCapStyle, PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import { markLine, markQuads, textBaselines, textLines } from './geometry';
import { hexToRgb } from './pdf/objects';
import { encryptPdf } from './pdf/encrypt';
import { fillForm, type FormValue } from './pdf/forms';
import { embedImages, writeAnnotations } from './pdf/write-annotations';
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
  /** Stamped faintly across every page (the trial watermark). */
  watermark?: string;
  /** Values filled into the PDF's form fields, by field name. */
  formValues?: Record<string, FormValue>;
  /** Protect the file with a password to open it (AES-256); once open, everything is allowed. */
  password?: string;
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

function flattenAnnotations(doc: PDFDocument, annotations: Annotation[], font: PDFFont | null, images: Map<string, PDFImage>): void {
  const pages = doc.getPages();
  for (const annotation of annotations) {
    const page = pages[annotation.pageIndex];
    if (!page) continue;
    const color = hexToRgb(annotation.color);

    switch (annotation.type) {
      case 'highlight':
        for (const [a, b, c, d] of markQuads(annotation)) {
          // drawSvgPath flips y (SVG is y-down), so feed it negated user-space y.
          page.drawSvgPath(`${pathData([a, b, d, c].map(([x, y]) => [x, -y]))} Z`, {
            x: 0,
            y: 0,
            color,
            opacity: annotation.opacity,
            blendMode: BlendMode.Multiply,
          });
        }
        break;
      case 'underline':
      case 'strikeout':
        for (const quad of markQuads(annotation)) {
          const { from, to, width } = markLine(annotation.type, quad);
          page.drawLine({ start: { x: from[0], y: from[1] }, end: { x: to[0], y: to[1] }, thickness: width, color });
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
      case 'image': {
        const image = images.get(annotation.src);
        if (image) page.drawImage(image, annotation.rect);
        break;
      }
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

/** A large, faint diagonal line of text across the middle of every page. */
async function stampWatermark(doc: PDFDocument, text: string): Promise<void> {
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const page of doc.getPages()) {
    const { x, y, width, height } = page.getCropBox();
    const size = Math.min(width, height) / 9;
    const textWidth = font.widthOfTextAtSize(text, size);
    const angle = (35 * Math.PI) / 180;
    page.drawText(text, {
      x: x + width / 2 - (Math.cos(angle) * textWidth) / 2,
      y: y + height / 2 - (Math.sin(angle) * textWidth) / 2,
      size,
      font,
      color: rgb(0.86, 0.15, 0.15),
      opacity: 0.16,
      rotate: degrees(35),
    });
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
  const values = options.formValues ?? {};
  if (Object.keys(values).length || options.flatten) {
    // Field appearances need a font that has the letters typed in: the given one, else Helvetica.
    const typed = Object.values(values).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []));
    let formFont = font;
    if (!formFont && options.fontBytes && typed.some((t) => !WIN_ANSI.test(t))) {
      doc.registerFontkit(fontkit);
      formFont = await doc.embedFont(options.fontBytes, { subset: true });
    }
    formFont ??= await doc.embedFont(StandardFonts.Helvetica);
    fillForm(doc, values, formFont, options.flatten);
  }
  const images = await embedImages(doc, annotations);
  if (options.flatten) flattenAnnotations(doc, annotations, font, images);
  else writeAnnotations(doc, annotations, font, images);
  if (options.watermark) await stampWatermark(doc, options.watermark);
  // Appearances are already drawn above, in the right font.
  const bytes = await doc.save({ updateFieldAppearances: false });
  return options.password ? encryptPdf(bytes, { password: options.password }) : bytes;
}
