import { marked } from 'marked';
import { LOCALES, type Locale } from './i18n';
import { blogPath } from './site';

/**
 * Guides: Markdown files in content/blog/ (English) and content/blog/<locale>/
 * (the others), each starting with a block of `key: value` lines between
 * `---`. A guide in another language says which English one it `translates`,
 * so each links to the others. A post with `draft: true` shows while
 * developing but isn't published until the draft line goes.
 */
export interface Post {
  slug: string;
  locale: Locale;
  /** Its address, e.g. "/blog/sign-pdf-on-phone" or "/de/blog/pdf-unterschreiben-ohne-hochladen". */
  path: string;
  /** The English guide's slug: the same for a guide and its translations. */
  original: string;
  title: string;
  description: string;
  /** First published, YYYY-MM-DD. */
  date: string;
  /** The tool page the guide leads to, e.g. "/compress-pdf", and its name. */
  tool: string;
  toolName: string;
  draft: boolean;
  html: string;
}

const files = import.meta.glob<string>('../content/blog/**/*.md', { query: '?raw', import: 'default', eager: true });

function parse(path: string, raw: string): Post {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) throw new Error(`${path}: no front matter`);
  const meta: Record<string, string> = Object.fromEntries(
    match[1]!.split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  const folder = /content\/blog\/(?:([^/]+)\/)?[^/]+$/.exec(path)![1] ?? 'en';
  if (!(LOCALES as readonly string[]).includes(folder)) throw new Error(`${path}: ${folder} isn't one of the site's languages`);
  const locale = folder as Locale;
  for (const key of ['title', 'description', 'date', 'tool', 'toolName', ...(locale === 'en' ? [] : ['translates'])]) {
    if (!meta[key]) throw new Error(`${path}: no ${key}`);
  }
  const slug = path.replace(/^.*\/|\.md$/g, '');
  return {
    slug,
    locale,
    path: `${blogPath(locale)}/${slug}`,
    original: meta.translates ?? slug,
    title: meta.title!,
    description: meta.description!,
    date: meta.date!,
    tool: meta.tool!,
    toolName: meta.toolName!,
    draft: meta.draft === 'true',
    html: marked.parse(raw.slice(match[0].length), { async: false }),
  };
}

/** Every language's guides, newest first. */
export const POSTS: Post[] = Object.entries(files)
  .map(([path, raw]) => parse(path, raw))
  .sort((a, b) => b.date.localeCompare(a.date));

const DATE_LOCALES: Record<Locale, string> = { en: 'en-GB', de: 'de-DE', nb: 'nb-NO', sv: 'sv-SE', uk: 'uk-UA' };

export const formatDate = (date: string, locale: Locale = 'en') =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(DATE_LOCALES[locale], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
