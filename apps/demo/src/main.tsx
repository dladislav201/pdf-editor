import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider, loadMessages, localeOfPath } from './i18n';
import { track } from './telemetry';
import { applyTheme, initialTheme } from './theme';
import './styles.css';

const root = document.getElementById('root')!;
const path = location.pathname;
const isBlog = path === '/blog' || path.startsWith('/blog/');
// The guides are in English; everything else says its language in the address.
const locale = isBlog || path === '/sdk' ? 'en' : localeOfPath(path);

function render(children: ReactNode) {
  void loadMessages(locale).then((messages) =>
    createRoot(root).render(
      <StrictMode>
        <I18nProvider locale={locale} messages={messages}>
          {children}
        </I18nProvider>
      </StrictMode>,
    ),
  );
}

if (root.dataset.static !== undefined) {
  // A built guide: plain HTML with links, nothing to run but the theme and the count.
  applyTheme(initialTheme());
  track(path === '/blog' ? 'view.blog' : `view.blog.${path.slice('/blog/'.length).slice(0, 32)}`);
} else if (path === '/sdk') {
  // The SDK's page for developers, in English: its form needs the page to run.
  const SdkRoute = lazy(() => import('./Sdk').then((m) => ({ default: m.SdkPage })));
  applyTheme(initialTheme());
  render(
    <Suspense fallback={null}>
      <SdkRoute />
    </Suspense>,
  );
} else if (isBlog) {
  const BlogRoute = lazy(() => import('./BlogRoute'));
  applyTheme(initialTheme());
  render(
    <Suspense fallback={null}>
      <BlogRoute path={path} />
    </Suspense>,
  );
} else {
  document.documentElement.lang = locale;
  render(<App />);
}
