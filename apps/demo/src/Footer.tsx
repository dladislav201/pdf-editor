import { useI18n } from './i18n';
import { Logo } from './Logo';
import { LANDING_IDS, landingPath, SITE, type LandingId } from './site';

/** Links to every tool page (in the page's language) and the guides: how people and search engines find the rest. */
export function Footer({ current }: { current?: LandingId | 'blog' }) {
  const { locale, t } = useI18n();
  return (
    <footer className="footer">
      <nav aria-label={t.footer.allTools}>
        {LANDING_IDS.map((id) => (
          <a key={id} href={landingPath(id, locale)} aria-current={id === current ? 'page' : undefined}>
            {t.landings[id].name}
          </a>
        ))}
        {__GUIDES__ && (
          <a href="/blog" hrefLang="en" aria-current={current === 'blog' ? 'page' : undefined}>
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
