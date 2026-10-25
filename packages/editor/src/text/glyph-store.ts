import fontkit from '@pdf-lib/fontkit';
import type { FontGlyphs } from '../engine/pdfium-glyphs';
import type { TextFont } from './types';

/**
 * Fallback fonts for characters a document's (usually subset) font lacks.
 * Metric-compatible with the fonts most documents use: Arimo ≈ Arial and
 * Helvetica, Tinos ≈ Times New Roman, Cousine ≈ Courier New. Ids are negative
 * so they never clash with engine font handles.
 */
const FAMILIES = { sans: 'Arimo', serif: 'Tinos', mono: 'Cousine' } as const;
const STYLES = ['Regular', 'Bold', 'Italic', 'BoldItalic'] as const;
export type FallbackFamily = keyof typeof FAMILIES;

const FALLBACKS = (Object.keys(FAMILIES) as FallbackFamily[]).flatMap((family) =>
  STYLES.map((style) => ({ family, style, file: `${FAMILIES[family]}-${style}.ttf` })),
);

/** Fallback ids are -1, -2, … in the order above; -1 is the regular sans. */
export const FALLBACK_FONT = -1;
/** Ids at or below this are fonts the editor provides itself (see `registerCustomFont`). */
export const CUSTOM_FONT_BASE = -1000;
export const isFallback = (font: number) => font < 0 && font > CUSTOM_FONT_BASE;
export const isCustomFont = (font: number) => font <= CUSTOM_FONT_BASE;
export const fallbackFile = (font: number): string => FALLBACKS[-font - 1]!.file;
/** Id of the fallback font of a family and style. */
export const fallbackId = (family: FallbackFamily, style: (typeof STYLES)[number]): number =>
  -(FALLBACKS.findIndex((f) => f.family === family && f.style === style) + 1);

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
/** Fetches a fallback font file by name (e.g. `Tinos-Regular.ttf`). */
export type LoadFallback = (file: string) => Promise<ArrayBuffer>;

/**
 * A font the editor makes up, e.g. the letters of a scanned page: advances
 * and metrics for layout. Characters it lacks come from `fallback`.
 */
export interface CustomFont extends FontMetrics {
  glyph(char: string): Glyph | null;
  fallback: number;
}

interface DocFont extends FontMetrics {
  source: FontSource;
  glyphs: Map<string, Glyph | null>;
}

interface FallbackFont extends FontMetrics {
  bytes: ArrayBuffer;
  glyph(char: string): Glyph | null;
}

/** Characters fetched up front for every font a paragraph uses, so typing rarely waits. */
const COMMON = Array.from(
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
    '«»–—‘’“”„…•€№ ' +
    'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюяЁЪЫЭёъыэ' +
    'ÀÁÂÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÖØÙÚÛÜßàáâäåæçèéêëìíîïñòóôöøùúûüÿ',
);

function parseFallback(bytes: ArrayBuffer): FallbackFont {
  const font = fontkit.create(new Uint8Array(bytes));
  const units = font.unitsPerEm;
  const cache = new Map<string, Glyph | null>();
  return {
    bytes,
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
 * engine (exact outlines of the embedded, often subset, font); characters they
 * lack come from the fallback font matching their family and style. Lookups
 * are synchronous; fonts not loaded yet resolve to `null` and `onChange`
 * fires once they arrive.
 */
export class GlyphStore {
  private readonly fonts = new Map<number, DocFont>();
  private readonly pending = new Map<number, Promise<void>>();
  private readonly infos = new Map<number, TextFont>();
  private readonly fallbacks = new Map<number, FallbackFont>();
  private readonly fallbackLoads = new Map<number, Promise<FallbackFont | null>>();
  private readonly listeners = new Set<() => void>();
  private readonly custom = new Map<number, CustomFont>();

  constructor(
    private readonly load: LoadGlyphs,
    private readonly loadFallback: LoadFallback | null,
  ) {}

  /** Adds (or replaces) a custom font under an id at or below `CUSTOM_FONT_BASE`. */
  registerCustomFont(id: number, font: CustomFont): void {
    if (!isCustomFont(id)) throw new Error(`Custom font ids start at ${CUSTOM_FONT_BASE}.`);
    this.custom.set(id, font);
  }

  /** Font descriptions from the page text model, used to pick fallbacks. */
  registerFonts(fonts: Record<number, TextFont>): void {
    for (const font of Object.values(fonts)) this.infos.set(font.id, font);
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

  /** The fallback that best matches a document font: same family class, weight and slant. */
  fallbackFor(font: number): number {
    if (isFallback(font)) return font;
    const custom = this.custom.get(font);
    if (custom) return custom.fallback;
    const info = this.infos.get(font);
    const family: FallbackFamily = info?.monospace ? 'mono' : info?.serif ? 'serif' : 'sans';
    const bold = (info?.weight ?? 400) >= 600;
    const italic = info?.italic ?? false;
    const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
    return fallbackId(family, style);
  }

  /** The glyph to draw `char` with: the document font if it has one, else its fallback. */
  resolve(font: number, char: string): { font: number; glyph: Glyph | null } {
    const custom = this.custom.get(font);
    if (custom) {
      const glyph = custom.glyph(char);
      if (glyph) return { font, glyph };
    } else if (!isFallback(font)) {
      const glyph = this.fonts.get(font)?.glyphs.get(char);
      if (glyph) return { font, glyph };
    }
    const fallback = this.fallbackFor(font);
    return { font: fallback, glyph: this.fallbackFont(fallback)?.glyph(char) ?? null };
  }

  /** True once the document font is loaded and `char` is known to be absent from it. */
  isMissing(font: number, char: string): boolean {
    return this.fonts.get(font)?.glyphs.get(char) === null;
  }

  metrics(font: number): FontMetrics {
    const loaded = this.custom.get(font) ?? (isFallback(font) ? this.fallbackFont(font) : this.fonts.get(font));
    return loaded ?? { ascent: 0.8, descent: -0.2 };
  }

  /** Advance of a character in points, as layout and drawing use it. */
  advance(style: { font: number; size: number }, char: string): number {
    if (char === '\n') return 0;
    return (this.resolve(style.font, char).glyph?.advance ?? 0.5) * style.size;
  }

  /** Loads a fallback font (if it isn't yet) and returns its file bytes, for embedding on save. */
  async fallbackBytes(font: number): Promise<ArrayBuffer | null> {
    this.fallbackFont(font);
    return (await this.fallbackLoads.get(font))?.bytes ?? null;
  }

  /** Called whenever a fallback font finishes loading (glyphs that were missing can now be drawn). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fallbackFont(font: number): FallbackFont | null {
    const loaded = this.fallbacks.get(font);
    if (loaded) return loaded;
    if (!this.fallbackLoads.has(font) && this.loadFallback) {
      const load = this.loadFallback(fallbackFile(font))
        .then((bytes) => {
          const parsed = parseFallback(bytes);
          this.fallbacks.set(font, parsed);
          for (const listener of [...this.listeners]) listener();
          return parsed;
        })
        .catch(() => null);
      this.fallbackLoads.set(font, load);
    }
    return null;
  }
}
