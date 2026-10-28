import { lazy, Suspense, useEffect, useState } from 'react';
import scanDe from '../../../packages/editor/test/fixtures/scan-invoice-de.pdf?url';
import scanEn from '../../../packages/editor/test/fixtures/scan-invoice-en.pdf?url';
import scanNb from '../../../packages/editor/test/fixtures/scan-invoice-nb.pdf?url';
import scanSv from '../../../packages/editor/test/fixtures/scan-invoice-sv.pdf?url';
import scanUk from '../../../packages/editor/test/fixtures/scan-invoice.pdf?url';
import type { PageImage } from '@pdfsdk/editor';
import { Home, type OpenRequest } from './Home';
import { useI18n, type Locale } from './i18n';
import { ALIVE_EVERY, clearStale, forget, keepAlive, keepOpen, reopen } from './session';
import { routeOf } from './site';
import { track } from './telemetry';
import { applyTheme, initialTheme, type Theme } from './theme';

// The editor, PDFium and pdf-lib load when a file is opened, so the start page stays light.
const Workspace = lazy(() => import('./Workspace').then((m) => ({ default: m.Workspace })));

/** The scanned sample invoice in the page's language, so it's read with the language the page reads scans in. */
const SCAN_SAMPLES: Record<Locale, string> = { en: scanEn, de: scanDe, nb: scanNb, sv: scanSv, uk: scanUk };

/** Which start-page tool a file was opened with, for the usage counts. */
function openedWith(request: OpenRequest): string {
  if (request.tool) return `open.file.${request.tool}`;
  if (request.pages) return 'open.file.pages';
  if (request.sign) return 'open.file.sign';
  if (request.dialog) return `open.file.${request.dialog}`;
  return 'open.file';
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [open, setOpen] = useState<OpenRequest | null>(null);
  // A reload (or Back to it) while a file was open: it opens again (see session.ts) instead of the start page.
  // Going to the address afresh starts on the start page, though browsers keep the state for the same address.
  const [restoring, setRestoring] = useState(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const again = navigation?.type === 'reload' || navigation?.type === 'back_forward';
    return again && (window.history.state as { editing?: boolean } | null)?.editing === true;
  });
  useEffect(() => {
    if (!restoring) return;
    void reopen().then((request) => {
      if (request) setOpen(request);
      else window.history.replaceState(null, '');
      setRestoring(false);
      delete document.documentElement.dataset.restoring;
    });
  }, [restoring]);
  const { locale } = useI18n();
  // Every tool page is the start page with its own words; an unknown path shows the start page.
  const [id] = useState(() => routeOf(location.pathname)?.id ?? 'home');
  useEffect(() => track(`view.${id}.${locale}`), [id, locale]);

  useEffect(() => applyTheme(theme), [theme]);
  // From here on the page is the app, not the prerendered copy it replaced: tests wait for this.
  useEffect(() => {
    document.documentElement.dataset.app = 'ready';
  }, []);

  // Copies of files left by closed tabs go; this tab's copy is marked alive while it has a file open.
  useEffect(() => void clearStale(), []);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void keepAlive(), ALIVE_EVERY);
    return () => clearInterval(timer);
  }, [open]);

  // The browser's back button returns to the start page.
  useEffect(() => {
    const onPop = () => {
      setOpen(null);
      void forget();
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const show = (request: OpenRequest) => {
    window.history.pushState({ editing: true }, '');
    setOpen(request);
    void keepOpen(request);
  };

  const sample = async (kind: 'contract' | 'scan' | 'form') => {
    track(`open.sample.${kind}`);
    if (kind === 'form') {
      const { createSampleForm } = await import('./sample-form');
      const bytes = await createSampleForm();
      show({ file: new File([bytes as BlobPart], 'Membership application.pdf', { type: 'application/pdf' }) });
    } else if (kind === 'contract') {
      const { createSamplePdf } = await import('./sample-pdf');
      const bytes = await createSamplePdf();
      show({ file: new File([bytes as BlobPart], 'Services agreement.pdf', { type: 'application/pdf' }), tool: 'editText' });
    } else {
      const bytes = await (await fetch(SCAN_SAMPLES[locale])).arrayBuffer();
      show({ file: new File([bytes], 'Scanned invoice.pdf', { type: 'application/pdf' }), tool: 'editText' });
    }
  };

  /** Photos become a PDF (one page each), opened for editing. WebP goes through a canvas to PNG. */
  const pictures = async (files: File[]) => {
    track('open.pictures');
    const images: PageImage[] = [];
    for (const file of files) {
      if (file.type === 'image/jpeg') images.push({ bytes: new Uint8Array(await file.arrayBuffer()), type: 'jpeg' });
      else if (file.type === 'image/png') images.push({ bytes: new Uint8Array(await file.arrayBuffer()), type: 'png' });
      else {
        const bitmap = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png' });
      }
    }
    const { imagesToPdf } = await import('@pdfsdk/editor');
    const bytes = await imagesToPdf(images);
    const name = files.length === 1 ? `${files[0]!.name.replace(/\.[^.]+$/, '')}.pdf` : 'Pictures.pdf';
    show({ file: new File([bytes as BlobPart], name, { type: 'application/pdf' }), pages: files.length > 1 });
  };

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  if (restoring) return <div className="workspace" />;
  return open ? (
    <Suspense fallback={<div className="workspace" />}>
      <Workspace
        key={`${open.file.name}-${open.file.lastModified}`}
        file={open.file}
        tool={open.tool}
        recognize={open.recognize}
        pages={open.pages}
        sign={open.sign}
        dialog={open.dialog}
        theme={theme}
        onToggleTheme={toggleTheme}
        onClose={() => history.back()}
      />
    </Suspense>
  ) : (
    <Home
      id={id}
      onOpen={(request) => {
        track(openedWith(request));
        show(request);
      }}
      onPictures={(files) => void pictures(files)}
      onSample={(kind) => void sample(kind)}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
}
