import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { track } from './telemetry';
import { applyTheme, initialTheme } from './theme';
import './styles.css';

const root = document.getElementById('root')!;
const path = location.pathname;
const isBlog = path === '/blog' || path.startsWith('/blog/');

if (root.dataset.static !== undefined) {
  // A built guide: plain HTML with links, nothing to run but the theme and the count.
  applyTheme(initialTheme());
  track(path === '/blog' ? 'view.blog' : `view.blog.${path.slice('/blog/'.length).slice(0, 32)}`);
} else if (isBlog) {
  const BlogRoute = lazy(() => import('./BlogRoute'));
  applyTheme(initialTheme());
  createRoot(root).render(
    <StrictMode>
      <Suspense fallback={null}>
        <BlogRoute path={path} />
      </Suspense>
    </StrictMode>,
  );
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
