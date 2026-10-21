import fontkit from '@pdf-lib/fontkit';
import type { FontGlyphs } from '../engine/pdfium-glyphs';

/** Pseudo font id for characters drawn with the fallback font (`fontUrl`). */
export const FALLBACK_FONT = -1;

/** A drawable glyph: advance in ems, outline in its own units (y up). */
export interface Glyph {
  advance: number;
  path: string;
  /** Outline units per em: 1 for document fonts, e.g. 2048 for a TrueType fallback. */
  unitsPerEm: number;
}

export interface FontMetrics {
  /** Ems above and below the baseline (descent is negative). */
  ascent: number;
  descent: number;
}

/** Where to ask the engine for a document font: any text object that uses it. */
export interface FontSource {
  page: number;
  object: number;
}

type LoadGlyphs = (source: FontSource, chars: string[]) => Promise<FontGlyphs>;

interface DocFont extends FontMetrics {
  source: FontSource;
  glyphs: Map<string, Glyph | null>;
}

interface FallbackFont extends FontMetrics {
  glyph(char: string): Glyph | null;
}

/** Characters fetched up front for every font a paragraph uses, so typing rarely waits. */
const COMMON = Array.from(
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
    '«»–—‘’“”„…•€№ ' +
    'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюяЁЪЫЭёъыэ' +
    'ÀÁÂÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÖØÙÚÛÜßàáâäåæçèéêëìíîïñòóôöøùúûüÿ',
);

function loadFallback(bytes: ArrayBuffer): FallbackFont {
  const font = fontkit.create(new Uint8Array(bytes));
  const units = font.unitsPerEm;
  const cache = new Map<string, Glyph | null>();
  return {
    ascent: font.ascent / units,
    descent: font.descent / units,
    glyph(char) {
      if (!cache.has(char)) {
        const code = char.codePointAt(0)!;
        if (!font.hasGlyphForCodePoint(code)) {
          cache.set(char, null);
        } else {
          const glyph = font.glyphForCodePoint(code);
          cache.set(char, { advance: glyph.advanceWidth / units, path: glyph.path.toSVG(), unitsPerEm: units });
        }
      }
      return cache.get(char)!;
    },
  };
}

/**
 * Glyph outlines and advances for text editing. Document fonts come from the
 * engine (exact outlines of the embedded, often subset, font); anything they
 * lack comes from the fallback font. Lookups are synchronous once `ensure`d.
 */
export class GlyphStore {
  private readonly fonts = new Map<number, DocFont>();
  private readonly pending = new Map<number, Promise<void>>();
  private fallback: FallbackFont | null = null;

  constructor(
    private readonly load: LoadGlyphs,
    fallbackBytes: Promise<ArrayBuffer> | null,
  ) {
    void fallbackBytes?.then((bytes) => {
      this.fallback = loadFallback(bytes);
    });
  }

  /** Fetches `chars` (plus a common set the first time) for a document font. */
  async ensure(font: number, source: FontSource, chars: Iterable<string>): Promise<void> {
    await this.pending.get(font);
    const known = this.fonts.get(font);
    const wanted = [...new Set([...(known ? [] : COMMON), ...chars])].filter((c) => !known?.glyphs.has(c));
    if (!wanted.length) return;
    const request = this.load(known?.source ?? source, wanted).then((result) => {
      const entry = this.fonts.get(font) ?? {
        source,
        ascent: result.ascent,
        descent: result.descent,
        glyphs: new Map<string, Glyph | null>(),
      };
      for (const [char, glyph] of Object.entries(result.glyphs)) {
        entry.glyphs.set(char, glyph && { ...glyph, unitsPerEm: 1 });
      }
      this.fonts.set(font, entry);
    });
    this.pending.set(font, request.finally(() => this.pending.delete(font)));
    await request;
  }

  /** The glyph to draw `char` with in `font`: the document font if it has one, else the fallback. */
  resolve(font: number, char: string): { font: number; glyph: Glyph | null } {
    if (font !== FALLBACK_FONT) {
      const glyph = this.fonts.get(font)?.glyphs.get(char);
      if (glyph) return { font, glyph };
    }
    return { font: FALLBACK_FONT, glyph: this.fallback?.glyph(char) ?? null };
  }

  /** True once the document font is loaded and `char` is known to be absent from it. */
  isMissing(font: number, char: string): boolean {
    return this.fonts.get(font)?.glyphs.get(char) === null;
  }

  metrics(font: number): FontMetrics {
    if (font === FALLBACK_FONT) return this.fallback ?? { ascent: 0.8, descent: -0.2 };
    return this.fonts.get(font) ?? { ascent: 0.8, descent: -0.2 };
  }

  get hasFallback(): boolean {
    return this.fallback !== null;
  }
}
