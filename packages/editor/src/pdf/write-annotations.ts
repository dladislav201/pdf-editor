import {
  LineCapStyle,
  LineJoinStyle,
  PDFHexString,
  PDFString,
  beginText,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endText,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  showText,
  stroke,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFOperator,
  type PDFPage,
} from 'pdf-lib';
import { TEXT_ASCENT, TEXT_LINE_HEIGHT, bounds, markLine, markQuads, textBaselines, textLines } from '../geometry';
import type { Annotation, Quad, Rect, TextAnnotation } from '../types';
import { hexToComponents, name, pdfDate, rectToArray } from './objects';

/** `/F 4`: print the annotation together with the page. */
const PRINT_FLAG = 4;

interface Built {
  subtype: string;
  rect: Rect;
  appearance: PDFOperator[];
  resources?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

function textBox(annotation: TextAnnotation, font: PDFFont): Rect {
  const lines = textLines(annotation);
  const width = Math.max(...lines.map((line) => font.widthOfTextAtSize(line, annotation.fontSize)), 1);
  const height = annotation.fontSize * (TEXT_ASCENT + (lines.length - 1) * TEXT_LINE_HEIGHT + 0.25);
  const [x, top] = annotation.position;
  return { x, y: top - height, width, height };
}

/** Quad points in the order Acrobat writes them: top-left, top-right, bottom-left, bottom-right (as the text runs). */
const quadPoints = (quads: Quad[]) => quads.flat(2);

/** Key of the stream with a picture's original file, so the editor can read it back as it was. */
export const IMAGE_SOURCE_KEY = 'PDFSDKSource';

function build(annotation: Annotation, font: PDFFont | null, images: Map<string, PDFImage>): Built | null {
  const [r, g, b] = hexToComponents(annotation.color);

  switch (annotation.type) {
    case 'highlight': {
      const quads = markQuads(annotation);
      return {
        subtype: 'Highlight',
        rect: annotation.rect,
        appearance: [
          pushGraphicsState(),
          setGraphicsState('GS0'),
          setFillingRgbColor(r, g, b),
          ...quads.flatMap(([a, b2, c, d]) => [moveTo(...a), lineTo(...b2), lineTo(...d), lineTo(...c), closePath()]),
          fill(),
          popGraphicsState(),
        ],
        // Multiply keeps the text under the highlight readable. Opacity lives in the
        // appearance itself: Preview and pdf.js ignore the annotation-level /CA.
        resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: annotation.opacity } } },
        extra: { QuadPoints: quadPoints(quads) },
      };
    }
    case 'underline':
    case 'strikeout': {
      const quads = markQuads(annotation);
      const ops: PDFOperator[] = [setStrokingRgbColor(r, g, b)];
      for (const quad of quads) {
        const { from, to, width } = markLine(annotation.type, quad);
        ops.push(setLineWidth(width), moveTo(...from), lineTo(...to), stroke());
      }
      return {
        subtype: annotation.type === 'underline' ? 'Underline' : 'StrikeOut',
        rect: annotation.rect,
        appearance: ops,
        extra: { QuadPoints: quadPoints(quads) },
      };
    }
    case 'rectangle': {
      const w = annotation.strokeWidth;
      const { x, y, width, height } = annotation.rect;
      return {
        subtype: 'Square',
        // /Rect must contain the whole stroke, which is centred on the outline.
        rect: { x: x - w / 2, y: y - w / 2, width: width + w, height: height + w },
        appearance: [
          setStrokingRgbColor(r, g, b),
          setLineWidth(w),
          rectangle(x, y, width, height),
          stroke(),
        ],
        extra: { BS: { Type: 'Border', W: w, S: 'S' } },
      };
    }
    case 'ink': {
      const ops: PDFOperator[] = [
        setStrokingRgbColor(r, g, b),
        setLineWidth(annotation.strokeWidth),
        setLineCap(LineCapStyle.Round),
        setLineJoin(LineJoinStyle.Round),
      ];
      for (const path of annotation.paths) {
        const [first, ...rest] = path;
        if (!first) continue;
        ops.push(moveTo(first[0], first[1]));
        // A single tap is a zero-length segment; the round cap draws it as a dot.
        for (const [x, y] of rest.length ? rest : [first]) ops.push(lineTo(x, y));
      }
      ops.push(stroke());
      return {
        subtype: 'Ink',
        rect: bounds(annotation, () => 0),
        appearance: ops,
        extra: {
          InkList: annotation.paths.map((path) => path.flat()),
          BS: { Type: 'Border', W: annotation.strokeWidth, S: 'S' },
        },
      };
    }
    case 'image': {
      const image = images.get(annotation.src);
      if (!image) return null;
      const { x, y, width, height } = annotation.rect;
      return {
        subtype: 'Stamp',
        rect: annotation.rect,
        appearance: [pushGraphicsState(), concatTransformationMatrix(width, 0, 0, height, x, y), drawObject('Im0'), popGraphicsState()],
        resources: { XObject: { Im0: image.ref } },
        extra: { Name: annotation.kind === 'signature' ? 'Signature' : 'Image' },
      };
    }
    case 'text': {
      if (!font) return null;
      const baselines = textBaselines(annotation);
      const ops: PDFOperator[] = [beginText(), setFontAndSize('F1', annotation.fontSize), setFillingRgbColor(r, g, b)];
      textLines(annotation).forEach((line, i) => {
        if (!line) return;
        ops.push(setTextMatrix(1, 0, 0, 1, annotation.position[0], baselines[i]!), showText(font.encodeText(line)));
      });
      ops.push(endText());
      return {
        subtype: 'FreeText',
        rect: textBox(annotation, font),
        appearance: ops,
        resources: { Font: { F1: font.ref } },
        extra: {
          Contents: PDFHexString.fromText(annotation.text),
          // Used by viewers that regenerate the appearance (e.g. after editing in Acrobat).
          DA: PDFString.of(`/Helv ${annotation.fontSize} Tf ${r} ${g} ${b} rg`),
          BS: { Type: 'Border', W: 0 },
        },
      };
    }
  }
}

