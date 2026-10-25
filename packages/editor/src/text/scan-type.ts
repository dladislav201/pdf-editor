import type { ScanPatch } from '../engine/pdfium-core';
import type { PageGeometry } from '../engine/page-geometry';
import type { InvisibleWord } from '../ocr/place';
import type { ScanFont, ScanGlyph, ScanStyle } from '../ocr/scan-font';
import type { PixelBox, Raster } from '../ocr/types';
import type { Point, Rect } from '../types';
import type { CustomFont, Glyph } from './glyph-store';
import type { ParagraphFrame, ParagraphLayout, StyledChar } from './layout';
import type { ScanErase } from './scan-edit';
import type { TextParagraph } from './types';
import type { TextWritePlan } from './write-plan';

/**
 * Editing recognized text in the scan's own letters. Words the user leaves
 * alone keep their pixels (moved along if the line reflows); new letters are
 * cut from elsewhere on the page. The result is a piece of scan, so the page
 * still looks like one scan, with an invisible text layer over it.
 */

/** The letters of one scanned page and how its OCR raster maps to the page. */
export interface PageScanFont {
  font: ScanFont;
  /** The page as it was rendered for OCR (pixels per point = `geometry.scale`). */
  geometry: PageGeometry;
  /** Skew the OCR raster was straightened by, in radians. */
  angle: number;
}

/**
 * The area the redrawn piece of scan covers: the old words, and room for the
 * text to grow: the paragraph's column, and two more lines below it.
 */
export function growErase(erase: ScanErase, frame: ParagraphFrame): ScanErase {
  const lines = frame.baselines ?? [frame.firstBaseline];
  const bottom = lines[lines.length - 1]! - 2 * frame.leading;
  const x0 = Math.min(erase.region.x, frame.x);
  const x1 = Math.max(erase.region.x + erase.region.width, frame.x + frame.width);
  const y0 = Math.min(erase.region.y, bottom);
  return { ...erase, region: { x: x0, y: y0, width: x1 - x0, height: erase.region.y + erase.region.height - y0 } };
}

/** Page user space → the straightened OCR raster the letters were cut from. */
export function toStraight(page: PageScanFont, point: Point): Point {
  const [x, y] = page.geometry.toViewport(point);
  const cx = page.geometry.width / 2;
  const cy = page.geometry.height / 2;
  const cos = Math.cos(-page.angle);
  const sin = Math.sin(-page.angle);
  return [cos * (x - cx) - sin * (y - cy) + cx, sin * (x - cx) + cos * (y - cy) + cy];
}

/** The scan's style for a paragraph: size in OCR pixels, weight, and the area whose letters come first. */
export function scanStyle(page: PageScanFont, paragraph: TextParagraph, bold: boolean): ScanStyle {
  const sizes = paragraph.lines.map((l) => l.size).sort((a, b) => a - b);
  const size = sizes[sizes.length >> 1]! * page.geometry.scale;
  const corners = [
    toStraight(page, [paragraph.box.x, paragraph.box.y]),
    toStraight(page, [paragraph.box.x + paragraph.box.width, paragraph.box.y + paragraph.box.height]),
  ];
  const near: PixelBox = {
    x0: Math.min(corners[0]![0], corners[1]![0]),
    y0: Math.min(corners[0]![1], corners[1]![1]),
    x1: Math.max(corners[0]![0], corners[1]![0]),
    y1: Math.max(corners[0]![1], corners[1]![1]),
  };
  return { size, bold, near };
}

/**
 * How much tighter or looser (pixels per letter) this paragraph is set than
 * the page's letters suggest: a table cell's digits often sit closer than
 * prose. Measured on its words: their width on the scan against the same
 * letters set from the samples.
 */
export function scanTracking(page: PageScanFont, style: ScanStyle, paragraph: TextParagraph): number {
  let scanned = 0;
  let set = 0;
  let gaps = 0;
  for (const line of paragraph.lines) {
    const starts = [...line.wordStarts, line.chars.length];
    for (let w = 0; w + 1 < starts.length; w++) {
      const glyphs = line.chars.slice(starts[w], starts[w + 1]);
      const first = glyphs[0];
      const last = glyphs[glyphs.length - 1];
      // Digits keep the page's own fixed pitch; words with them don't say how tight letters are.
      if (!first || !last || glyphs.length < 2 || glyphs.some((c) => /\d/.test(c.text))) continue;
      const placed = glyphs.map((c) => page.font.place(c.text, style));
      if (placed.some((p) => !p)) continue;
      const right = last.ink ? last.ink.x + last.ink.width : last.box.x + last.box.width;
      scanned += (right - first.x) * page.geometry.scale;
      set += placed.reduce((sum, p) => sum + p!.left + p!.glyph.width + p!.right, 0) - placed[0]!.left - placed[placed.length - 1]!.right;
      gaps += glyphs.length - 1;
    }
  }
  if (!gaps) return 0;
  const tracking = (scanned - set) / gaps;
  return Math.max(-0.1 * style.size, Math.min(0.1 * style.size, tracking));
}

