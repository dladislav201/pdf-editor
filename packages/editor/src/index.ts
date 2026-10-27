export { PdfEditor } from './editor';
export { exportPdf, type ExportOptions } from './export';
export type { ScanInfo } from './engine/pdfium-core';
export type { OcrPage, OcrWord, Raster } from './ocr/types';
export { liftInk, readInk, type InkPhoto, type LiftOptions } from './image/ink';
export { checkLicense, type LicenseInfo, type LicensePayload, type LicenseStatus } from './license';
export { arrangePages, type ArrangedPage } from './pdf/arrange';
export { readFormFields, type FormField, type FormValue } from './pdf/forms';
export { imagesToPdf, type PageImage } from './pdf/images';
export { encryptPdf, type EncryptOptions } from './pdf/encrypt';
export { importAnnotations, type ImportResult } from './pdf/read-annotations';
export type { SearchMatch, SearchOptions } from './text/search';
export type { TextStyle, TextStyleKind } from './text/edit-session';
export type { FontFamily } from './text/glyph-store';
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
  EditorMessages,
  EditorOptions,
  HighlightAnnotation,
  TextLineAnnotation,
  InkAnnotation,
  Point,
  Quad,
  Rect,
  CompressLevel,
  PageSource,
  RecognizeOptions,
  RectangleAnnotation,
  TextAnnotation,
  ToolName,
  ZoomValue,
} from './types';
