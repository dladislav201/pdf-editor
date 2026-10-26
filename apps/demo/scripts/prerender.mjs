// After `vite build` and the server build of src/entry-server.tsx: writes a
// static HTML file per page (start page, every tool page, the guides, 404)
// with its own title, description, canonical link, social preview tags and
// structured data, plus sitemap.xml and robots.txt. Guides marked as drafts
// are left out unless DRAFTS=1. Run from apps/demo.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { LANDINGS, POSTS, SITE, renderPage, renderBlogIndex, renderPost } = await import(pathToFileURL('dist-ssr/entry-server.js').href);
const template = readFileSync('dist/index.html', 'utf8');
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const url = (path) => SITE.url + path;
// Search results show about 60 characters: the name goes after the title only when it fits.
const fullTitle = (title) => (title.length + SITE.name.length + 3 <= 62 ? `${title} | ${SITE.name}` : title);

function head(page, { noindex = false, data: given } = {}) {
  const title = fullTitle(page.title);
  const data = given ?? [
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
    `<meta property="og:type" content="${page.article ? 'article' : 'website'}" />`,
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

function html(page, options, body = renderPage(page)) {
  return template
    .replace(/<!--seo-->[\s\S]*<!--\/seo-->/, head(page, options))
    .replace('<div id="root"><!--app-->', options?.static ? `<div id="root" data-static>${body}` : `<div id="root">${body}`);
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

// Guides: static pages that don't start the app. None published yet: no guide pages at all.
const posts = POSTS.filter((post) => !post.draft || process.env.DRAFTS === '1');
for (const post of POSTS) {
  if (!LANDINGS.some((page) => page.path === post.tool)) throw new Error(`Guide ${post.slug} leads to ${post.tool}, which isn't a tool page.`);
}
if (posts.length) mkdirSync('dist/blog', { recursive: true });
const publisher = { '@type': 'Organization', name: SITE.name, url: SITE.url };
if (posts.length) writeFileSync(
  'dist/blog.html',
  html(
    {
      path: '/blog',
      title: 'PDF guides: how to edit, sign, compress and fill PDFs',
      description: 'Step-by-step guides to everyday PDF jobs in your browser: editing scans, compressing, signing, filling forms.',
    },
    {
      static: true,
      data: [
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: `${SITE.name} guides`,
          url: url('/blog'),
          publisher,
          blogPost: posts.map((post) => ({ '@type': 'BlogPosting', headline: post.title, url: url(`/blog/${post.slug}`) })),
        },
      ],
    },
    renderBlogIndex(posts),
  ),
);
for (const post of posts) {
  const path = `/blog/${post.slug}`;
  writeFileSync(
    `dist${path}.html`,
    html(
      { path, title: post.title, description: post.description, article: true },
      {
        static: true,
        data: [
          {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: post.title,
            description: post.description,
            datePublished: post.date,
            dateModified: post.date,
            url: url(path),
            mainEntityOfPage: url(path),
            image: url('/og.png'),
            author: publisher,
            publisher,
          },
        ],
      },
      renderPost(post),
    ),
  );
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  'dist/sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    ...LANDINGS.map((page) => [page.path, today]),
    ...(posts.length ? [['/blog', posts[0].date]] : []),
    ...posts.map((post) => [`/blog/${post.slug}`, post.date]),
  ]
    .map(([path, date]) => `  <url><loc>${url(path)}</loc><lastmod>${date}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`,
);
writeFileSync('dist/robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${url('/sitemap.xml')}\n`);

rmSync('dist-ssr', { recursive: true, force: true });
console.log(`prerendered ${LANDINGS.length} pages, ${posts.length} guides, 404, sitemap.xml and robots.txt`);
