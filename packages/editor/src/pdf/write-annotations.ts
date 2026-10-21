import {
  LineCapStyle,
  LineJoinStyle,
  PDFHexString,
  PDFString,
  beginText,
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
  type PDFOperator,
  type PDFPage,
} from 'pdf-lib';
import { TEXT_ASCENT, TEXT_LINE_HEIGHT, bounds, textBaselines, textLines } from '../geometry';
import type { Annotation, Rect, TextAnnotation } from '../types';
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

function build(annotation: Annotation, font: PDFFont | null): Built | null {
  const [r, g, b] = hexToComponents(annotation.color);

  switch (annotation.type) {
    case 'highlight': {
      const segments = annotation.segments ?? [annotation.rect];
      // Quad points in the order Acrobat writes them: top-left, top-right, bottom-left, bottom-right.
      const quadPoints = segments.flatMap(({ x, y, width, height }) => [
        x, y + height, x + width, y + height, x, y, x + width, y,
      ]);
      return {
        subtype: 'Highlight',
        rect: annotation.rect,
        appearance: [
          pushGraphicsState(),
          setGraphicsState('GS0'),
          setFillingRgbColor(r, g, b),
          ...segments.map(({ x, y, width, height }) => rectangle(x, y, width, height)),
          fill(),
          popGraphicsState(),
        ],
        // Multiply keeps the text under the highlight readable. Opacity lives in the
        // appearance itself: Preview and pdf.js ignore the annotation-level /CA.
        resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: annotation.opacity } } },
        extra: { QuadPoints: quadPoints },
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

/**
 * Adds every annotation to its page as a real PDF annotation (Highlight,
 * Square, Ink, FreeText) with an appearance stream, so other viewers show it
 * and it stays editable in Acrobat, Preview and the editor itself.
 */
export function writeAnnotations(doc: PDFDocument, annotations: Annotation[], font: PDFFont | null): void {
  const pages: PDFPage[] = doc.getPages();
  const modified = PDFString.of(pdfDate(new Date()));

  for (const annotation of annotations) {
    const page = pages[annotation.pageIndex];
    const built = page && build(annotation, font);
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
    page.node.addAnnot(doc.context.register(dict));
  }
}
