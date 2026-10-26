import type { ArrangedPage, PageSource } from '@pdfsdk/editor';
import type { PdfEditorInstance } from '@pdfsdk/react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { Icon } from './icons';
import { track } from './telemetry';

/** A page in the arrangement: where it comes from and how far it is turned. */
interface Item extends ArrangedPage {
  key: string;
  rotate: number;
}

/** Thumbnail width in CSS pixels; rendered at twice that for sharp screens. */
const THUMB = 150;
/** Height of the frame a thumbnail sits in (A4 portrait fills it). */
const FRAME = Math.round(THUMB * 1.42);

function Thumbnail({ source, page, rotate }: { source: PageSource; page: number; rotate: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = source.sizes[page]!;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let cancelled = false;
    // Render once the card scrolls into view.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void source.render(page, THUMB * 2).then(
          (bitmap) => {
            if (cancelled) return bitmap.close();
            el.width = bitmap.width;
            el.height = bitmap.height;
            el.getContext('bitmaprenderer')?.transferFromImageBitmap(bitmap);
          },
          () => undefined,
        );
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [source, page]);
  // Fit the (turned) page into the card's frame.
  const ratio = size.height / size.width;
  const turned = rotate % 180 !== 0;
  const shownWidth = turned ? THUMB * ratio : THUMB;
  const shownHeight = turned ? THUMB : THUMB * ratio;
  const fit = Math.min(THUMB / shownWidth, FRAME / shownHeight);
  return (
    <div className="thumb" style={{ width: THUMB, height: FRAME }}>
      <canvas
        ref={canvas}
        style={{ width: THUMB * fit, height: THUMB * ratio * fit, transform: `rotate(${rotate}deg)` }}
        aria-hidden="true"
      />
    </div>
  );
}

