import { useRef, useState, type DragEvent } from 'react';
import type { ToolName } from '@pdfsdk/editor';
import { Icon, type IconName } from './icons';

export interface OpenRequest {
  file: File;
  /** Tool to start with, and whether to recognize scanned pages right away. */
  tool?: ToolName;
  recognize?: boolean;
  /** Open in the page view (organize pages). */
  pages?: boolean;
}

const TOOLS: { icon: IconName; title: string; text: string; open?: Omit<OpenRequest, 'file'> }[] = [
  { icon: 'editText', title: 'Edit text', text: 'Change words and numbers in place, in the document’s own fonts.', open: { tool: 'editText' } },
  { icon: 'scan', title: 'Edit a scan', text: 'Recognize scanned pages, then edit them in the scan’s own letters.', open: { tool: 'editText', recognize: true } },
  { icon: 'highlight', title: 'Annotate', text: 'Highlight, draw, add shapes and notes.', open: { tool: 'highlight' } },
  { icon: 'sign', title: 'Sign', text: 'Draw or upload your signature.' },
  { icon: 'pages', title: 'Organize pages', text: 'Merge, split, rotate, delete and reorder.', open: { pages: true } },
];

export function Home({
  onOpen,
  onSample,
  theme,
  onToggleTheme,
}: {
  onOpen: (request: OpenRequest) => void;
  onSample: (kind: 'contract' | 'scan') => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<Omit<OpenRequest, 'file'>>({});
  const [over, setOver] = useState(false);

  const choose = (options: Omit<OpenRequest, 'file'> = {}) => {
    pending.current = options;
    input.current?.click();
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = [...event.dataTransfer.files].find((f) => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (file) onOpen({ file });
  };

  return (
    <main className="home" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onOpen({ file, ...pending.current });
          event.target.value = '';
        }}
      />
      <div className="home__top">
        <nav className="bar" aria-label="Sections">
          <div className="group">
            <button type="button" className="pill pill--icon" aria-pressed="true" aria-label="Home">
              <Icon name="home" />
            </button>
            <button type="button" className="pill" onClick={() => choose()}>
              <Icon name="file" /> Open PDF
            </button>
          </div>
        </nav>
        <button type="button" className="float home__theme" onClick={onToggleTheme} aria-label="Switch theme">
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
        </button>
      </div>

      <section className="home__hero">
        <h1>Edit any PDF, right in your browser.</h1>
        <p>Change text, fix scans, sign and mark up. Your files never leave your device.</p>
      </section>

      <div
        className="drop"
        data-over={over}
        onDragEnter={() => setOver(true)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
        }}
      >
        <div className="drop__icon">
          <Icon name="upload" size={22} />
        </div>
        <button type="button" className="pill pill--ink" onClick={() => choose()}>
          Choose a PDF
        </button>
        <p className="drop__hint">or drop it anywhere on this page</p>
        <span className="drop__privacy">
          <Icon name="lock" size={13} /> Processed on your device. Nothing is uploaded.
        </span>
      </div>

      <section className="tools" aria-label="Tools">
        {TOOLS.map((tool) => (
          <button key={tool.title} type="button" className="tool" disabled={!tool.open} onClick={() => tool.open && choose(tool.open)}>
            {!tool.open && <em className="tool__soon">Soon</em>}
            <span className="tool__icon">
              <Icon name={tool.icon} />
            </span>
            <strong>{tool.title}</strong>
            <span>{tool.text}</span>
          </button>
        ))}
      </section>

      <div className="samples">
        No PDF at hand? Try
        <div className="group">
          <button type="button" className="pill" onClick={() => onSample('contract')}>
            A contract
          </button>
          <button type="button" className="pill" onClick={() => onSample('scan')}>
            A scanned invoice
          </button>
        </div>
      </div>
    </main>
  );
}
