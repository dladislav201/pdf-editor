import {
  PdfEditor as Editor,
  type Annotation,
  type DocumentSource,
  type EditorOptions,
  type OcrPage,
  type TextParagraph,
} from '@pdfsdk/editor';
import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from 'react';

export type { Annotation, DocumentSource, EditorOptions, OcrPage, OcrWord, PageText, ScanInfo, TextParagraph } from '@pdfsdk/editor';
export type PdfEditorInstance = Editor;

export interface PdfEditorProps extends Omit<EditorOptions, 'container'> {
  className?: string;
  style?: CSSProperties;
  /** Receives the editor instance once it is mounted (and `null` on unmount). */
  ref?: Ref<Editor | null>;
  onReady?: (editor: Editor) => void;
  onDocumentLoaded?: (info: { pageCount: number }) => void;
  onAnnotationsChange?: (annotations: Annotation[]) => void;
  /** A paragraph was picked with the Edit text tool, or the pick was cleared. */
  onParagraphSelect?: (paragraph: TextParagraph | null) => void;
  /** Page text was edited (fires when an edit session ends). */
  onTextEditsChange?: (edits: { paragraphId: string; pageIndex: number; text: string }[]) => void;
  /** Text recognition progress: `pageIndex` is being read, -1 once done. */
  onOcrProgress?: (progress: { pageIndex: number; done: number; total: number }) => void;
  /** Recognized text was added to scanned pages. */
  onTextRecognized?: (pages: OcrPage[]) => void;
  onError?: (error: unknown) => void;
}

/**
 * React wrapper around `PdfEditor`. Options other than `document` are read on
 * mount; changing `document` opens the new file in the same editor.
 */
export function PdfEditor({
  className,
  style,
  ref,
  document,
  onReady,
  onDocumentLoaded,
  onAnnotationsChange,
  onParagraphSelect,
  onTextEditsChange,
  onOcrProgress,
  onTextRecognized,
  onError,
  ...options
}: PdfEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const handlers = { onReady, onDocumentLoaded, onAnnotationsChange, onParagraphSelect, onTextEditsChange, onOcrProgress, onTextRecognized, onError };
  const callbacks = useRef(handlers);
  callbacks.current = handlers;
  const initialOptions = useRef(options);

  useImperativeHandle<Editor | null, Editor | null>(ref, () => editor, [editor]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const editor = new Editor({ ...initialOptions.current, container });
    setEditor(editor);
    const offs = [
      editor.on('documentLoaded', (info) => callbacks.current.onDocumentLoaded?.(info)),
      editor.on('annotationsChange', ({ annotations }) => callbacks.current.onAnnotationsChange?.(annotations)),
      editor.on('paragraphSelect', ({ paragraph }) => callbacks.current.onParagraphSelect?.(paragraph)),
      editor.on('textEditsChange', ({ edits }) => callbacks.current.onTextEditsChange?.(edits)),
      editor.on('ocrProgress', (progress) => callbacks.current.onOcrProgress?.(progress)),
      editor.on('textRecognized', ({ pages }) => callbacks.current.onTextRecognized?.(pages)),
      editor.on('error', ({ error }) => callbacks.current.onError?.(error)),
    ];
    callbacks.current.onReady?.(editor);
    return () => {
      for (const off of offs) off();
      editor.destroy();
      setEditor(null);
    };
  }, []);

  useEffect(() => {
    // Errors are already delivered through `onError`.
    if (editor && document) editor.load(document as DocumentSource).catch(() => undefined);
  }, [editor, document]);

  return <div ref={containerRef} className={className} style={{ height: '100%', ...style }} />;
}
