import {
  PdfEditor,
  type Annotation,
  type OcrPage,
  type PageText,
  type PdfEditorInstance,
  type TextParagraph,
} from '@pdfsdk/react';
import { useEffect, useRef, useState } from 'react';
import scanSampleUrl from '../../../packages/editor/test/fixtures/scan-invoice.pdf?url';
import { createSamplePdf } from './sample-pdf';

const TYPE_LABELS: Record<Annotation['type'], string> = {
  highlight: 'Highlight',
  rectangle: 'Rectangle',
  ink: 'Drawing',
  text: 'Text',
};

const SNIPPET = `import { PdfEditor } from '@pdfsdk/react';

<PdfEditor
  document="/contracts/nw-0417.pdf"
  annotations={saved}
  onAnnotationsChange={save}
/>`;

function describe(annotation: Annotation): string {
  if (annotation.type === 'text') return annotation.text.split('\n')[0] ?? '';
  if (annotation.type === 'ink') return `${annotation.paths.length} stroke`;
  const { width, height } = annotation.rect;
  return `${Math.round(width)} × ${Math.round(height)} pt`;
}

const fontLabel = (fonts: PageText['fonts'], id: number) => {
  const font = fonts[id];
  return font ? font.name.replace(/^[A-Z]{6}\+/, '') : `font ${id}`;
};

function TextInspector({ paragraph, fonts }: { paragraph: TextParagraph; fonts: PageText['fonts'] }) {
  const runs = paragraph.lines.flatMap((line) => line.runs);
  const styles = [...new Map(runs.map((run) => [`${run.font}|${run.size.toFixed(1)}|${run.color}`, run])).values()];
  return (
    <div className="inspector">
      <dl className="facts">
        <dt>Align</dt>
        <dd>{paragraph.align}</dd>
        <dt>Lines</dt>
        <dd>{paragraph.lines.length}</dd>
        <dt>Leading</dt>
        <dd>{paragraph.leading.toFixed(1)} pt</dd>
        <dt>Indent</dt>
        <dd>{paragraph.indent ? `${paragraph.indent.toFixed(1)} pt` : '—'}</dd>
      </dl>
      <ul className="styles">
        {styles.map((run) => (
          <li key={`${run.font}|${run.size}|${run.color}`}>
            <span className="annotation__dot" style={{ background: run.color }} />
            <span>
              {fontLabel(fonts, run.font)} · {run.size.toFixed(1)} pt
            </span>
          </li>
        ))}
      </ul>
      {!paragraph.editable && <p className="hint">{paragraph.reason}</p>}
      <blockquote className="quote">{paragraph.text}</blockquote>
    </div>
  );
}

type ScanState =
  | { kind: 'none' }
  | { kind: 'scanned'; pages: number[] }
  | { kind: 'reading'; done: number; total: number }
  | { kind: 'done'; pages: OcrPage[] };

function ScanPanel({ state, onRecognize, onSample }: { state: ScanState; onRecognize: () => void; onSample: () => void }) {
  if (state.kind === 'reading') {
    return (
      <p className="notice">
        Reading page {state.done + 1} of {state.total}… Stamps and signatures are ignored, tables are read cell by cell.
      </p>
    );
  }
  if (state.kind === 'done') {
    const words = state.pages.reduce((n, p) => n + p.words.length, 0);
    return (
      <>
        <p className="notice">
          Recognized {words} words on {state.pages.length} {state.pages.length === 1 ? 'page' : 'pages'} (
          {state.pages.map((p) => `${(p.durationMs / 1000).toFixed(1)} s, ${Math.round(p.confidence)}% confidence`).join('; ')}).
          The text now sits invisibly under the scan: select it, search it, copy it, and it's in the downloaded PDF.
          Pick Edit text (E) and click a line to change it: its words come off the scan and are written anew in a
          matching size, weight and colour.
        </p>
        <blockquote className="quote">
          {state.pages[0]?.words.slice(0, 40).map((w) => w.text).join(' ')}…
        </blockquote>
      </>
    );
  }
  if (state.kind === 'scanned') {
    return (
      <>
        <p className="notice">
          {state.pages.length === 1 ? 'Page' : 'Pages'} {state.pages.map((i) => i + 1).join(', ')}{' '}
          {state.pages.length === 1 ? 'is a scan' : 'are scans'}: an image without text. Recognize the text (Ukrainian
          and English) to make it searchable and selectable.
        </p>
        <button type="button" className="secondary-button" onClick={onRecognize}>
          Recognize text
        </button>
      </>
    );
  }
  return (
    <>
      <p className="hint">Scanned pages are found on open. Recognition runs in your browser; nothing is uploaded.</p>
      <button type="button" className="secondary-button" onClick={onSample}>
        Open a scanned sample
      </button>
    </>
  );
}

