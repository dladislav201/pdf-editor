// After `vite build` and the server build of src/entry-server.tsx: writes a
// static HTML file per page (start page, every tool page, 404) with its own
// title, description, canonical link, social preview tags and structured
// data, plus sitemap.xml and robots.txt. Run from apps/demo.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { LANDINGS, SITE, renderPage } = await import(pathToFileURL('dist-ssr/entry-server.js').href);
const template = readFileSync('dist/index.html', 'utf8');
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const url = (path) => SITE.url + path;
// Search results show about 60 characters: the name goes after the title only when it fits.
const fullTitle = (title) => (title.length + SITE.name.length + 3 <= 62 ? `${title} | ${SITE.name}` : title);

function head(page, { noindex = false } = {}) {
  const title = fullTitle(page.title);
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: page.path === '/' ? SITE.name : `${page.name} · ${SITE.name}`,
      url: url(page.path),
      description: page.description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Any (web browser)',
      browserRequirements: 'Requires JavaScript and WebAssembly',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  ];
  return [
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(page.description)}" />`,
    noindex ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${url(page.path)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escape(SITE.name)}" />`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(page.description)}" />`,
    `<meta property="og:url" content="${url(page.path)}" />`,
    `<meta property="og:image" content="${url('/og.png')}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    noindex ? '' : `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`,
  ]
    .filter(Boolean)
    .join('\n    ');
}

function html(page, options) {
  return template
    .replace(/<!--seo-->[\s\S]*<!--\/seo-->/, head(page, options))
    .replace('<!--app-->', renderPage(page));
}

// "/compress-pdf" is served from compress-pdf.html (Workers static assets drop the extension).
for (const page of LANDINGS) {
  writeFileSync(page.path === '/' ? 'dist/index.html' : `dist${page.path}.html`, html(page));
}
const home = LANDINGS[0];
writeFileSync(
  'dist/404.html',
  html({ ...home, title: 'Page not found', h1: 'This page doesn’t exist, but the editor does.' }, { noindex: true }),
);

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  'dist/sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${LANDINGS.map(
    (page) => `  <url><loc>${url(page.path)}</loc><lastmod>${today}</lastmod></url>`,
  ).join('\n')}\n</urlset>\n`,
);
writeFileSync('dist/robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url('/sitemap.xml')}\n`);

rmSync('dist-ssr', { recursive: true, force: true });
console.log(`prerendered ${LANDINGS.length} pages, 404, sitemap.xml and robots.txt`);
