export { PdfEditor } from './editor';
export { exportPdf, type ExportOptions } from './export';
export { importAnnotations, type ImportResult } from './pdf/read-annotations';
export type {
  PageText,
  TextAlign,
  TextChar,
  TextFont,
  TextLine,
  TextParagraph,
  TextRun,
} from './text/types';
export type {
  Annotation,
  DocumentSource,
  EditorEventMap,
  EditorOptions,
  HighlightAnnotation,
  InkAnnotation,
  Point,
  Rect,
  RectangleAnnotation,
  TextAnnotation,
  ToolName,
  ZoomValue,
} from './types';
