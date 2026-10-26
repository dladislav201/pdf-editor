import { PdfEditor, type PdfEditorInstance } from '@pdfsdk/react';
import type { ToolName } from '@pdfsdk/editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';
import { DEMO_LICENSE_KEY } from './license';
import { Pages } from './Pages';
import { SignDialog } from './SignDialog';
import { reportError, track } from './telemetry';
import { CompressDialog, ImagesDialog } from './ExportDialogs';
import { FeedbackDialog } from './FeedbackDialog';
import { PasswordDialog } from './PasswordDialog';
import { useI18n } from './i18n';

const TOOLS: { tool: 'select' | 'editText' | 'highlight' | 'ink' | 'rectangle' | 'text'; icon: IconName; key: string }[] = [
  { tool: 'select', icon: 'cursor', key: 'V' },
  { tool: 'editText', icon: 'editText', key: 'E' },
  { tool: 'highlight', icon: 'highlight', key: 'H' },
  { tool: 'ink', icon: 'draw', key: 'D' },
  { tool: 'rectangle', icon: 'shapes', key: 'R' },
  { tool: 'text', icon: 'text', key: 'T' },
];
const COLORS = ['#facc15', '#ef4444', '#22c55e', '#2f6fed', '#191918'];
const MAX_FIT_ZOOM = 1.25;

type Scan =
  | { kind: 'none' }
  | { kind: 'scanned'; pages: number[] }
  | { kind: 'reading'; done: number; total: number }
  | { kind: 'done'; words: number };

function ToolButton({
  name,
  icon,
  label,
  shortcut,
  active,
  editor,
}: {
  name: ToolName;
  icon: IconName;
  label: string;
  shortcut: string;
  active: boolean;
  editor: PdfEditorInstance | null;
}) {
  return (
    <button
      type="button"
      className={name === 'select' ? 'pill pill--icon' : 'pill'}
      aria-pressed={active}
      title={`${label} (${shortcut})`}
      aria-label={label}
      onClick={() => {
        track(`tool.${name}`);
        editor?.setTool(name);
      }}
    >
      <Icon name={icon} />
      {name !== 'select' && <span className="wide-only">{label}</span>}
    </button>
  );
}

