import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ToolName } from '@pdfsdk/editor';
import { FeedbackDialog } from './FeedbackDialog';
import { Footer } from './Footer';
import { browserLocale, LANGUAGE_NAMES, LOCALES, SUGGEST, useI18n, type Locale, type Messages } from './i18n';
import { Icon, type IconName } from './icons';
import { BrandLink } from './Logo';
import { LANDING_TOOLS, landingPath, type LandingId } from './site';

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

const TOOLS: { icon: IconName; card: keyof Messages['cards']; open: Omit<OpenRequest, 'file'> }[] = [
  { icon: 'editText', card: 'editText', open: { tool: 'editText' } },
  { icon: 'scan', card: 'editScan', open: { tool: 'editText', recognize: true } },
  { icon: 'highlight', card: 'annotate', open: { tool: 'highlight' } },
  { icon: 'form', card: 'fillForm', open: { tool: 'select' } },
  { icon: 'sign', card: 'sign', open: { sign: true } },
  { icon: 'pages', card: 'pages', open: { pages: true } },
  { icon: 'compress', card: 'compress', open: { dialog: 'compress' } },
  { icon: 'image', card: 'convert', open: { dialog: 'images' } },
];

const SUGGEST_KEY = 'language-suggested';

/** The same page in the other languages. */
function LanguageMenu({ id }: { id: LandingId }) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="language">
      <button type="button" className="float" aria-label={t.home.language} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="globe" />
      </button>
      {open && (
        <div className="menu menu--languages" role="menu" onMouseLeave={() => setOpen(false)}>
          {LOCALES.map((l) => (
            <a key={l} role="menuitem" href={landingPath(id, l)} hrefLang={l} lang={l} aria-current={l === locale ? 'true' : undefined}>
              {LANGUAGE_NAMES[l]}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** On an English page, a quiet offer of the same page in the browser's language, once. */
function LanguageSuggestion({ id }: { id: LandingId }) {
  const { locale } = useI18n();
  const [offer, setOffer] = useState<Locale | null>(null);
  useEffect(() => {
    const preferred = browserLocale();
    let dismissed = false;
    try {
      dismissed = !!localStorage.getItem(SUGGEST_KEY);
    } catch {
      // Storage blocked: offer anyway.
    }
    if (locale === 'en' && preferred && preferred !== 'en' && !dismissed) setOffer(preferred);
  }, [locale]);
  if (!offer) return null;
  const dismiss = () => {
    setOffer(null);
    try {
      localStorage.setItem(SUGGEST_KEY, '1');
    } catch {
      // Not remembered; fine.
    }
  };
  return (
    <div className="notice language-offer" lang={offer}>
      <a href={landingPath(id, offer)} onClick={dismiss}>
        {SUGGEST[offer]} {LANGUAGE_NAMES[offer]} →
      </a>
      <button type="button" className="pill pill--icon" aria-label="×" onClick={dismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function Home({
  id,
  onOpen,
  onPictures,
  onSample,
  theme,
  onToggleTheme,
}: {
  /** The page people landed on: the start page or one tool's page. */
  id: LandingId;
  onOpen: (request: OpenRequest) => void;
  /** Pictures (JPG, PNG, WebP) to turn into a PDF. */
  onPictures: (files: File[]) => void;
  onSample: (kind: 'contract' | 'scan' | 'form') => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const { locale, t } = useI18n();
  const page = t.landings[id];
  const tool = LANDING_TOOLS[id];
  const input = useRef<HTMLInputElement>(null);
  // What the chooser opens files with: this page's tool unless a tool card was picked.
  const pending = useRef<Omit<OpenRequest, 'file'>>(tool.open ?? {});
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
    if (file) onOpen({ file, ...tool.open });
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
        <nav className="bar" aria-label={t.home.sections}>
          <div className="group">
            <BrandLink href={landingPath('home', locale)} current={id === 'home'} />
            {/* Phones have room for the name, and the big button below opens a PDF. */}
            <button type="button" className="pill wide-only" onClick={() => choose()}>
              <Icon name="file" />
              {t.home.openPdf}
            </button>
          </div>
        </nav>
        <div className="home__corner">
          <LanguageMenu id={id} />
          <button type="button" className="float" onClick={() => setFeedback(true)} aria-label={t.home.feedback} title={t.home.feedback}>
            <Icon name="feedback" />
          </button>
          <button type="button" className="float" onClick={onToggleTheme} aria-label={t.home.theme}>
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
          </button>
        </div>
      </div>
      <LanguageSuggestion id={id} />

      <section className="home__hero">
        <h1>{page.h1}</h1>
        <p>{page.lead}</p>
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
        <button type="button" className="pill pill--ink" onClick={() => choose(tool.open)}>
          {tool.pictures ? t.home.choosePictures : t.home.choosePdf}
        </button>
        <p className="drop__hint">{t.home.dropHint}</p>
        <span className="drop__privacy">
          <Icon name="lock" size={13} /> {t.home.privacy}
        </span>
      </div>

      <section className="tools" aria-label={t.home.tools}>
        {TOOLS.map(({ icon, card, open }) => (
          <button key={card} type="button" className="tool" onClick={() => choose(open)}>
            <span className="tool__icon">
              <Icon name={icon} />
            </span>
            <strong>{t.cards[card].title}</strong>
            <span>{t.cards[card].text}</span>
          </button>
        ))}
      </section>

      <div className="samples">
        {t.home.noPdf}
        <div className="group">
          <button type="button" className="pill" onClick={() => onSample('contract')}>
            {t.home.samples.contract}
          </button>
          <button type="button" className="pill" onClick={() => onSample('scan')}>
            {t.home.samples.scan}
          </button>
          <button type="button" className="pill" onClick={() => onSample('form')}>
            {t.home.samples.form}
          </button>
        </div>
      </div>
      <section className="explain" aria-labelledby="how">
        <h2 id="how">{t.home.how}</h2>
        <ol className="steps">
          {page.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <h2>{t.home.questions}</h2>
        <dl className="faq">
          {page.faq.map(({ q, a }) => (
            <div key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Footer current={id} />
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} />}
    </main>
  );
}
