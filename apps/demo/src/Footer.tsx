import { LANDINGS } from './site';

/** Links to every tool page and the guides, on every page: how people and search engines find the rest. */
export function Footer({ current }: { current?: string }) {
  return (
    <footer className="footer">
      <nav aria-label="All tools">
        {LANDINGS.map((landing) => (
          <a key={landing.path} href={landing.path} aria-current={landing.path === current ? 'page' : undefined}>
            {landing.name}
          </a>
        ))}
        {__GUIDES__ && (
          <a href="/blog" aria-current={current === '/blog' ? 'page' : undefined}>
            Guides
          </a>
        )}
      </nav>
      <p>No sign-up, no uploads: files are opened and saved on your device. We only count which tools get used, with no cookies.</p>
    </footer>
  );
}
