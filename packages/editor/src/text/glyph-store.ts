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

export interface FontTraits {
  bold: boolean;
  italic: boolean;
}

const styleOf = (want: FontTraits) => (want.bold && want.italic ? 'BoldItalic' : want.bold ? 'Bold' : want.italic ? 'Italic' : 'Regular');

/**
 * A typeface text can be set in: a family of the page's document fonts
 * (`doc:<family>`), or one of the fallback families that come with the editor
 * (`sans`, `serif`, `mono`: Arimo, Tinos and Cousine).
 */
export interface FontFamily {
  id: string;
  name: string;
  kind: 'document' | 'standard';
}

const STANDARD: FontFamily[] = (Object.keys(FAMILIES) as FallbackFamily[]).map((family) => ({
  id: family,
  name: FAMILIES[family],
  kind: 'standard',
}));

/** A family's name to show: the font's family without subset prefix, style and `MT`/`PS` endings. */
const displayName = (family: string) =>
  family
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[-,]?(Bold|Italic|Oblique|Regular|Roman|Semibold|Medium)+$/i, '')
    .replace(/(MT|PS)$/, '')
    .trim();

/**
 * A font's family to compare by, from its PostScript name without the
 * subset prefix and the style: `ABCDEF+Arial-BoldMT` and `ArialMT` are one
 * family, as are `Times-Roman` and `Times-BoldItalic`.
 */
const familyKey = (name: string) =>
  name
    .replace(/^[A-Z]{6}\+/, '')
    .toLowerCase()
    .replace(/[\s_,-]/g, '')
    .replace(/bold|italic|oblique|regular|roman|semibold|demi|medium|book/g, '')
    .replace(/(mt|ps)+$/, '');

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

  /** Whether text in a font is bold and italic: from the description of a document font, from the style of a fallback. */
  traits(font: number): FontTraits {
    if (isFallback(font)) {
      const style = FALLBACKS[-font - 1]!.style;
      return { bold: style.startsWith('Bold'), italic: style.endsWith('Italic') };
    }
    const info = this.infos.get(font);
    return { bold: (info?.weight ?? 400) >= 600, italic: info?.italic ?? false };
  }

  /**
   * The font to set text of `font` in with another weight or slant: a font of
   * the same family among `available` (document fonts the page uses, so the
   * text keeps its typeface), else the fallback of its kind in that style.
   * Null for fonts the editor made up (a scan's letters): they have no styles.
   */
  variant(font: number, want: FontTraits, available: Iterable<number>): number | null {
    if (isCustomFont(font)) return null;
    const same = (a: FontTraits) => a.bold === want.bold && a.italic === want.italic;
    if (same(this.traits(font))) return font;
    const info = this.infos.get(font);
    if (info) {
      const family = familyKey(info.name);
      const match = [...available]
        .map((id) => this.infos.get(id))
        .find((other) => other && familyKey(other.name) === family && same(this.traits(other.id)));
      if (match) return match.id;
    }
    const kind: FallbackFamily = isFallback(font)
      ? FALLBACKS[-font - 1]!.family
      : info?.monospace
        ? 'mono'
        : info?.serif
          ? 'serif'
          : 'sans';
    return fallbackId(kind, styleOf(want));
  }

  /** The family a font belongs to (see `FontFamily`); null for fonts the editor made up (a scan's letters). */
  familyOf(font: number): string | null {
    if (isCustomFont(font)) return null;
    if (isFallback(font)) return FALLBACKS[-font - 1]!.family;
    const info = this.infos.get(font);
    return info ? `doc:${familyKey(info.name)}` : null;
  }

  /** The families text can be set in: those of `available` (the page's document fonts), then the standard ones. */
  families(available: Iterable<number>): FontFamily[] {
    const found = new Map<string, FontFamily>();
    for (const id of available) {
      const info = this.infos.get(id);
      const family = this.familyOf(id);
      if (!info || !family || found.has(family)) continue;
      // A font that isn't embedded is drawn with a stand-in, whose family is what the engine reports: its own name says what it is.
      const name = (info.embedded && displayName(info.family)) || displayName(info.name);
      found.set(family, { id: family, name, kind: 'document' });
    }
    return [...[...found.values()].sort((a, b) => a.name.localeCompare(b.name)), ...STANDARD];
  }

  /**
   * The font to set text in `family` with a weight and slant: the family's
   * document font in that style when the page has it, else the fallback of
   * its kind in that style (as `variant` does). Null for an unknown family.
   */
  familyFont(family: string, want: FontTraits, available: Iterable<number>): number | null {
    const standard = STANDARD.find((f) => f.id === family);
    if (standard) return fallbackId(standard.id as FallbackFamily, styleOf(want));
    const members = [...available].filter((id) => this.familyOf(id) === family);
    if (!members.length) return null;
    return this.variant(members[0]!, want, members);
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

  /** Whether a fallback font is still on its way (its glyphs resolve to null until it arrives). */
  isLoading(font: number): boolean {
    return isFallback(font) && !this.fallbacks.has(font) && this.fallbackLoads.has(font);
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
