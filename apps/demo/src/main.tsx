import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider, loadMessages, localeOfPath } from './i18n';
import { load } from './reload';
import { blogRouteOf } from './site';
import { track } from './telemetry';
import { applyTheme, initialTheme } from './theme';
import './styles.css';

const root = document.getElementById('root')!;
const path = location.pathname;
const blog = blogRouteOf(path);
// Every page says its language in the address, except the SDK's page, which is in English.
const locale = path === '/sdk' ? 'en' : localeOfPath(path);

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
  track(blog?.slug ? `view.blog.${blog.slug.slice(0, 32)}` : 'view.blog');
} else if (path === '/sdk') {
  // The SDK's page for developers, in English: its form needs the page to run.
  const SdkRoute = lazy(() => load(() => import('./Sdk')).then((m) => ({ default: m.SdkPage })));
  applyTheme(initialTheme());
  render(
    <Suspense fallback={null}>
      <SdkRoute />
    </Suspense>,
  );
} else if (blog) {
  const BlogRoute = lazy(() => load(() => import('./BlogRoute')));
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
