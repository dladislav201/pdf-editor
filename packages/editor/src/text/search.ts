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
 * A page's text as search sees it: per paragraph one string (word and line
 * gaps as single spaces) with each position's glyph box and line, packed in
 * typed arrays so the text of a long document stays small to keep around.
 */
export interface SearchIndex {
  pageIndex: number;
  paragraphs: {
    text: string;
    /** x, y, width, height per position of `text`; NaN for gaps. */
    boxes: Float32Array;
    /** The line of each position (-1 for gaps). */
    lines: Int16Array;
  }[];
}

export function indexPage(page: PageText): SearchIndex {
  return {
    pageIndex: page.pageIndex,
    paragraphs: page.paragraphs.map((paragraph) => {
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
      const boxes = new Float32Array(glyphs.length * 4).fill(Number.NaN);
      const lines = new Int16Array(glyphs.length).fill(-1);
      glyphs.forEach((glyph, i) => {
        if (!glyph) return;
        const { x, y, width, height } = glyph.char.box;
        boxes.set([x, y, width, height], i * 4);
        lines[i] = glyph.line;
      });
      return { text, boxes, lines };
    }),
  };
}

/**
 * Finds `query` in a page's text, paragraph by paragraph, so a phrase that
 * wraps onto the next line is found too. Runs of white space in the query
 * match a single word gap. Works on recognized (OCR) text the same way.
 */
export function searchPage(page: PageText, query: string, options: SearchOptions = {}): SearchMatch[] {
  return searchIndex(indexPage(page), query, options);
}

/** `searchPage` on a page indexed beforehand: what the engine worker keeps for repeated searches. */
export function searchIndex(index: SearchIndex, query: string, options: SearchOptions = {}): SearchMatch[] {
  const caseSensitive = options.caseSensitive ?? false;
  const needle = fold(query.trim().replace(/\s+/g, ' '), caseSensitive);
  if (!needle) return [];
  const matches: SearchMatch[] = [];
  for (const { text, boxes, lines } of index.paragraphs) {
    const haystack = fold(text, caseSensitive);
    // Folding can change lengths (rare ligatures); fall back to no match rather than wrong boxes.
    if (haystack.length !== text.length) continue;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      const byLine = new Map<number, Rect[]>();
      for (let i = at; i < at + needle.length; i++) {
        if (lines[i]! < 0) continue;
        const box = { x: boxes[i * 4]!, y: boxes[i * 4 + 1]!, width: boxes[i * 4 + 2]!, height: boxes[i * 4 + 3]! };
        byLine.set(lines[i]!, [...(byLine.get(lines[i]!) ?? []), box]);
      }
      matches.push({
        pageIndex: index.pageIndex,
        rects: [...byLine.values()].map(union),
        text: text.slice(at, at + needle.length),
      });
    }
  }
  return matches;
}
