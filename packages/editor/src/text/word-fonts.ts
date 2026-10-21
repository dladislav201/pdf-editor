import { isFallback, type GlyphStore } from './glyph-store';
import type { StyledChar } from './layout';

const isBlank = (char: string) => char === ' ' || char === '\u00a0' || char === '\t' || char === '\n';

/**
 * A word whose font lacks any of its characters is set entirely in the
 * fallback font: mixing two typefaces inside one word looks broken. Returns a
 * parallel array (same length and indices) with those words restyled; their
 * original glyph links and spacing are dropped, since they are redrawn.
 */
export function withWordFallback(chars: StyledChar[], store: GlyphStore): StyledChar[] {
  const out = chars.slice();
  let start = 0;
  while (start < chars.length) {
    if (isBlank(chars[start]!.char)) {
      start++;
      continue;
    }
    let end = start;
    while (end < chars.length && !isBlank(chars[end]!.char)) end++;
    const missing = chars
      .slice(start, end)
      .some(({ char, style }) => !isFallback(style.font) && store.isMissing(style.font, char));
    if (missing) {
      for (let i = start; i < end; i++) {
        const { char, style } = chars[i]!;
        out[i] = { char, style: { ...style, font: store.fallbackFor(style.font) } };
      }
    }
    start = end;
  }
  return out;
}
