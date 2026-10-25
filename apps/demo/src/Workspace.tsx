import { PdfEditor, type PdfEditorInstance } from '@pdfsdk/react';
import type { ToolName } from '@pdfsdk/editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';
import { DEMO_LICENSE_KEY } from './license';

const TOOLS: { tool: ToolName; icon: IconName; label: string; key: string }[] = [
  { tool: 'select', icon: 'cursor', label: 'Select', key: 'V' },
  { tool: 'editText', icon: 'editText', label: 'Edit text', key: 'E' },
  { tool: 'highlight', icon: 'highlight', label: 'Highlight', key: 'H' },
  { tool: 'ink', icon: 'draw', label: 'Draw', key: 'D' },
  { tool: 'rectangle', icon: 'shapes', label: 'Shape', key: 'R' },
  { tool: 'text', icon: 'text', label: 'Note', key: 'T' },
];
const COLORS = ['#facc15', '#ef4444', '#22c55e', '#2f6fed', '#191918'];
const MAX_FIT_ZOOM = 1.25;

type Scan =
  | { kind: 'none' }
  | { kind: 'scanned'; pages: number[] }
  | { kind: 'reading'; done: number; total: number }
  | { kind: 'done'; words: number };

export function Workspace({
  file,
  tool: initialTool,
  recognize,
  theme,
  onToggleTheme,
  onClose,
}: {
  file: File;
  tool?: ToolName;
  recognize?: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onClose: () => void;
}) {
  const editorRef = useRef<PdfEditorInstance | null>(null);
  const [editor, setEditor] = useState<PdfEditorInstance | null>(null);
  const [tool, setTool] = useState<ToolName>(initialTool ?? 'select');
  const [color, setColor] = useState<string | null>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState({ index: 0, count: 0 });
  const [scan, setScan] = useState<Scan>({ kind: 'none' });
  const [message, setMessage] = useState<string | null>(null);
  const [edits, setEdits] = useState(0);

  // Keep the editor in step with the site's theme.
  useEffect(() => editor?.setTheme(theme), [editor, theme]);

  const read = useCallback(async () => {
    try {
      const pages = await editorRef.current?.recognizeText();
      setScan({ kind: 'done', words: pages?.reduce((n, p) => n + p.words.length, 0) ?? 0 });
    } catch {
      setScan({ kind: 'none' });
    }
  }, []);

  useEffect(() => {
    if (!editor) return;
    const offs = [
      editor.on('toolChange', ({ tool }) => setTool(tool)),
      editor.on('colorChange', ({ color }) => setColor(color)),
      editor.on('historyChange', (h) => setHistory(h)),
      editor.on('selectionChange', ({ id }) => setSelected(id)),
      editor.on('zoomChange', ({ zoom }) => setZoom(zoom)),
      editor.on('pageChange', ({ pageIndex }) => setPage((p) => ({ ...p, index: pageIndex }))),
      editor.on('textEditsChange', ({ edits }) => setEdits(edits.length)),
      editor.on('ocrProgress', ({ pageIndex, done, total }) => {
        if (pageIndex >= 0) setScan({ kind: 'reading', done, total });
      }),
      editor.on('error', ({ error }) => {
        if ((error as Error)?.name !== 'AbortError') setMessage(error instanceof Error ? error.message : String(error));
      }),
      editor.on('documentLoaded', async ({ pageCount }) => {
        setPage({ index: 0, count: pageCount });
        // Fit the width, but don't blow a page up on a wide screen.
        if (editor.getZoom() > MAX_FIT_ZOOM) editor.setZoom(MAX_FIT_ZOOM);
        if (initialTool) editor.setTool(initialTool);
        const scanned: number[] = [];
        for (let i = 0; i < Math.min(pageCount, 50); i++) {
          const info = await editor.getScanInfo(i).catch(() => null);
          if (info?.scanned && !info.recognized) scanned.push(i);
        }
        if (!scanned.length) return;
        setScan({ kind: 'scanned', pages: scanned });
        if (recognize) void read();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [editor, initialTool, recognize, read]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  const drawing = tool === 'highlight' || tool === 'ink' || tool === 'rectangle' || tool === 'text';

  return (
    <div className="workspace">
      <div className="workspace__editor">
        <PdfEditor
          ref={editorRef}
          document={file}
          toolbar={false}
          theme={theme}
          assetsUrl="/engine/"
          fontUrl="/fonts/DejaVuSans.ttf"
          licenseKey={DEMO_LICENSE_KEY}
          onReady={setEditor}
        />
      </div>

      <div className="top-left">
        <button type="button" className="float" onClick={onClose} aria-label="Back to start">
          <Icon name="back" />
        </button>
        <div className="bar">
          <span className="pill pill--icon" aria-hidden="true">
            <Icon name="file" />
          </span>
          <span className="file-name" title={file.name}>
            {file.name}
          </span>
        </div>
      </div>

      <div className="top-center" aria-live="polite">
        {scan.kind === 'scanned' && (
          <div className="notice">
            <span>
              {scan.pages.length === 1 ? `Page ${scan.pages[0]! + 1} is` : `${scan.pages.length} pages are`} a scan
            </span>
            <button type="button" className="pill pill--ink" onClick={() => void read()}>
              <Icon name="scan" /> Recognize text
            </button>
          </div>
        )}
        {scan.kind === 'reading' && (
          <div className="notice notice--plain">
            Reading page {scan.done + 1} of {scan.total}…
          </div>
        )}
        {scan.kind === 'done' && (
          <div className="notice notice--plain">
            <strong>{scan.words} words recognized.</strong>&nbsp;Pick Edit text and click a line to change it.
          </div>
        )}
        {message && <div className="notice notice--plain">{message}</div>}
      </div>

      <div className="top-right">
        <button type="button" className="float" onClick={onToggleTheme} aria-label="Switch theme">
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
        </button>
        <div className="bar">
          <div className="group">
            <button type="button" className="pill pill--icon" aria-label="Zoom out" onClick={() => editor?.zoomOut()}>
              <Icon name="minus" />
            </button>
            <button type="button" className="pill label" onClick={() => editor?.setZoom('fit-width')} title="Fit width">
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="pill pill--icon" aria-label="Zoom in" onClick={() => editor?.zoomIn()}>
              <Icon name="plus" />
            </button>
          </div>
          <span className="label">
            {page.count ? `${page.index + 1} / ${page.count}` : '–'}
          </span>
        </div>
        <div className="bar">
          <button type="button" className="pill pill--ink" onClick={() => void editor?.download(file.name).catch(() => undefined)}>
            <Icon name="download" /> Download{edits ? ` · ${edits} edit${edits > 1 ? 's' : ''}` : ''}
          </button>
        </div>
      </div>

      <div className="bottom-center">
        {/* The tool's own options, above the tools. */}
        {(drawing || tool === 'select') && (
          <div className="bar">
            <div className="group">
              <button type="button" className="pill pill--icon" aria-label="Undo" disabled={!history.canUndo} onClick={() => editor?.undo()}>
                <Icon name="undo" />
              </button>
              <button type="button" className="pill pill--icon" aria-label="Redo" disabled={!history.canRedo} onClick={() => editor?.redo()}>
                <Icon name="redo" />
              </button>
            </div>
            {drawing && (
              <div className="group">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="pill pill--icon"
                    aria-label={`Colour ${c}`}
                    aria-pressed={color === c}
                    onClick={() => editor?.setColor(c)}
                  >
                    <span className="swatch" style={{ background: c }} />
                  </button>
                ))}
              </div>
            )}
            {tool === 'select' && (
              <div className="group">
                <button type="button" className="pill pill--icon" aria-label="Delete" disabled={!selected} onClick={() => editor?.deleteSelected()}>
                  <Icon name="trash" />
                </button>
              </div>
            )}
          </div>
        )}
        {tool === 'editText' && <div className="notice notice--plain">Click a paragraph to edit it. Esc to finish.</div>}
        <nav className="bar" aria-label="Tools">
          <div className="group">
            {TOOLS.map(({ tool: t, icon, label, key }) => (
              <button
                key={t}
                type="button"
                className={t === 'select' ? 'pill pill--icon' : 'pill'}
                aria-pressed={tool === t}
                title={`${label} (${key})`}
                aria-label={label}
                onClick={() => editor?.setTool(t)}
              >
                <Icon name={icon} />
                {t !== 'select' && label}
              </button>
            ))}
          </div>
        </nav>
      </div>

    </div>
  );
}
