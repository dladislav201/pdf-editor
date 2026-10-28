import { useEffect, useState, type FormEvent } from 'react';
import { Footer } from './Footer';
import { Icon, type IconName } from './icons';
import { BrandLink } from './Logo';
import { SITE } from './site';
import { track } from './telemetry';

/**
 * The SDK's page, for developers (English only): what the editor does in
 * someone else's web app, a few lines of code, what it costs, and a form
 * asking for a trial key, which is sent by hand (scripts/license.mjs).
 */

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'editText',
    title: 'Edit the text itself',
    text: 'Click a paragraph and type: lines rewrap in the document’s own fonts, bold, italic, size and typeface included, and what is below moves with it.',
  },
  { icon: 'scan', title: 'Edit scans', text: 'Built-in OCR in 5 languages, then edits drawn in the scan’s own letters. Searchable text on top.' },
  { icon: 'highlight', title: 'Annotate', text: 'Highlight, underline and strike out along the text, draw, add shapes, notes and signatures, saved as real PDF annotations.' },
  { icon: 'form', title: 'Fill forms', text: 'Text fields, checkboxes, radio buttons and lists, saved as values or flattened into the page.' },
  { icon: 'pages', title: 'Organize pages', text: 'Merge, split, rotate, delete and reorder with thumbnails.' },
  { icon: 'lock', title: 'Save as needed', text: 'Export with or without annotations, compress, save pages as pictures, protect with an AES-256 password.' },
  {
    icon: 'sparkle',
    title: 'Nothing leaves the browser',
    text: 'PDFium compiled to WebAssembly in a Web Worker. No server, no upload, works offline: your users’ documents stay on their devices.',
  },
  { icon: 'grid', title: 'Fits your stack', text: 'A framework-free core and a React component. Your own toolbar through the API, or ours. Typed events for everything.' },
];

const VANILLA = `import { PdfEditor } from '@pdfsdk/editor';

const editor = await PdfEditor.create({
  container: document.getElementById('viewer'),
  document: '/files/contract.pdf',
  licenseKey: 'pdfsdk1…',
});

editor.on('annotationsChange', ({ annotations }) => save(annotations));
const bytes = await editor.exportPdf({ password: 'optional' });`;

const REACT = `import { PdfEditor } from '@pdfsdk/react';

export function Viewer({ file }) {
  return (
    <PdfEditor
      document={file}
      licenseKey="pdfsdk1…"
      onAnnotationsChange={save}
    />
  );
}`;

/** Prices to start the conversation with, per year, every feature in every plan. Set by the owner. */
const PLANS = [
  { name: 'Starter', price: '$990', per: 'per year', points: ['1 production domain and its subdomains', 'Every feature and update', 'Email support'] },
  { name: 'Business', price: '$2,990', per: 'per year', points: ['Up to 5 production domains', 'Every feature and update', 'Priority support, help with your integration'] },
  { name: 'Enterprise', price: 'Let’s talk', per: '', points: ['Any number of domains', 'Invoices, security review, SLA', 'Custom features and terms'] },
];

