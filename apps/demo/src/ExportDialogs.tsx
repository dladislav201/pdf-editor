import type { CompressLevel } from '@pdfsdk/editor';
import type { PdfEditorInstance } from '@pdfsdk/react';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { reportError, track } from './telemetry';
import { saveBlob, zip } from './zip';

const baseName = (fileName: string) => fileName.replace(/\.pdf$/i, '');

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A small centred card on a dimmed page. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal__card modal__card--small">
        <div className="modal__body">
          <div className="modal__head">
            <h2>{title}</h2>
            <button type="button" className="pill pill--icon" aria-label={t.dialog.close} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

const LEVELS: CompressLevel[] = ['light', 'recommended', 'strong'];

export function CompressDialog({
  editor,
  fileName,
  onClose,
}: {
  editor: PdfEditorInstance;
  fileName: string;
  onClose: () => void;
}) {
  const c = useI18n().t.compress;
  const [level, setLevel] = useState<CompressLevel>('recommended');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ level: CompressLevel; bytes: Uint8Array; before: number; after: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult({ level, ...(await editor.compress(level)) });
    } catch (e) {
      reportError(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const current = result?.level === level ? result : null;
  const saved = current ? Math.round((1 - current.after / current.before) * 100) : 0;

  return (
    <Dialog title={c.title} onClose={onClose}>
      <div className="choices">
        {LEVELS.map((l) => (
          <button key={l} type="button" className="choice" aria-pressed={level === l} onClick={() => setLevel(l)}>
            <strong>{c.levels[l].label}</strong>
            <span>{c.levels[l].text}</span>
          </button>
        ))}
      </div>
      <p className="dialog__note">{c.note}</p>
      {current && (
        <div className="result">
          <span>{formatSize(current.before)}</span>
          <Icon name="arrowRight" size={14} />
          <strong>{formatSize(current.after)}</strong>
          <em>{saved > 0 ? c.smaller(saved) : c.smallest}</em>
        </div>
      )}
      {error && <p className="dialog__error">{error}</p>}
      <div className="modal__foot">
        <button type="button" className="pill" onClick={onClose}>
          {c.cancel}
        </button>
        {current ? (
          <button
            type="button"
            className="pill pill--ink"
            onClick={() => {
              track(`download.compressed.${current.level}`);
              saveBlob(
                new Blob([current.bytes as BlobPart], { type: 'application/pdf' }),
                c.fileName(baseName(fileName)),
              );
            }}
          >
            <Icon name="download" /> {c.download}
          </button>
        ) : (
          <button type="button" className="pill pill--ink" disabled={busy} onClick={() => void run()}>
            {busy ? c.running : c.run}
          </button>
        )}
      </div>
    </Dialog>
  );
}

const DPIS = [72, 150, 300];

export function ImagesDialog({
  editor,
  fileName,
  onClose,
}: {
  editor: PdfEditorInstance;
  fileName: string;
  onClose: () => void;
}) {
  const m = useI18n().t.images;
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    try {
      // Edits and annotations go into the pictures too: render what will be downloaded.
      const source = await editor.openPages(new Blob([(await editor.exportPdf({ flatten: true })) as BlobPart]));
      try {
        const files: { name: string; bytes: Uint8Array }[] = [];
        for (let page = 0; page < source.pageCount; page++) {
          setBusy(m.progress(page + 1, source.pageCount));
          const width = Math.round((source.sizes[page]!.width * dpi) / 72);
          const bitmap = await source.render(page, width);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, bitmap.width, bitmap.height);
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: 0.9 });
          const ext = format === 'png' ? 'png' : 'jpg';
          files.push({
            name: `${m.pageName(baseName(fileName), page + 1)}.${ext}`,
            bytes: new Uint8Array(await blob.arrayBuffer()),
          });
        }
        track(`download.pictures.${format}`);
        if (files.length === 1) saveBlob(new Blob([files[0]!.bytes as BlobPart], { type: `image/${format}` }), files[0]!.name);
        else saveBlob(zip(files), m.zipName(baseName(fileName)));
        onClose();
      } finally {
        source.close();
      }
    } catch (e) {
      reportError(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog title={m.title} onClose={onClose}>
      <div className="row">
        <span className="row__label">{m.format}</span>
        <div className="group">
          <button type="button" className="pill" aria-pressed={format === 'png'} onClick={() => setFormat('png')}>
            PNG
          </button>
          <button type="button" className="pill" aria-pressed={format === 'jpeg'} onClick={() => setFormat('jpeg')}>
            JPG
          </button>
        </div>
      </div>
      <div className="row">
        <span className="row__label">{m.resolution}</span>
        <div className="group">
          {DPIS.map((d) => (
            <button key={d} type="button" className="pill" aria-pressed={dpi === d} onClick={() => setDpi(d)}>
              {d} dpi
            </button>
          ))}
        </div>
      </div>
      <p className="dialog__note">{m.note}</p>
      {error && <p className="dialog__error">{error}</p>}
      <div className="modal__foot">
        <button type="button" className="pill" onClick={onClose}>
          {m.cancel}
        </button>
        <button type="button" className="pill pill--ink" disabled={!!busy} onClick={() => void run()}>
          {busy ?? (
            <>
              <Icon name="download" /> {m.save}
            </>
          )}
        </button>
      </div>
    </Dialog>
  );
}
