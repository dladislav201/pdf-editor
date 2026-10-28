// Build-time rendering of the start page and every tool page in every
// language, and the guides in theirs, to static HTML (see scripts/prerender.mjs), so
// search engines and link previews see the words without running the app.
import { renderToString } from 'react-dom/server';
import { BlogIndex, BlogPost } from './Blog';
import { Home } from './Home';
import { SdkPage } from './Sdk';
export { SDK_FAQ } from './Sdk';
import { I18nProvider, type Locale, type Messages } from './i18n';
import { de } from './i18n/de';
import { en } from './i18n/en';
import { nb } from './i18n/nb';
import { sv } from './i18n/sv';
import { uk } from './i18n/uk';
import type { Post } from './posts';
import type { LandingId } from './site';

export { LOCALES, REGIONS } from './i18n';
export { POSTS } from './posts';
export { ALL_PAGES, blogPath, LANDING_IDS, landingPath, SITE } from './site';

export const MESSAGES: Record<Locale, Messages> = { en, de, nb, sv, uk };

const nothing = () => undefined;

export function renderPage(id: LandingId, locale: Locale): string {
  return renderToString(
    <I18nProvider locale={locale} messages={MESSAGES[locale]}>
      <Home id={id} onOpen={nothing} onPictures={nothing} onSample={nothing} theme="light" onToggleTheme={nothing} />
    </I18nProvider>,
  );
}

const inLocale = (locale: Locale, node: React.ReactNode) =>
  renderToString(
    <I18nProvider locale={locale} messages={MESSAGES[locale]}>
      {node}
    </I18nProvider>,
  );
export const renderBlogIndex = (posts: Post[], locale: Locale) => inLocale(locale, <BlogIndex posts={posts} />);
export const renderPost = (post: Post) => inLocale(post.locale, <BlogPost post={post} />);
export const renderSdk = () => inLocale('en', <SdkPage />);