export function Workspace({
  file,
  tool: initialTool,
  recognize,
  pages: startInPages,
  sign: startSigning,
  dialog: startDialog,
  theme,
  onToggleTheme,
  onClose,
}: {
  file: File;
  tool?: ToolName;
  recognize?: boolean;
  pages?: boolean;
  sign?: boolean;
  /** A dialog to open once the file is loaded. */
  dialog?: 'compress' | 'images';
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const w = t.workspace;
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
  const [fields, setFields] = useState(0);
  // A paragraph is open for typing: Esc (or a click elsewhere) finishes it.
  const [typing, setTyping] = useState(false);
  const [mode, setMode] = useState<'edit' | 'pages'>('edit');
  const [loaded, setLoaded] = useState(false);
  const wantPages = useRef(startInPages);
  const wantSign = useRef(startSigning);
  const [signing, setSigning] = useState(false);
  const [dialog, setDialog] = useState<'compress' | 'images' | null>(null);
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState<{ open: boolean; query: string; count: number; active: number; busy?: boolean }>({
    open: false,
    query: '',
    count: 0,
    active: -1,
  });
  const searchInput = useRef<HTMLInputElement>(null);
  const wantDialog = useRef(startDialog);
  // Filling a form counts once per document, not per keystroke.
  const formTracked = useRef(false);
  const [feedback, setFeedback] = useState(false);
  // A protected file waiting for its password: answering resolves the editor's question.
  const [passwordAsk, setPasswordAsk] = useState<{
    fileName: string;
    incorrect: boolean;
    attempt: number;
    answer: (password: string | null) => void;
  } | null>(null);
  const attempts = useRef(0);
  const getPassword = useCallback(
    (request: { fileName: string; incorrect: boolean }) =>
      new Promise<string | null>((resolve) => setPasswordAsk({ ...request, attempt: ++attempts.current, answer: resolve })),
    [],
  );

  // Keep the editor in step with the site's theme.
  useEffect(() => editor?.setTheme(theme), [editor, theme]);

  const read = useCallback(async () => {
    track('ocr.run');
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
      editor.on('textEditing', ({ paragraph }) => setTyping(!!paragraph)),
      editor.on('documentUnlocked', ({ password }) => {
        track(password ? 'open.unlocked.password' : 'open.unlocked.owner');
        if (password) setMessage(w.unlocked);
      }),
      editor.on('ocrProgress', ({ pageIndex, done, total }) => {
        if (pageIndex >= 0) setScan({ kind: 'reading', done, total });
      }),
      // Also when a click with Edit text started it.
      editor.on('textRecognized', ({ pages }) => {
        track('ocr.done');
        setScan({ kind: 'done', words: pages.reduce((n, p) => n + p.words.length, 0) });
      }),
      editor.on('error', ({ error }) => {
        if ((error as Error)?.name !== 'AbortError') setMessage(error instanceof Error ? error.message : String(error));
      }),
      editor.on('documentLoaded', async ({ pageCount }) => {
        setPage({ index: 0, count: pageCount });
        setLoaded(true);
        // A form: fields take typing with the Select tool, so start there.
        const formFields = editor.getFormFields().length;
        setFields(formFields);
        if (formFields) editor.setTool('select');
        if (wantPages.current) {
          wantPages.current = false;
          setMode('pages');
        }
        if (wantSign.current) {
          wantSign.current = false;
          setSigning(true);
        }
        if (wantDialog.current) {
          setDialog(wantDialog.current);
          wantDialog.current = undefined;
        }
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

  const openSearch = useCallback(() => {
    track('search.open');
    setSearch((s) => ({ ...s, open: true }));
    requestAnimationFrame(() => searchInput.current?.select());
  }, []);
  const closeSearch = () => {
    editor?.clearSearch();
    setSearch({ open: false, query: '', count: 0, active: -1 });
  };
  const step = (by: number) => {
    if (!search.count) return;
    const active = (search.active + by + search.count) % search.count;
    editor?.showSearchMatch(active);
    setSearch((s) => ({ ...s, active }));
  };

  // Search as the query changes (a moment after typing stops); the first match shows as soon as it's found.
  useEffect(() => {
    if (!editor || !search.open) return;
    const query = search.query;
    const update = (count: number, busy: boolean) =>
      setSearch((s) => (s.query === query ? { ...s, count, busy, active: count ? Math.max(s.active, 0) : -1 } : s));
    const timer = setTimeout(async () => {
      let shown = false;
      update(0, !!query.trim());
      const matches = await editor.search(query, {
        onProgress: ({ matches, done, total }) => {
          if (matches.length && !shown) {
            shown = true;
            editor.showSearchMatch(0);
          }
          update(matches.length, done < total);
        },
      });
      update(matches.length, false);
    }, 200);
    return () => clearTimeout(timer);
  }, [editor, search.open, search.query]);

  // ⌘F / Ctrl+F opens the document's own search instead of the browser's.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // By the key's place, so ⌘F works with any keyboard layout (it reports "а" on a Ukrainian one).
      if ((event.metaKey || event.ctrlKey) && event.code === 'KeyF' && mode === 'edit') {
        event.preventDefault();
        openSearch();
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [mode, openSearch]);

  const drawing = tool === 'highlight' || tool === 'ink' || tool === 'rectangle' || tool === 'text';

  return (
    <div className="workspace" data-search={search.open ? 'open' : undefined} data-mode={mode}>
      <div className="workspace__editor">
        <PdfEditor
          ref={editorRef}
          document={file}
          toolbar={false}
          theme={theme}
          assetsUrl="/engine/"
          fontUrl="/fonts/DejaVuSans.ttf"
          licenseKey={DEMO_LICENSE_KEY}
          messages={t.editor}
          getPassword={getPassword}
          onReady={setEditor}
          onError={reportError}
          onFormChange={() => {
            if (!formTracked.current) track('form.fill');
            formTracked.current = true;
          }}
        />
      </div>

      <div className="top-left">
        <button type="button" className="float" onClick={onClose} aria-label={w.back}>
          <Icon name="back" />
        </button>
        {search.open ? (
          <div className="bar searchbar" role="search">
            <span className="pill pill--icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              ref={searchInput}
              autoFocus
              value={search.query}
              placeholder={w.find}
              aria-label={w.find}
              onChange={(e) => setSearch((s) => ({ ...s, query: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') closeSearch();
              }}
            />
            <span className="label">
              {!search.query.trim()
                ? ''
                : search.count
                  ? `${w.match(search.active + 1, search.count)}${search.busy ? '…' : ''}`
                  : search.busy
                    ? w.searching
                    : w.noResults}
            </span>
            <div className="group">
              <button type="button" className="pill pill--icon" aria-label={w.previousMatch} disabled={!search.count} onClick={() => step(-1)}>
                <Icon name="up" />
              </button>
              <button type="button" className="pill pill--icon" aria-label={w.nextMatch} disabled={!search.count} onClick={() => step(1)}>
                <Icon name="chevronDown" />
              </button>
            </div>
            <button type="button" className="pill pill--icon" aria-label={w.closeSearch} onClick={closeSearch}>
              <Icon name="close" />
            </button>
          </div>
        ) : (
          <div className="bar">
            <span className="pill pill--icon" aria-hidden="true">
              <Icon name="file" />
            </span>
            <span className="file-name" title={file.name}>
              {file.name}
            </span>
            <button type="button" className="pill pill--icon" aria-label={w.findShortcut} title={w.findTitle} onClick={openSearch}>
              <Icon name="search" />
            </button>
          </div>
        )}
      </div>

      <div className="top-center">
        <div className="bar">
          <div className="group">
            <button type="button" className="pill" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
              <Icon name="edit" /> {w.edit}
            </button>
            <button
              type="button"
              className="pill"
              aria-pressed={mode === 'pages'}
              disabled={!loaded}
              onClick={() => {
                track('pages.open');
                setMode('pages');
              }}
            >
              <Icon name="grid" /> {w.pages}
            </button>
          </div>
          {/* On phones the zoom bar is gone; the page number lives here. */}
          <span className="label narrow-only">{page.count ? `${page.index + 1} / ${page.count}` : '–'}</span>
        </div>
      </div>

      {mode === 'pages' && editor && (
        <Pages editor={editor} fileName={file.name} onClose={() => setMode('edit')} onMessage={setMessage} />
      )}

      <div className="status" aria-live="polite">
        {mode === 'edit' && scan.kind === 'scanned' && (
          <div className="notice">
            <span>{w.scanPages(scan.pages)}</span>
            <button type="button" className="pill pill--ink" onClick={() => void read()}>
              <Icon name="scan" /> {w.recognize}
            </button>
          </div>
        )}
        {scan.kind === 'reading' && (
          <div className="notice notice--plain">
            {w.reading(scan.done + 1, scan.total)}
          </div>
        )}
        {scan.kind === 'done' && (
          <div className="notice notice--plain">
            <strong>{w.recognized(scan.words)}</strong>&nbsp;{w.recognizedHint}
          </div>
        )}
        {mode === 'edit' && fields > 0 && tool === 'select' && scan.kind === 'none' && (
          <div className="notice notice--plain">
            <strong>{w.fields(fields)}</strong>&nbsp;{w.fieldsHint}
          </div>
        )}
        {message && <div className="notice notice--plain">{message}</div>}
      </div>

      <div className="top-right" hidden={mode === 'pages'}>
        <button type="button" className="float" onClick={onToggleTheme} aria-label={w.theme}>
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
        </button>
        <div className="bar">
          <div className="group">
            <button type="button" className="pill pill--icon" aria-label={w.zoomOut} onClick={() => editor?.zoomOut()}>
              <Icon name="minus" />
            </button>
            <button type="button" className="pill label" onClick={() => editor?.setZoom('fit-width')} title={w.fitWidth}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="pill pill--icon" aria-label={w.zoomIn} onClick={() => editor?.zoomIn()}>
              <Icon name="plus" />
            </button>
          </div>
          <span className="label">{page.count ? `${page.index + 1} / ${page.count}` : '–'}</span>
        </div>
        <div className="bar download">
          <button
            type="button"
            className="pill pill--ink"
            aria-label={`${w.download}${edits ? ` · ${w.edits(edits)}` : ''}`}
            onClick={() => {
              track('download.pdf');
              void editor?.download(file.name).catch(reportError);
            }}
          >
            <Icon name="download" />
            <span className="wide-only">
              {w.download}
              {edits ? ` · ${w.edits(edits)}` : ''}
            </span>
          </button>
          <button
            type="button"
            className="pill pill--icon"
            aria-label={w.moreSave}
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <Icon name="chevronDown" />
          </button>
          {menu && (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  track('download.pdf');
                  void editor?.download(file.name).catch(reportError);
                }}
              >
                <Icon name="file" />{' '}
                <span>
                  <strong>{w.savePdf.title}</strong>
                  {w.savePdf.text}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setDialog('compress');
                }}
              >
                <Icon name="compress" />{' '}
                <span>
                  <strong>{w.saveCompressed.title}</strong>
                  {w.saveCompressed.text}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setDialog('images');
                }}
              >
                <Icon name="image" />{' '}
                <span>
                  <strong>{w.savePictures.title}</strong>
                  {w.savePictures.text}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="bottom-center" hidden={mode === 'pages'}>
        {/* The tool's own options, above the tools. */}
        {(drawing || tool === 'select' || tool === 'editText') && (
          <div className="bar">
            <div className="group">
              <button
                type="button"
                className="pill pill--icon"
                aria-label={w.undo}
                disabled={!history.canUndo}
                // Keep the caret in an open paragraph: typing goes on after undoing.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor?.undo()}
              >
                <Icon name="undo" />
              </button>
              <button
                type="button"
                className="pill pill--icon"
                aria-label={w.redo}
                disabled={!history.canRedo}
                // Keep the caret in an open paragraph: typing goes on after undoing.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor?.redo()}
              >
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
                    aria-label={w.colour(c)}
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
                <button
                  type="button"
                  className="pill pill--icon"
                  aria-label={w.delete}
                  disabled={!selected}
                  onClick={() => editor?.deleteSelected()}
                >
                  <Icon name="trash" />
                </button>
              </div>
            )}
          </div>
        )}
        {tool === 'editText' && (
          <div className="notice notice--plain">
            {typing ? w.editTextFinish : scan.kind === 'scanned' ? w.editTextScan : scan.kind === 'reading' ? w.editTextReading : w.editTextHint}
          </div>
        )}
        {tool === 'image' && (
          <div className="notice notice--plain">{w.placeSignature}</div>
        )}
        <nav className="bar" aria-label={w.tools}>
          <div className="group">
            {TOOLS.map(({ tool: name, icon, key }) => (
              <ToolButton key={name} name={name} icon={icon} label={w.tool[name]} shortcut={key} active={tool === name} editor={editor} />
            ))}
          </div>
          <div className="group">
            <button type="button" className="pill" aria-label={w.sign} aria-pressed={signing || tool === 'image'} onClick={() => setSigning(true)}>
              <Icon name="sign" />
              <span className="wide-only">{w.sign}</span>
            </button>
          </div>
        </nav>
      </div>

      {editor && dialog === 'compress' && <CompressDialog editor={editor} fileName={file.name} onClose={() => setDialog(null)} />}
      {editor && dialog === 'images' && <ImagesDialog editor={editor} fileName={file.name} onClose={() => setDialog(null)} />}

      <button type="button" className="float feedback-button" hidden={mode === 'pages'} onClick={() => setFeedback(true)} aria-label={w.feedback} title={w.feedback}>
        <Icon name="feedback" />
      </button>
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} />}
      {passwordAsk && (
        <PasswordDialog
          key={passwordAsk.attempt}
          fileName={passwordAsk.fileName}
          incorrect={passwordAsk.incorrect}
          onAnswer={(password) => {
            passwordAsk.answer(password);
            setPasswordAsk(null);
          }}
        />
      )}

      {signing && (
        <SignDialog
          onClose={() => setSigning(false)}
          onPlace={(signature) => {
            track('sign.place');
            setSigning(false);
            editor?.placeImage({ ...signature, kind: 'signature' });
          }}
        />
      )}
    </div>
  );
}