/**
 * The scan's letters as a font for layout: advances (with the space each
 * letter keeps around it, plus the paragraph's `tracking`, in pixels) in ems.
 * Letters the page lacks go to `fallback`.
 */
export function scanCustomFont(page: PageScanFont, style: ScanStyle, fallback: number, tracking = 0): CustomFont {
  const cache = new Map<string, Glyph | null>();
  return {
    ascent: 0.9,
    descent: -0.22,
    fallback,
    glyph(char) {
      if (!cache.has(char)) {
        if (char === ' ') {
          cache.set(char, { advance: page.font.space(style) / style.size, path: '', unitsPerEm: 1 });
        } else {
          const placed = page.font.place(char, style);
          const advance = placed && placed.left + placed.glyph.width + placed.right + (/^\d$/.test(char) ? 0 : tracking);
          cache.set(char, placed && { advance: advance! / style.size, path: '', unitsPerEm: 1 });
        }
      }
      return cache.get(char)!;
    },
  };
}

/**
 * Characters of a recognized paragraph, in the scan font `font`. Each keeps
 * its place on the page (its advance is the distance to the next letter, a
 * word's last letter reaches to its end, a space to the next word), so an
 * untouched paragraph lays out exactly where it was.
 */
export function scanChars(paragraph: TextParagraph, font: number): StyledChar[] {
  const chars: StyledChar[] = [];
  paragraph.lines.forEach((line, lineIndex) => {
    const style = { font, size: line.size, color: line.chars[0]?.color ?? '#000000', rise: 0 };
    if (lineIndex > 0 && !paragraph.lines[lineIndex - 1]!.hyphenated && chars.length) chars.push({ char: ' ', style });
    line.chars.forEach((c, i) => {
      const next = line.chars[i + 1];
      const wordEnd = !next || line.wordStarts.includes(i + 1);
      // A word ends where its ink does; the space after it reaches to the next word.
      const right = c.ink ? c.ink.x + c.ink.width : c.box.x + c.box.width;
      const advance = wordEnd ? right - c.x : next.x - c.x;
      [...c.text].forEach((char, k) =>
        chars.push({
          char,
          style,
          ...(k === 0 ? { advance: Math.max(0, advance), source: { object: c.object, x: c.x, y: c.y, ownObject: false } } : { advance: 0 }),
        }),
      );
      if (next && wordEnd) chars.push({ char: ' ', style, advance: Math.max(0, next.x - right) });
    });
  });
  return chars;
}

