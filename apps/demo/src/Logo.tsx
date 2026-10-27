import { SITE } from './site';

/** The LovelyDoc mark: a page with a heart. The same drawing as public/favicon.svg. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#1b1b1d" />
      <path d="M21 13h15l10 10v26a3 3 0 0 1-3 3H21a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3z" fill="#fff" />
      <path d="M36 13v8a2 2 0 0 0 2 2h8" fill="#dcdcd8" />
      <path d="M24 31h15M24 37h9" stroke="#1b1b1d" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M44 54s-11-6.4-11-13.6a5.6 5.6 0 0 1 11-1.6 5.6 5.6 0 0 1 11 1.6C55 47.6 44 54 44 54z"
        fill="#ff4f6d"
        stroke="#1b1b1d"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The mark and the name, linking to the start page: the first item of a page's top bar. */
export function BrandLink({ href, current }: { href: string; current?: boolean }) {
  return (
    <a className="pill brand" href={href} aria-current={current ? 'page' : undefined}>
      <Logo />
      <span className="brand__name">{SITE.name}</span>
    </a>
  );
}
