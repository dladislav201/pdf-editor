import {
  PdfEditor as Editor,
  type Annotation,
  type DocumentSource,
  type EditorOptions,
  type TextParagraph,
} from '@pdfsdk/editor';
import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from 'react';

export type { Annotation, DocumentSource, EditorOptions, PageText, TextParagraph } from '@pdfsdk/editor';
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
  onError,
  ...options
}: PdfEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const callbacks = useRef({ onReady, onDocumentLoaded, onAnnotationsChange, onParagraphSelect, onError });
  callbacks.current = { onReady, onDocumentLoaded, onAnnotationsChange, onParagraphSelect, onError };
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
