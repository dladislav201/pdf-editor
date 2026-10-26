// Build-time rendering of the start page and every tool page to static HTML
// (see scripts/prerender.mjs), so search engines and link previews see the
// words without running the app.
import { renderToString } from 'react-dom/server';
import { Home } from './Home';
import type { Landing } from './site';

export { LANDINGS, SITE } from './site';

const nothing = () => undefined;

export function renderPage(page: Landing): string {
  return renderToString(
    <Home page={page} onOpen={nothing} onPictures={nothing} onSample={nothing} theme="light" onToggleTheme={nothing} />,
  );
}
