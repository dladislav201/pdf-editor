import { isFallback, type GlyphStore } from './glyph-store';
import type { ParagraphLayout, PlacedGlyph, StyledChar } from './layout';
import type { ScanErase } from './scan-edit';
import type { TextParagraph } from './types';

/** A word written with a document font, by the engine. */
export interface PlannedWord {
  text: string;
  /** A text object on the page that uses the font to write with. */
  fontObject: number;
  size: number;
  color: string;
  /** Baseline origin in PDF user space. */
  x: number;
  y: number;
}

/** A word in a fallback font, embedded subset (HarfBuzz) by the engine. */
export interface PlannedFallbackWord {
  text: string;
  /** Fallback font id (negative), see `fallbackFile`. */
  font: number;
  size: number;
  color: string;
  x: number;
  y: number;
}

/** How to turn the page's version of a paragraph into the edited one. Plain data. */
export interface TextWritePlan {
  page: number;
  /** Page objects to delete: the paragraph's text objects that aren't reused. */
  remove: number[];
  /** Original single-glyph objects kept as they are and moved to their new place. */
  moves: { object: number; dx: number; dy: number }[];
  words: PlannedWord[];
  fallback: PlannedFallbackWord[];
  /** For recognized text: its words are erased from the scan underneath first. */
  erase?: ScanErase;
}

const isBlank = (char: string) => char === ' ' || char === ' ' || char === '\t' || char === '\n';

/**
 * Compares the laid out paragraph with the page and plans the fewest changes:
 * a glyph that still exists keeps its own page object, just moved (so text
 * that didn't change stays byte-for-byte the same glyphs, kerning included);
 * new or retyped text becomes new words in the same font, or in the fallback
 * font where the document's subset lacks a character.
 */
export function buildWritePlan(
  paragraph: TextParagraph,
  chars: StyledChar[],
  layout: ParagraphLayout,
  store: GlyphStore,
): TextWritePlan {
  const fontObject = new Map<number, number>();
  for (const c of paragraph.lines.flatMap((l) => l.chars)) if (!fontObject.has(c.font)) fontObject.set(c.font, c.object);
  const objects = new Set(paragraph.lines.flatMap((l) => [...l.chars.map((c) => c.object), ...l.spaceObjects.map((s) => s.object)]));

  const plan: TextWritePlan = { page: paragraph.pageIndex, remove: [], moves: [], words: [], fallback: [] };
  const kept = new Set<number>();

  let pending: { glyphs: PlacedGlyph[]; font: number } | null = null;
  const flush = () => {
    if (!pending) return;
    const [first] = pending.glyphs;
    const text = pending.glyphs.map((g) => g.char).join('');
    const base = { text, size: first!.style.size, color: first!.style.color, x: first!.x, y: first!.y };
    if (isFallback(pending.font)) plan.fallback.push({ ...base, font: pending.font });
    else plan.words.push({ ...base, fontObject: fontObject.get(pending.font)! });
    pending = null;
  };

  for (const line of layout.lines) {
    for (const glyph of line.glyphs) {
      const char = chars[glyph.index];
      if (!char || isBlank(glyph.char)) {
        flush();
        continue;
      }
      const source = char.source;
      // A glyph redrawn in another font (its word needed the fallback) can't reuse its page object.
      const sameFont = glyph.style.font === char.style.font;
      if (source?.ownObject && sameFont && !kept.has(source.object)) {
        flush();
        kept.add(source.object);
        const dx = glyph.x - source.x;
        const dy = glyph.y - source.y;
        // Below 0.02 pt it's rounding in the layout, not a move: leave the glyph exactly where it was.
        if (Math.abs(dx) >= 0.02 || Math.abs(dy) >= 0.02) plan.moves.push({ object: source.object, dx, dy });
        continue;
      }
      const font = store.resolve(glyph.style.font, glyph.char).font;
      const same =
        pending &&
        pending.font === font &&
        pending.glyphs[0]!.style.size === glyph.style.size &&
        pending.glyphs[0]!.style.color === glyph.style.color &&
        pending.glyphs[0]!.y === glyph.y;
      if (!same) flush();
      pending ??= { glyphs: [], font };
      pending.glyphs.push(glyph);
    }
    flush();
  }

  // Invisible space glyphs (Chrome writes them as their own objects) still matter for
  // copy and search. Keep one when the glyphs on both sides stay together, moved
  // by the same amount; otherwise it would end up inside a reflowed word.
  const shift = new Map<number, { dx: number; dy: number }>();
  for (const object of kept) shift.set(object, { dx: 0, dy: 0 });
  for (const move of plan.moves) shift.set(move.object, { dx: move.dx, dy: move.dy });
  for (const line of paragraph.lines) {
    for (const space of line.spaceObjects) {
      const before = [...line.chars].reverse().find((c) => c.x < space.x);
      const after = line.chars.find((c) => c.x > space.x);
      const a = before && shift.get(before.object);
      const b = after && shift.get(after.object);
      if (!a || !b || Math.abs(a.dx - b.dx) > 0.5 || Math.abs(a.dy - b.dy) > 0.01) continue;
      kept.add(space.object);
      if (a.dx !== 0 || a.dy !== 0) plan.moves.push({ object: space.object, dx: a.dx, dy: a.dy });
    }
  }

  plan.remove = [...objects].filter((object) => !kept.has(object)).sort((a, b) => a - b);
  return plan;
}