/** The bytes and format of a picture given as a data URL. */
export function decodeDataUrl(src: string): { bytes: Uint8Array; type: 'png' | 'jpeg' } | null {
  const match = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(src);
  if (!match) return null;
  const binary = atob(match[2]!);
  return { bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)), type: match[1]!.toLowerCase() === 'png' ? 'png' : 'jpeg' };
}

/** Embeds every picture the annotations use, once each. */
export async function embedImages(doc: PDFDocument, annotations: Annotation[]): Promise<Map<string, PDFImage>> {
  const images = new Map<string, PDFImage>();
  for (const annotation of annotations) {
    if (annotation.type !== 'image' || images.has(annotation.src)) continue;
    const decoded = decodeDataUrl(annotation.src);
    if (!decoded) continue;
    images.set(annotation.src, decoded.type === 'png' ? await doc.embedPng(decoded.bytes) : await doc.embedJpg(decoded.bytes));
  }
  return images;
}

/**
 * Adds every annotation to its page as a real PDF annotation (Highlight,
 * Underline, StrikeOut, Square, Ink, FreeText, Stamp for pictures) with an appearance stream, so
 * other viewers show it and it stays editable in Acrobat, Preview and the
 * editor itself. `images` are the pictures embedded by `embedImages`.
 */
export function writeAnnotations(
  doc: PDFDocument,
  annotations: Annotation[],
  font: PDFFont | null,
  images: Map<string, PDFImage> = new Map(),
): void {
  const pages: PDFPage[] = doc.getPages();
  const modified = PDFString.of(pdfDate(new Date()));

  for (const annotation of annotations) {
    const page = pages[annotation.pageIndex];
    const built = page && build(annotation, font, images);
    if (!page || !built) continue;

    const bbox = rectToArray(built.rect);
    const appearance = doc.context.formXObject(built.appearance, {
      BBox: bbox,
      Resources: (built.resources ?? {}) as never,
    });

    const dict = doc.context.obj({
      Type: 'Annot',
      Subtype: built.subtype,
      Rect: bbox,
      F: PRINT_FLAG,
      P: page.ref,
      // /NM keeps our id, so a saved file opens with the same annotation ids.
      NM: PDFHexString.fromText(annotation.id),
      M: modified,
      CreationDate: PDFString.of(pdfDate(new Date(annotation.createdAt))),
      AP: { N: doc.context.register(appearance) },
      // For FreeText /C is the background fill, so text color lives in /DA instead.
      ...(annotation.type === 'text' ? {} : { C: hexToComponents(annotation.color) }),
      ...(annotation.author ? { T: PDFHexString.fromText(annotation.author) } : {}),
      ...(annotation.comment && annotation.type !== 'text' ? { Contents: PDFHexString.fromText(annotation.comment) } : {}),
    });
    for (const [key, value] of Object.entries(built.extra ?? {})) {
      dict.set(name(key), doc.context.obj(value as never));
    }
    if (annotation.type === 'image') {
      // The original file, so reopening gives back the same picture rather than a re-encoded one.
      const decoded = decodeDataUrl(annotation.src);
      if (decoded) {
        const source = doc.context.flateStream(decoded.bytes, { Subtype: decoded.type === 'png' ? 'image/png' : 'image/jpeg' });
        dict.set(name(IMAGE_SOURCE_KEY), doc.context.register(source));
      }
    }
    page.node.addAnnot(doc.context.register(dict));
  }
}
