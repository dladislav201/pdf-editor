import type { Rect } from '../types';
import type { PageText, TextChar } from './types';

/** One place the query was found: its page, a box per line it covers, and the text as written there. */
export interface SearchMatch {
  pageIndex: number;
  rects: Rect[];
  text: string;
}

export interface SearchOptions {
  /** Match upper and lower case exactly. Default false. */
  caseSensitive?: boolean;
}

const fold = (text: string, caseSensitive: boolean) => {
  const normal = text.normalize('NFKC');
  return caseSensitive ? normal : normal.toLocaleLowerCase();
};

function union(boxes: Rect[]): Rect {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

/**
 * Finds `query` in a page's text, paragraph by paragraph, so a phrase that
 * wraps onto the next line is found too. Runs of white space in the query
 * match a single word gap. Works on recognized (OCR) text the same way.
 */
export function searchPage(page: PageText, query: string, options: SearchOptions = {}): SearchMatch[] {
  const caseSensitive = options.caseSensitive ?? false;
  const needle = fold(query.trim().replace(/\s+/g, ' '), caseSensitive);
  if (!needle) return [];
  const matches: SearchMatch[] = [];
  for (const paragraph of page.paragraphs) {
    // The paragraph as one string, with each position's glyph (null for word gaps).
    let text = '';
    const glyphs: ({ char: TextChar; line: number } | null)[] = [];
    paragraph.lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) {
        text += ' ';
        glyphs.push(null);
      }
      line.chars.forEach((char, i) => {
        if (i > 0 && line.wordStarts.includes(i)) {
          text += ' ';
          glyphs.push(null);
        }
        for (const unit of char.text.split('')) {
          text += unit;
          glyphs.push({ char, line: lineIndex });
        }
      });
    });
    const haystack = fold(text, caseSensitive);
    // Folding can change lengths (rare ligatures); fall back to no match rather than wrong boxes.
    if (haystack.length !== text.length) continue;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      const hit = glyphs.slice(at, at + needle.length).filter((g): g is { char: TextChar; line: number } => g !== null);
      const byLine = new Map<number, Rect[]>();
      for (const { char, line } of hit) byLine.set(line, [...(byLine.get(line) ?? []), char.box]);
      matches.push({
        pageIndex: page.pageIndex,
        rects: [...byLine.values()].map(union),
        text: text.slice(at, at + needle.length),
      });
    }
  }
  return matches;
}