export const SDK_FAQ = [
  {
    q: 'Do documents go to a server?',
    a: 'No. Rendering, editing, OCR and saving all run in the browser, in a Web Worker. There is no server to set up and nothing to send documents to.',
  },
  {
    q: 'What does the trial include?',
    a: 'Everything, for 30 days, on the domains you name (localhost always works). Without a key the editor runs too, with a watermark on the pages and in saved files.',
  },
  {
    q: 'How is it licensed?',
    a: 'Per production domain, yearly. The key is checked offline in the browser: no licence server, no calls home.',
  },
  {
    q: 'Which browsers?',
    a: 'Current Chrome, Edge, Firefox and Safari, on desktop and on phones. Every release is tested in all of them.',
  },
  { q: 'Can I try it first?', a: `Yes: ${SITE.url.replace('https://', '')} runs on the SDK. Open any PDF there and use it like your users would.` },
];

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function SdkPage() {
  const [tab, setTab] = useState<'js' | 'react'>('js');
  const [status, setStatus] = useState<Status>('idle');
  const [sentTo, setSentTo] = useState('');
  useEffect(() => {
    track('view.sdk');
    // From here on the page runs (its form works): tests wait for this, as for the app.
    document.documentElement.dataset.app = 'ready';
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    setStatus('sending');
    try {
      const response = await fetch('/api/trial', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(String(response.status));
      track('sdk.trial');
      setSentTo(body.email ?? '');
      setStatus('sent');
    } catch {
      setStatus('error');
    }
  };

  return (
    <main className="home sdk">
      <div className="home__top">
        <nav className="bar" aria-label="Sections">
          <div className="group">
            <BrandLink href="/" />
            <a className="pill" href="/sdk" aria-current="page">
              SDK
            </a>
          </div>
        </nav>
      </div>

      <section className="home__hero">
        <h1>A PDF editor for your web app.</h1>
        <p>View, annotate, fill, sign and really edit PDFs inside your product, right in the browser. Your customers’ documents never leave their devices.</p>
        <div className="sdk__actions">
          <a className="pill pill--ink" href="#trial" onClick={() => track('sdk.cta.trial')}>
            Get a trial key
          </a>
          <a className="pill" href="/" onClick={() => track('sdk.cta.demo')}>
            Try the live editor <Icon name="arrowRight" size={14} />
          </a>
        </div>
      </section>

      <section className="sdk__features" aria-label="What it does">
        {FEATURES.map((f) => (
          <div key={f.title} className="sdk__feature">
            <span className="tool__icon">
              <Icon name={f.icon} />
            </span>
            <strong>{f.title}</strong>
            <span>{f.text}</span>
          </div>
        ))}
      </section>

      <section className="sdk__section" aria-labelledby="code">
        <h2 id="code">A few lines to add</h2>
        <div className="group sdk__tabs" role="tablist">
          <button type="button" role="tab" className="pill" aria-selected={tab === 'js'} aria-pressed={tab === 'js'} onClick={() => setTab('js')}>
            JavaScript
          </button>
          <button type="button" role="tab" className="pill" aria-selected={tab === 'react'} aria-pressed={tab === 'react'} onClick={() => setTab('react')}>
            React
          </button>
        </div>
        <pre className="sdk__code">
          <code>{tab === 'js' ? VANILLA : REACT}</code>
        </pre>
      </section>

      <section className="sdk__section" aria-labelledby="pricing">
        <h2 id="pricing">Pricing</h2>
        <div className="sdk__plans">
          {PLANS.map((plan) => (
            <div key={plan.name} className="sdk__plan">
              <strong>{plan.name}</strong>
              <p className="sdk__price">
                {plan.price} <span>{plan.per}</span>
              </p>
              <ul>
                {plan.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="sdk__section" id="trial" aria-labelledby="trial-title">
        <h2 id="trial-title">Get a 30-day trial key</h2>
        {status === 'sent' ? (
          <p className="sdk__sent">Thanks! We’ll send your key to {sentTo} within one business day.</p>
        ) : (
          <form className="feedback sdk__form" onSubmit={(e) => void submit(e)}>
            <div className="sdk__row">
              <input name="name" required maxLength={100} placeholder="Your name" aria-label="Your name" autoComplete="name" />
              <input name="email" type="email" required maxLength={200} placeholder="Work email" aria-label="Work email" autoComplete="email" />
            </div>
            <div className="sdk__row">
              <input name="company" required maxLength={200} placeholder="Company" aria-label="Company" autoComplete="organization" />
              <input name="domains" required maxLength={600} placeholder="Domains, e.g. app.acme.com, *.acme.dev" aria-label="Domains the key should cover" />
            </div>
            <textarea name="message" maxLength={2000} placeholder="What are you building? (optional)" aria-label="What are you building?" />
            {/* People don't see this field; bots fill it in. */}
            <input className="feedback__trap" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
            {status === 'error' && <p className="dialog__error">That didn’t go through. Check the email and the domains, or write to us, and try again.</p>}
            <div className="sdk__submit">
              <p className="dialog__note">We use these details only to send your key and follow up about it.</p>
              <button type="submit" className="pill pill--ink" disabled={status === 'sending'}>
                {status === 'sending' ? 'Sending…' : 'Request a trial key'}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="explain" aria-labelledby="questions">
        <h2 id="questions">Questions</h2>
        <dl className="faq">
          {SDK_FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Footer current="sdk" />
    </main>
  );
}
