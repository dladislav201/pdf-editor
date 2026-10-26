import { useRef, useState, type DragEvent } from 'react';
import { FeedbackDialog } from './FeedbackDialog';
import type { ToolName } from '@pdfsdk/editor';
import { Icon, type IconName } from './icons';

export interface OpenRequest {
  file: File;
  /** Tool to start with, and whether to recognize scanned pages right away. */
  tool?: ToolName;
  recognize?: boolean;
  /** Open in the page view (organize pages). */
  pages?: boolean;
  /** Open the signature dialog right away. */
  sign?: boolean;
  /** Open a save dialog right away. */
  dialog?: 'compress' | 'images';
}

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
const isPicture = (f: File) => /^image\/(png|jpe?g|webp)$/.test(f.type);

const TOOLS: { icon: IconName; title: string; text: string; open?: Omit<OpenRequest, 'file'> }[] = [
  { icon: 'editText', title: 'Edit text', text: 'Change words and numbers in place, in the document’s own fonts.', open: { tool: 'editText' } },
  { icon: 'scan', title: 'Edit a scan', text: 'Recognize scanned pages, then edit them in the scan’s own letters.', open: { tool: 'editText', recognize: true } },
  { icon: 'highlight', title: 'Annotate', text: 'Highlight, draw, add shapes and notes.', open: { tool: 'highlight' } },
  { icon: 'form', title: 'Fill a form', text: 'Type into the fields, tick the boxes, pick from lists.', open: { tool: 'select' } },
  { icon: 'sign', title: 'Sign', text: 'Draw, type or upload your signature and place it.', open: { sign: true } },
  { icon: 'pages', title: 'Organize pages', text: 'Merge, split, rotate, delete and reorder.', open: { pages: true } },
  { icon: 'compress', title: 'Compress', text: 'Make a PDF smaller for email: scans and photos shrink, text stays sharp.', open: { dialog: 'compress' } },
  { icon: 'image', title: 'Convert', text: 'Turn photos into a PDF, or save every page as a picture.', open: { dialog: 'images' } },
];

export function Home({
  onOpen,
  onPictures,
  onSample,
  theme,
  onToggleTheme,
}: {
  onOpen: (request: OpenRequest) => void;
  /** Pictures (JPG, PNG, WebP) to turn into a PDF. */
  onPictures: (files: File[]) => void;
  onSample: (kind: 'contract' | 'scan' | 'form') => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<Omit<OpenRequest, 'file'>>({});
  const [over, setOver] = useState(false);
  const [feedback, setFeedback] = useState(false);

  const choose = (options: Omit<OpenRequest, 'file'> = {}) => {
    pending.current = options;
    input.current?.click();
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const files = [...event.dataTransfer.files];
    const file = files.find(isPdf);
    if (file) onOpen({ file });
    else if (files.some(isPicture)) onPictures(files.filter(isPicture));
  };

  return (
    <main className="home" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf,image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          const file = files.find(isPdf);
          if (file) onOpen({ file, ...pending.current });
          else if (files.some(isPicture)) onPictures(files.filter(isPicture));
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
        <div className="home__corner">
          <button type="button" className="float" onClick={() => setFeedback(true)} aria-label="Send feedback" title="Send feedback">
            <Icon name="feedback" />
          </button>
          <button type="button" className="float" onClick={onToggleTheme} aria-label="Switch theme">
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
          </button>
        </div>
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
        <p className="drop__hint">or drop it anywhere on this page — photos become a PDF</p>
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
          <button type="button" className="pill" onClick={() => onSample('form')}>
            A form
          </button>
        </div>
      </div>
      <p className="home__privacy">
        No sign-up, no uploads: files are opened and saved on your device. We only count which tools get used, with no cookies.
      </p>
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} />}
    </main>
  );
}