export function Pages({
  editor,
  fileName,
  onClose,
  onMessage,
}: {
  editor: PdfEditorInstance;
  fileName: string;
  onClose: () => void;
  onMessage: (message: string) => void;
}) {
  const own = useMemo(() => editor.pages(), [editor]);
  const [sources, setSources] = useState<{ source: PageSource; bytes?: Uint8Array; name: string }[]>([
    { source: own, name: fileName },
  ]);
  const [items, setItems] = useState<Item[]>(() =>
    Array.from({ length: own.pageCount }, (_, page) => ({ key: `0:${page}`, source: 0, page, rotate: 0 })),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const originalOrder = useRef(items.map((i) => i.key).join());

  // PDFs opened to merge are closed when the view goes.
  const extra = useRef(sources);
  extra.current = sources;
  useEffect(() => () => extra.current.slice(1).forEach((s) => s.source.close()), []);

  const changed = items.map((i) => i.key).join() !== originalOrder.current || items.some((i) => i.rotate) || sources.length > 1;
  const targets = selected.size ? items.filter((i) => selected.has(i.key)) : [];

  const click = (event: MouseEvent, key: string) => {
    const next = new Set(event.metaKey || event.ctrlKey ? selected : []);
    if (event.shiftKey && anchor) {
      const a = items.findIndex((i) => i.key === anchor);
      const b = items.findIndex((i) => i.key === key);
      for (const item of items.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(item.key);
    } else if (next.has(key) && (event.metaKey || event.ctrlKey)) {
      next.delete(key);
    } else {
      next.add(key);
      setAnchor(key);
    }
    setSelected(next);
  };
  const rotate = (keys: Set<string>, by: number) =>
    setItems((list) => list.map((i) => (keys.has(i.key) ? { ...i, rotate: (i.rotate + by + 360) % 360 } : i)));
  const remove = (keys: Set<string>) => {
    if (items.every((i) => keys.has(i.key))) {
      onMessage('A PDF needs at least one page.');
      return;
    }
    setItems((list) => list.filter((i) => !keys.has(i.key)));
    setSelected(new Set());
  };

  const dragOver = (event: DragEvent, key: string) => {
    if (!dragging || dragging === key) return;
    event.preventDefault();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    setItems((list) => {
      const moving = list.filter((i) => i.key === dragging || (selected.has(dragging) && selected.has(i.key)));
      const rest = list.filter((i) => !moving.includes(i));
      const at = rest.findIndex((i) => i.key === key);
      if (at < 0) return list;
      const next = [...rest.slice(0, at + (after ? 1 : 0)), ...moving, ...rest.slice(at + (after ? 1 : 0))];
      return next.map((i) => i.key).join() === list.map((i) => i.key).join() ? list : next;
    });
  };

  const addFiles = async (files: FileList) => {
    setBusy('Opening…');
    try {
      for (const file of [...files]) {
        const opened = await editor.openPages(file);
        const index = extra.current.length;
        setSources((list) => [...list, { source: opened, bytes: opened.bytes, name: opened.name }]);
        extra.current = [...extra.current, { source: opened, bytes: opened.bytes, name: opened.name }];
        setItems((list) => [
          ...list,
          ...Array.from({ length: opened.pageCount }, (_, page) => ({ key: `${index}:${page}`, source: index, page, rotate: 0 })),
        ]);
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const others = () => sources.slice(1).map((s) => s.bytes!);
  const plan = (list: Item[]): ArrangedPage[] => list.map(({ source, page, rotate }) => ({ source, page, rotate }));

  const extract = async () => {
    setBusy('Preparing…');
    try {
      track('pages.extract');
      const bytes = await editor.arrangePages(plan(targets), others());
      const numbers = targets.map((t) => items.indexOf(t) + 1);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${fileName.replace(/\.pdf$/i, '')} (pages ${numbers.join(', ')}).pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const done = async () => {
    if (!changed) return onClose();
    setBusy('Applying…');
    try {
      track('pages.apply');
      await editor.applyPageArrangement(plan(items), others());
      onClose();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
      setBusy(null);
    }
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size) remove(selected);
      if (event.key === 'a' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSelected(new Set(items.map((i) => i.key)));
      }
      if (event.key === 'Escape') setSelected(new Set());
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  return (
    <>
      <div className="pages" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
        <input
          ref={addInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="pages__grid" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
          {items.map((item, index) => {
            const source = sources[item.source]!.source;
            const one = new Set([item.key]);
            return (
              <div
                key={item.key}
                className="page-card"
                data-selected={selected.has(item.key)}
                data-dragging={dragging === item.key}
                draggable
                onDragStart={(e) => {
                  setDragging(item.key);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => dragOver(e, item.key)}
                onDrop={(e) => e.preventDefault()}
                onClick={(e) => click(e, item.key)}
              >
                <Thumbnail source={source} page={item.page} rotate={item.rotate} />
                <div className="page-card__actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="pill pill--icon" aria-label="Rotate left" onClick={() => rotate(one, -90)}>
                    <Icon name="rotateLeft" size={16} />
                  </button>
                  <button type="button" className="pill pill--icon" aria-label="Rotate right" onClick={() => rotate(one, 90)}>
                    <Icon name="rotateRight" size={16} />
                  </button>
                  <button type="button" className="pill pill--icon" aria-label="Delete page" onClick={() => remove(one)}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
                <span className="page-card__number">
                  {index + 1}
                  {item.source > 0 && <em title={sources[item.source]!.name}> · {sources[item.source]!.name}</em>}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bottom-center">
        <nav className="bar" aria-label="Page tools">
          <div className="group">
            <button
              type="button"
              className="pill"
              onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.key)))}
            >
              {selected.size === items.length ? 'Select none' : 'Select all'}
            </button>
          </div>
          <div className="group">
            <button
              type="button"
              className="pill pill--icon"
              aria-label="Rotate selected left"
              disabled={!targets.length}
              onClick={() => rotate(selected, -90)}
            >
              <Icon name="rotateLeft" />
            </button>
            <button
              type="button"
              className="pill pill--icon"
              aria-label="Rotate selected right"
              disabled={!targets.length}
              onClick={() => rotate(selected, 90)}
            >
              <Icon name="rotateRight" />
            </button>
            <button
              type="button"
              className="pill pill--icon"
              aria-label="Delete selected"
              disabled={!targets.length}
              onClick={() => remove(selected)}
            >
              <Icon name="trash" />
            </button>
          </div>
          <div className="group">
            <button type="button" className="pill" disabled={!targets.length || !!busy} onClick={() => void extract()}>
              <Icon name="split" /> Extract
            </button>
            <button type="button" className="pill" disabled={!!busy} onClick={() => addInput.current?.click()}>
              <Icon name="merge" /> Add PDF
            </button>
          </div>
        </nav>
      </div>

      <div className="top-center pages__status">
        <div className="notice notice--plain">
          {busy ?? (
            <>
              <strong>{items.length} pages</strong>
              {selected.size ? ` · ${selected.size} selected` : ' · drag to reorder, click to select'}
            </>
          )}
        </div>
      </div>

      <div className="pages__done">
        <div className="bar">
          <button type="button" className="pill" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className="pill pill--ink" onClick={() => void done()} disabled={!!busy}>
            {changed ? 'Apply changes' : 'Done'}
          </button>
        </div>
      </div>
    </>
  );
}
