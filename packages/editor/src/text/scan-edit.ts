import type { Rect } from '../types';
import type { StyledChar } from './layout';
import type { TextParagraph } from './types';

/** What to erase from a scan before an edited paragraph is drawn over it, in PDF user space. */
export interface ScanErase {
  /** The area that gets a cleaned copy of the scan. */
  region: Rect;
  /** Words whose ink is removed (padded a little). */
  words: Rect[];
  /** Pixels per point the area is rendered and stored at (the scan's own resolution). */
  scale: number;
  /** Typical text size, in points: rulings much longer than this are table borders, not letters. */
  size: number;
}

/** Around each word, for the anti-aliased edge and letters that stick out of their box. */
const WORD_PAD = 0.12;
/**
 * The cleaned copy covers just the words: its edges then run through paper,
 * not through table borders, which a viewer might resample a pixel apart.
 */
const REGION_PAD = 0.02;

const union = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};
const pad = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });

/**
 * Characters of a recognized (OCR) paragraph to edit. Nothing of the
 * invisible layer is kept: the text is set anew in the fallback font of its
 * weight (`fallbackFor`), at the size and colour measured on the scan.
 */
export function recognizedChars(paragraph: TextParagraph, fallbackFor: (font: number) => number): StyledChar[] {
  const chars: StyledChar[] = [];
  paragraph.lines.forEach((line, lineIndex) => {
    if (lineIndex > 0 && !paragraph.lines[lineIndex - 1]!.hyphenated && chars.length) {
      chars.push({ char: ' ', style: chars[chars.length - 1]!.style });
    }
    line.chars.forEach((c, i) => {
      const style = { font: fallbackFor(c.font), size: Math.round(c.size * 10) / 10, color: c.color, rise: 0 };
      if (i > 0 && line.wordStarts.includes(i)) chars.push({ char: ' ', style });
      for (const char of c.text) chars.push({ char, style });
    });
  });
  return chars;
}

/** The ink to erase for a recognized paragraph: its words, as the text layer places them. */
export function scanErase(paragraph: TextParagraph, scale: number): ScanErase {
  const sizes = paragraph.lines.map((l) => l.size).sort((a, b) => a - b);
  const size = sizes[sizes.length >> 1]!;
  const words: Rect[] = [];
  for (const line of paragraph.lines) {
    const starts = [...line.wordStarts, line.chars.length];
    for (let w = 0; w + 1 < starts.length; w++) {
      const glyphs = line.chars.slice(starts[w], starts[w + 1]);
      if (glyphs.length) words.push(pad(union(glyphs.map((c) => c.box)), size * WORD_PAD));
    }
  }
  return { region: pad(union(words), size * REGION_PAD), words, scale, size };
}
