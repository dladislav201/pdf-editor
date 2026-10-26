import { marked } from 'marked';

/**
 * Guides: Markdown files in content/blog/, each starting with a block of
 * `key: value` lines between `---`. A post with `draft: true` shows while
 * developing but isn't published until the draft line goes.
 */
export interface Post {
  slug: string;
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

const files = import.meta.glob<string>('../content/blog/*.md', { query: '?raw', import: 'default', eager: true });

function parse(path: string, raw: string): Post {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) throw new Error(`${path}: no front matter`);
  const meta: Record<string, string> = Object.fromEntries(
    match[1]!.split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  for (const key of ['title', 'description', 'date', 'tool', 'toolName']) {
    if (!meta[key]) throw new Error(`${path}: no ${key}`);
  }
  return {
    slug: path.replace(/^.*\/|\.md$/g, ''),
    title: meta.title!,
    description: meta.description!,
    date: meta.date!,
    tool: meta.tool!,
    toolName: meta.toolName!,
    draft: meta.draft === 'true',
    html: marked.parse(raw.slice(match[0].length), { async: false }),
  };
}

/** Newest first. */
export const POSTS: Post[] = Object.entries(files)
  .map(([path, raw]) => parse(path, raw))
  .sort((a, b) => b.date.localeCompare(a.date));

export const formatDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