export function App() {
  const [document, setDocument] = useState<Uint8Array | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paragraph, setParagraph] = useState<TextParagraph | null>(null);
  const [textEdits, setTextEdits] = useState(0);
  const [fonts, setFonts] = useState<PageText['fonts']>({});
  const [scan, setScan] = useState<ScanState>({ kind: 'none' });
  const editorRef = useRef<PdfEditorInstance | null>(null);

  const inspect = (selected: TextParagraph | null) => {
    setParagraph(selected);
    if (selected) void editorRef.current?.getPageText(selected.pageIndex).then((page) => setFonts(page.fonts));
  };

  useEffect(() => {
    createSamplePdf().then(setDocument, (e: unknown) => setError(String(e)));
  }, []);

  const findScans = async (pageCount: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    setScan({ kind: 'none' });
    const pages: number[] = [];
    for (let i = 0; i < Math.min(pageCount, 50); i++) {
      const info = await editor.getScanInfo(i).catch(() => null);
      if (info?.scanned && !info.recognized) pages.push(i);
    }
    if (pages.length) setScan({ kind: 'scanned', pages });
  };

  const recognize = () => {
    void editorRef.current
      ?.recognizeText()
      .then((pages) => setScan({ kind: 'done', pages }))
      .catch(() => setScan({ kind: 'none' }));
  };

  const openScanSample = async () => {
    const response = await fetch(scanSampleUrl);
    setDocument(new Uint8Array(await response.arrayBuffer()));
  };

  const focus = (annotation: Annotation) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setTool('select');
    editor.goToPage(annotation.pageIndex);
    editor.select(annotation.id);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="brand__logo">
            <path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
            <path d="M14 2v5h5" />
            <path d="m9 15 2 2 4-4" />
          </svg>
          <strong>PDF SDK</strong>
          <span className="badge">Demo</span>
        </div>
        <p className="tagline">Embeddable PDF editor for web apps. Files never leave this page.</p>
      </header>

      <main className="layout">
        <section className="editor-pane" aria-label="PDF editor">
          <PdfEditor
            ref={editorRef}
            document={document ?? undefined}
            assetsUrl="/engine/"
            fontUrl="/fonts/DejaVuSans.ttf"
            author="Demo user"
            onAnnotationsChange={setAnnotations}
            onParagraphSelect={inspect}
            onTextEditsChange={(edits) => setTextEdits(edits.length)}
            onDocumentLoaded={({ pageCount }) => void findScans(pageCount)}
            onOcrProgress={({ pageIndex, done, total }) => {
              if (pageIndex >= 0) setScan({ kind: 'reading', done, total });
            }}
            onTextRecognized={(pages) => setScan({ kind: 'done', pages })}
            onError={(e) => setError(e instanceof Error ? e.message : String(e))}
          />
          {error && (
            <div className="toast" role="alert">
              {error}
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
        </section>

        <aside className="sidebar">
          <section className="panel">
            <h2>
              Text {paragraph && <span className={paragraph.editable ? 'count' : 'count count--muted'}>{paragraph.editable ? 'editable' : 'read-only'}</span>}
            </h2>
            {textEdits > 0 && (
              <p className="notice">
                {textEdits} edited {textEdits === 1 ? 'paragraph' : 'paragraphs'}, written into the PDF when you
                download it.
              </p>
            )}
            {paragraph ? (
              <TextInspector paragraph={paragraph} fonts={fonts} />
            ) : (
              <p className="hint">
                Pick Edit text (E) and click a paragraph to edit it in place, in the document's own fonts. Escape leaves
                the paragraph.
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Scans</h2>
            <ScanPanel state={scan} onRecognize={recognize} onSample={() => void openScanSample()} />
          </section>

          <section className="panel">
            <h2>
              Annotations <span className="count">{annotations.length}</span>
            </h2>
            {annotations.length === 0 ? (
              <p className="hint">Pick a tool in the toolbar and mark up the contract. Shortcuts: V, H, R, D, T.</p>
            ) : (
              <ul className="annotation-list">
                {annotations.map((annotation) => (
                  <li key={annotation.id}>
                    <button type="button" className="annotation" onClick={() => focus(annotation)}>
                      <span className="annotation__dot" style={{ background: annotation.color }} />
                      <span className="annotation__body">
                        <span className="annotation__type">{TYPE_LABELS[annotation.type]}</span>
                        <span className="annotation__meta">
                          p. {annotation.pageIndex + 1} · {describe(annotation)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Delete annotation"
                      onClick={() => editorRef.current?.removeAnnotation(annotation.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Export</h2>
            <p className="hint">
              Download in the toolbar keeps annotations editable in Acrobat, Preview and here. A flattened copy burns them
              into the pages.
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={!document}
              onClick={() => void editorRef.current?.download('flattened.pdf', { flatten: true }).catch(() => undefined)}
            >
              Download flattened copy
            </button>
          </section>

          <section className="panel">
            <h2>Saved state</h2>
            <p className="hint">Annotations are plain JSON in PDF coordinates. Store them in your backend and pass them back in.</p>
            <pre className="code code--json">{JSON.stringify(annotations, null, 2)}</pre>
          </section>

          <section className="panel">
            <h2>Integration</h2>
            <pre className="code">{SNIPPET}</pre>
          </section>
        </aside>
      </main>
    </div>
  );
}
