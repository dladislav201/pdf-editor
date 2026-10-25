export { PdfEditor } from './editor';
export { exportPdf, type ExportOptions } from './export';
export type { ScanInfo } from './engine/pdfium-core';
export type { OcrPage, OcrWord } from './ocr/types';
export { checkLicense, type LicenseInfo, type LicensePayload, type LicenseStatus } from './license';
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
  RecognizeOptions,
  RectangleAnnotation,
  TextAnnotation,
  ToolName,
  ZoomValue,
} from './types';
