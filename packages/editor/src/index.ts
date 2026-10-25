export { PdfEditor } from './editor';
export { exportPdf, type ExportOptions } from './export';
export type { ScanInfo } from './engine/pdfium-core';
export type { OcrPage, OcrWord } from './ocr/types';
export { checkLicense, type LicenseInfo, type LicensePayload, type LicenseStatus } from './license';
export { arrangePages, type ArrangedPage } from './pdf/arrange';
export { imagesToPdf, type PageImage } from './pdf/images';
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
  CompressLevel,
  PageSource,
  RecognizeOptions,
  RectangleAnnotation,
  TextAnnotation,
  ToolName,
  ZoomValue,
} from './types';