/** How far a line rises per point to the right: the scan's skew, which new text follows. */
function slopeOf(line: TextParagraph['lines'][number]): number {
  const n = line.chars.length;
  if (n < 2) return 0;
  const mx = line.chars.reduce((s, c) => s + c.x, 0) / n;
  const my = line.chars.reduce((s, c) => s + c.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const c of line.chars) {
    sxy += (c.x - mx) * (c.y - my);
    sxx += (c.x - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

/** Above 1, the pale edge of a letter is pulled in: thinner, crisper strokes. */
const EDGE_GAMMA = 1.35;

/** Bilinear sample of a glyph's grey at a fractional pixel (paper outside it). */
function sample(glyph: ScanGlyph, x: number, y: number): number {
  if (x < -0.5 || y < -0.5 || x > glyph.width - 0.5 || y > glyph.height - 0.5) return 255;
  const x0 = Math.max(0, Math.min(glyph.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(glyph.height - 1, Math.floor(y)));
  const x1 = Math.min(glyph.width - 1, x0 + 1);
  const y1 = Math.min(glyph.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const at = (px: number, py: number) => glyph.pixels[py * glyph.width + px]!;
  return at(x0, y0) * (1 - fx) * (1 - fy) + at(x1, y0) * fx * (1 - fy) + at(x0, y1) * (1 - fx) * fy + at(x1, y1) * fx * fy;
}

export interface ComposeInput {
  page: PageScanFont;
  style: ScanStyle;
  /** The piece of scan under the paragraph, erased and as it was. */
  base: Pick<ScanPatch, 'image' | 'original' | 'origin' | 'xAxis' | 'yAxis'>;
  paragraph: TextParagraph;
  chars: StyledChar[];
  layout: ParagraphLayout;
  /** A glyph (OCR pixels, at `style.size`) for a letter the page lacks. */
  fallback: (char: string) => ScanGlyph | null;
}

/**
 * Draws an edited recognized paragraph into its piece of scan: untouched
 * words copied from the original pixels (moved if the text reflowed), new
 * letters from the page's own samples, along the scan's skew.
 */
export function composeScanParagraph(input: ComposeInput): Raster {
  const { page, style, base, paragraph, chars, layout } = input;
  const image: Raster = { width: base.image.width, height: base.image.height, rgba: new Uint8ClampedArray(base.image.rgba) };
  const { width: W, height: H } = image;
  // User space → patch pixels: p = origin + yAxis + u·xAxis/W − v·yAxis/H.
  const a = base.xAxis[0] / W;
  const b = base.xAxis[1] / W;
  const c = -base.yAxis[0] / H;
  const d = -base.yAxis[1] / H;
  const det = a * d - b * c;
  const ox = base.origin[0] + base.yAxis[0];
  const oy = base.origin[1] + base.yAxis[1];
  const toPatch = ([x, y]: Point): Point => [(d * (x - ox) - c * (y - oy)) / det, (-b * (x - ox) + a * (y - oy)) / det];
  const patchPerPoint = W / Math.hypot(...base.xAxis);
  const factor = patchPerPoint / page.geometry.scale;

  // Letters cut from the OCR raster went through one more resampling than the page's own
  // text, which leaves them a little soft and pale: match their darkest ink to the
  // paragraph's and tighten the soft edge.
  const inkOf = (pixels: ArrayLike<number>, step: number) => {
    const values: number[] = [];
    for (let i = 0; i < pixels.length; i += step) if (pixels[i]! < 200) values.push(pixels[i]!);
    values.sort((x, y) => x - y);
    return values.length ? values[Math.floor(values.length * 0.05)]! : 0;
  };
  let targetInk = 0;
  // Only letters scaled down to a coarser scan come out soft and need their edge pulled in.
  const gamma = factor < 0.9 ? EDGE_GAMMA : 1;
  const tone = (v: number, darkest: number) => {
    const t = Math.max(0, Math.min(1, (v - darkest) / Math.max(1, 255 - darkest)));
    return 255 - (255 - targetInk) * (1 - t ** gamma);
  };

  const darken = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    image.rgba[o] = Math.min(image.rgba[o]!, v);
    image.rgba[o + 1] = Math.min(image.rgba[o + 1]!, v);
    image.rgba[o + 2] = Math.min(image.rgba[o + 2]!, v);
  };

  // Which original line and word each page glyph belongs to.
  const lineOfObject = new Map<number, number>();
  const glyphsOfObject = new Map<number, number>();
  const boxOfObject = new Map<number, Rect>();
  paragraph.lines.forEach((line, i) => {
    for (const ch of line.chars) {
      lineOfObject.set(ch.object, i);
      glyphsOfObject.set(ch.object, (glyphsOfObject.get(ch.object) ?? 0) + 1);
      const box = boxOfObject.get(ch.object);
      const x0 = Math.min(box?.x ?? Infinity, ch.box.x);
      const y0 = Math.min(box?.y ?? Infinity, ch.box.y);
      const x1 = Math.max(box ? box.x + box.width : -Infinity, ch.box.x + ch.box.width);
      const y1 = Math.max(box ? box.y + box.height : -Infinity, ch.box.y + ch.box.height);
      boxOfObject.set(ch.object, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
  });
  const pad = (paragraph.lines[0]?.size ?? 10) * 0.15;
  const pixelBox = (box: Rect, by: number) => {
    const p0 = toPatch([box.x - by, box.y + box.height + by]);
    const p1 = toPatch([box.x + box.width + by, box.y - by]);
    return {
      x0: Math.max(0, Math.floor(Math.min(p0[0], p1[0]))),
      x1: Math.min(W, Math.ceil(Math.max(p0[0], p1[0]))),
      y0: Math.max(0, Math.floor(Math.min(p0[1], p1[1]))),
      y1: Math.min(H, Math.ceil(Math.max(p0[1], p1[1]))),
    };
  };
  // The ink of this paragraph's own words (not of bolder text that happens to be in the piece).
  const ownInk: number[] = [];
  for (const box of boxOfObject.values()) {
    const b = pixelBox(box, 0);
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) ownInk.push(base.original.rgba[(y * W + x) * 4]!);
  }
  targetInk = inkOf(ownInk, 1);

  const seen = new Map<string, number>();
  layout.lines.forEach((line, lineIndex) => {
    const original = paragraph.lines[Math.min(lineIndex, paragraph.lines.length - 1)]!;
    const slope = slopeOf(original);
    const lineStart = original.chars[0]?.x ?? line.left;
    const yAt = (x: number) => line.baseline + slope * (x - lineStart);
    // Words: runs of glyphs between spaces.
    const words: (typeof line.glyphs)[] = [];
    let current: typeof line.glyphs = [];
    for (const glyph of line.glyphs) {
      if (glyph.char === ' ' || glyph.char === '\n') {
        if (current.length) words.push(current);
        current = [];
      } else current.push(glyph);
    }
    if (current.length) words.push(current);

    for (const word of words) {
      const sources = word.map((g) => chars[g.index]?.source);
      const first = sources[0];
      // An untouched word: every glyph of one page word, in order, nothing added.
      const intact =
        first &&
        sources.every((s, i) => s && s.object === first.object && (i === 0 || s.x > sources[i - 1]!.x)) &&
        glyphsOfObject.get(first.object) === sources.length;
      if (intact) {
        const originalLine = paragraph.lines[lineOfObject.get(first.object)!]!;
        const dx = Math.round((word[0]!.x - first.x) * patchPerPoint);
        const dy = Math.round(-(line.baseline - originalLine.baseline) * patchPerPoint);
        const { x0, x1, y0, y1 } = pixelBox(boxOfObject.get(first.object)!, pad);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const o = (y * W + x) * 4;
            const v = Math.min(base.original.rgba[o]!, base.original.rgba[o + 1]!, base.original.rgba[o + 2]!);
            if (dx === 0 && dy === 0) {
              // Not moved: put the original pixels back exactly.
              image.rgba[o] = base.original.rgba[o]!;
              image.rgba[o + 1] = base.original.rgba[o + 1]!;
              image.rgba[o + 2] = base.original.rgba[o + 2]!;
            } else darken(x + dx, y + dy, v);
          }
        }
        continue;
      }
      for (const placed of word) {
        const occurrence = seen.get(placed.char) ?? 0;
        seen.set(placed.char, occurrence + 1);
        const set = page.font.place(placed.char, style, occurrence);
        const glyph = set?.glyph ?? input.fallback(placed.char);
        if (!glyph) continue;
        const darkest = inkOf(glyph.pixels, 1);
        const left = (set?.left ?? 0) / page.geometry.scale;
        const x = placed.x + left;
        const [px, py] = toPatch([x, yAt(x)]);
        // Glyph pixels are OCR pixels; draw them at the patch's resolution.
        const gx0 = Math.floor(px);
        const gy0 = Math.floor(py + glyph.top * factor);
        const gw = Math.ceil(glyph.width * factor) + 1;
        const gh = Math.ceil(glyph.height * factor) + 1;
        for (let y = 0; y < gh; y++) {
          for (let x2 = 0; x2 < gw; x2++) {
            const v = sample(glyph, (gx0 + x2 - px) / factor, (gy0 + y - (py + glyph.top * factor)) / factor);
            if (v < 250) darken(gx0 + x2, gy0 + y, tone(v, darkest));
          }
        }
      }
    }
  });
  return image;
}

/** Invisible words over the composed text, so it can still be found and copied. */
export function scanInvisibleWords(
  paragraph: TextParagraph,
  chars: StyledChar[],
  layout: ParagraphLayout,
  bold: boolean,
): InvisibleWord[] {
  const words: InvisibleWord[] = [];
  layout.lines.forEach((line, lineIndex) => {
    const original = paragraph.lines[Math.min(lineIndex, paragraph.lines.length - 1)]!;
    const slope = slopeOf(original);
    const lineStart = original.chars[0]?.x ?? line.left;
    let run: typeof line.glyphs = [];
    const flush = () => {
      if (!run.length) return;
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const width = last.x + last.advance - first.x;
      const style = chars[first.index]!.style;
      const length = Math.hypot(1, slope);
      words.push({
        text: run.map((g) => g.char).join(''),
        size: style.size,
        bold,
        color: style.color,
        origin: [first.x, line.baseline + slope * (first.x - lineStart)],
        run: [width, width * slope],
        up: [-slope / length, 1 / length],
      });
      run = [];
    };
    for (const glyph of line.glyphs) {
      if (glyph.char === ' ' || glyph.char === '\n') flush();
      else run.push(glyph);
    }
    flush();
  });
  return words;
}

/** How an edited recognized paragraph goes into the PDF: its piece of scan, redrawn, and invisible text over it. */
export function scanWritePlan(
  paragraph: TextParagraph,
  chars: StyledChar[],
  layout: ParagraphLayout,
  patch: Omit<ScanPatch, 'original'>,
  bold: boolean,
): TextWritePlan {
  const objects = new Set(paragraph.lines.flatMap((l) => [...l.chars.map((c) => c.object), ...l.spaceObjects.map((s) => s.object)]));
  return {
    page: paragraph.pageIndex,
    remove: [...objects].filter((o) => o >= 0).sort((a, b) => a - b),
    moves: [],
    words: [],
    fallback: [],
    patch,
    invisible: scanInvisibleWords(paragraph, chars, layout, bold),
  };
}
