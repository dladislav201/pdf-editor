import { useI18n } from './i18n';
import { Logo } from './Logo';
import { blogPath, LANDING_IDS, landingPath, SITE, type LandingId } from './site';

/** Links to every tool page (in the page's language) and the guides: how people and search engines find the rest. */
export function Footer({ current }: { current?: LandingId | 'blog' | 'sdk' }) {
  const { locale, t } = useI18n();
  // The guides in this language, or else the English ones.
  const guides = __GUIDES__.includes(locale) ? locale : __GUIDES__.includes('en') ? 'en' : null;
  return (
    <footer className="footer">
      <nav aria-label={t.footer.allTools}>
        {LANDING_IDS.map((id) => (
          <a key={id} href={landingPath(id, locale)} aria-current={id === current ? 'page' : undefined}>
            {t.landings[id].name}
          </a>
        ))}
        <a href="/sdk" hrefLang="en" aria-current={current === 'sdk' ? 'page' : undefined}>
          {t.footer.sdk}
        </a>
        {guides && (
          <a href={blogPath(guides)} hrefLang={guides} aria-current={current === 'blog' ? 'page' : undefined}>
            {t.footer.guides}
          </a>
        )}
      </nav>
      <p className="footer__brand">
        <Logo size={20} />
        {SITE.name}
      </p>
      <p>{t.footer.privacy}</p>
    </footer>
  );
}
