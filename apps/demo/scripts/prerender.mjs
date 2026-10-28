// After `vite build` and the server build of src/entry-server.tsx: writes a
// static HTML file per page — the start page and every tool page in every
// language, the guides (in English, some also in other languages), 404 — with its own language, title,
// description, canonical link, alternates in the other languages, social
// preview tags and structured data, plus sitemap.xml and robots.txt. Guides
// marked as drafts are left out unless DRAFTS=1. Run from apps/demo.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const { ALL_PAGES, LANDING_IDS, LOCALES, MESSAGES, POSTS, REGIONS, SDK_FAQ, SITE, blogPath, landingPath, renderPage, renderBlogIndex, renderPost, renderSdk } =
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

// Guides: static pages that don't start the app, in English and some also in
// other languages. A language without published guides has no guide pages.
const posts = POSTS.filter((post) => !post.draft || process.env.DRAFTS === '1');
for (const post of POSTS) {
  const tools = LANDING_IDS.map((id) => landingPath(id, post.locale));
  if (!tools.includes(post.tool)) throw new Error(`Guide ${post.path} leads to ${post.tool}, which isn't a tool page in its language.`);
  if (post.locale !== 'en' && !POSTS.some((p) => p.locale === 'en' && p.slug === post.original)) {
    throw new Error(`Guide ${post.path} translates ${post.original}, which isn't an English guide.`);
  }
}
const publisher = { '@type': 'Organization', name: SITE.name, url: SITE.url };
const guideLocales = LOCALES.filter((locale) => posts.some((post) => post.locale === locale));
/** Pages in other languages, by language; none unless English is one of them (it's the x-default). */
const alternatesBy = (entries) => (entries.length > 1 && entries.some(([l]) => l === 'en') ? Object.fromEntries(entries) : undefined);
const blogAlternates = alternatesBy(guideLocales.map((l) => [l, blogPath(l)]));
const translations = (post) => alternatesBy(posts.filter((p) => p.original === post.original).map((p) => [p.locale, p.path]));
for (const locale of guideLocales) {
  const list = posts.filter((post) => post.locale === locale);
  const words = MESSAGES[locale].blog;
  const page = { path: blogPath(locale), title: words.title, description: words.description };
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: `${SITE.name}: ${words.guides}`,
      url: url(page.path),
      inLanguage: locale,
      publisher,
      blogPost: list.map((post) => ({ '@type': 'BlogPosting', headline: post.title, url: url(post.path) })),
    },
  ];
  write(page.path, html(renderBlogIndex(list, locale), head(page, { locale, alternates: blogAlternates, data }), { locale, isStatic: true }));
}
for (const post of posts) {
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: post.title,
      description: post.description,
      inLanguage: post.locale,
      datePublished: post.date,
      dateModified: post.date,
      url: url(post.path),
      mainEntityOfPage: url(post.path),
      image: url('/og.png'),
      author: publisher,
      publisher,
    },
  ];
  const page = { path: post.path, title: post.title, description: post.description };
  const options = { locale: post.locale, alternates: translations(post), article: true, data };
  write(post.path, html(renderPost(post), head(page, options), { locale: post.locale, isStatic: true }));
}

// The SDK's page for developers (English; its trial form runs, so it isn't a static page).
{
  const page = {
    path: '/sdk',
    title: 'PDF SDK for web apps: view, annotate and edit PDFs in the browser',
    description:
      'Add a PDF editor to your web app: real text editing, OCR, annotations, forms, signatures and pages, all in the browser with no server. Free 30-day trial key.',
  };
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: `${SITE.name} PDF SDK`,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web browser',
      url: url('/sdk'),
      offers: { '@type': 'Offer', price: '990', priceCurrency: 'USD' },
      publisher,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: SDK_FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  ];
  write('/sdk', html(renderSdk(), head(page, { data })));
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
    entry('/sdk'),
    ...guideLocales.map((l) => entry(blogPath(l), posts.find((post) => post.locale === l).date, blogAlternates)),
    ...posts.map((post) => entry(post.path, post.date, translations(post))),
    '</urlset>',
    '',
  ].join('\n'),
);
writeFileSync('dist/robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url('/sitemap.xml')}\n`);

rmSync('dist-ssr', { recursive: true, force: true });
console.log(`prerendered ${ALL_PAGES.length} pages in ${LOCALES.length} languages, ${posts.length} guides in ${guideLocales.join(', ')}, 404, sitemap.xml and robots.txt`);
