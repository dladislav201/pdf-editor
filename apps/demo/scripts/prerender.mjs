// After `vite build` and the server build of src/entry-server.tsx: writes a
// static HTML file per page — the start page and every tool page in every
// language, the guides (English), 404 — with its own language, title,
// description, canonical link, alternates in the other languages, social
// preview tags and structured data, plus sitemap.xml and robots.txt. Guides
// marked as drafts are left out unless DRAFTS=1. Run from apps/demo.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const { ALL_PAGES, LANDING_IDS, LOCALES, MESSAGES, POSTS, REGIONS, SITE, landingPath, renderPage, renderBlogIndex, renderPost } =
  await import(pathToFileURL('dist-ssr/entry-server.js').href);
const template = readFileSync('dist/index.html', 'utf8');
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const url = (path) => SITE.url + path;
// Search results show about 60 characters: the name goes after the title only when it fits.
const fullTitle = (title) => (title.length + SITE.name.length + 3 <= 62 ? `${title} | ${SITE.name}` : title);
const json = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

/** The head of a page: `page` has path, title, description; `alternates` maps languages to paths. */
function head(page, { locale = 'en', alternates, noindex = false, article = false, data = [] } = {}) {
  const title = fullTitle(page.title);
  return [
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(page.description)}" />`,
    noindex ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${url(page.path)}" />`,
    ...(alternates
      ? [
          ...Object.entries(alternates).map(([l, path]) => `<link rel="alternate" hreflang="${l}" href="${url(path)}" />`),
          `<link rel="alternate" hreflang="x-default" href="${url(alternates.en)}" />`,
        ]
      : []),
    `<meta property="og:type" content="${article ? 'article' : 'website'}" />`,
    `<meta property="og:site_name" content="${escape(SITE.name)}" />`,
    `<meta property="og:locale" content="${REGIONS[locale]}" />`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(page.description)}" />`,
    `<meta property="og:url" content="${url(page.path)}" />`,
    `<meta property="og:image" content="${url('/og.png')}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    ...(noindex ? [] : data.map(json)),
  ].join('\n    ');
}

function html(body, headHtml, { locale = 'en', isStatic = false } = {}) {
  return template
    .replace('<html lang="en">', `<html lang="${locale}">`)
    .replace(/<!--seo-->[\s\S]*<!--\/seo-->/, headHtml)
    .replace('<div id="root"><!--app-->', isStatic ? `<div id="root" data-static>${body}` : `<div id="root">${body}`);
}

function write(path, content) {
  // "/de/pdf-komprimieren" is served from de/pdf-komprimieren.html (Workers static assets drop the extension).
  const file = path === '/' ? 'dist/index.html' : `dist${path}.html`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const alternatesOf = (id) => Object.fromEntries(LOCALES.map((l) => [l, landingPath(id, l)]));

for (const { id, locale, path } of ALL_PAGES) {
  const text = MESSAGES[locale].landings[id];
  const page = { path, title: text.title, description: text.description };
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: id === 'home' ? SITE.name : `${text.name} · ${SITE.name}`,
      url: url(path),
      description: text.description,
      inLanguage: locale,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Any (web browser)',
      browserRequirements: 'Requires JavaScript and WebAssembly',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      inLanguage: locale,
      mainEntity: text.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  ];
  write(path, html(renderPage(id, locale), head(page, { locale, alternates: alternatesOf(id), data }), { locale }));
}

const notFound = MESSAGES.en.notFound;
writeFileSync(
  'dist/404.html',
  html(renderPage('home', 'en'), head({ path: '/', title: notFound.title, description: MESSAGES.en.landings.home.description }, { noindex: true })),
);

// Guides (English): static pages that don't start the app. None published yet: no guide pages at all.
const posts = POSTS.filter((post) => !post.draft || process.env.DRAFTS === '1');
const toolPaths = LANDING_IDS.map((id) => landingPath(id, 'en'));
for (const post of POSTS) {
  if (!toolPaths.includes(post.tool)) throw new Error(`Guide ${post.slug} leads to ${post.tool}, which isn't a tool page.`);
}
const publisher = { '@type': 'Organization', name: SITE.name, url: SITE.url };
if (posts.length) {
  const page = {
    path: '/blog',
    title: 'PDF guides: how to edit, sign, compress and fill PDFs',
    description: 'Step-by-step guides to everyday PDF jobs in your browser: editing scans, compressing, signing, filling forms.',
  };
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: `${SITE.name} guides`,
      url: url('/blog'),
      inLanguage: 'en',
      publisher,
      blogPost: posts.map((post) => ({ '@type': 'BlogPosting', headline: post.title, url: url(`/blog/${post.slug}`) })),
    },
  ];
  write('/blog', html(renderBlogIndex(posts), head(page, { data }), { isStatic: true }));
}
for (const post of posts) {
  const path = `/blog/${post.slug}`;
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: post.title,
      description: post.description,
      inLanguage: 'en',
      datePublished: post.date,
      dateModified: post.date,
      url: url(path),
      mainEntityOfPage: url(path),
      image: url('/og.png'),
      author: publisher,
      publisher,
    },
  ];
  write(path, html(renderPost(post), head({ path, title: post.title, description: post.description }, { article: true, data }), { isStatic: true }));
}

// The sitemap lists each page with its versions in the other languages (and
// x-default, as the pages do). Only guides have a date: a build's date would
// claim every tool page changed on every deploy.
const entry = (path, date, alternates) =>
  [
    '  <url>',
    `    <loc>${url(path)}</loc>`,
    ...(date ? [`    <lastmod>${date}</lastmod>`] : []),
    ...(alternates
      ? [...Object.entries(alternates), ['x-default', alternates.en]].map(
          ([l, p]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${url(p)}"/>`,
        )
      : []),
    '  </url>',
  ].join('\n');
writeFileSync(
  'dist/sitemap.xml',
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...ALL_PAGES.map(({ id, path }) => entry(path, undefined, alternatesOf(id))),
    ...(posts.length ? [entry('/blog', posts[0].date)] : []),
    ...posts.map((post) => entry(`/blog/${post.slug}`, post.date)),
    '</urlset>',
    '',
  ].join('\n'),
);
writeFileSync('dist/robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url('/sitemap.xml')}\n`);

rmSync('dist-ssr', { recursive: true, force: true });
console.log(`prerendered ${ALL_PAGES.length} pages in ${LOCALES.length} languages, ${posts.length} guides, 404, sitemap.xml and robots.txt`);
