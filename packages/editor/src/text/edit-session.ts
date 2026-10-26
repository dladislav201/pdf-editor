import { shortcutKey } from '../keys';
import type { PageView } from '../page-view';
import type { Point, Rect } from '../types';
import { FALLBACK_FONT, type GlyphStore } from './glyph-store';
import { withWordFallback } from './word-fonts';
import {
  layoutParagraph,
  type CharStyle,
  type Measure,
  type ParagraphFrame,
  type ParagraphLayout,
  type StyledChar,
} from './layout';
import type { TextParagraph } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Typing within this many ms of the previous keystroke joins the same undo step. */
const TYPING_MERGE_MS = 1000;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** The text block of the page, so single-line paragraphs (titles) can grow when edited. */
export interface TextBlock {
  left: number;
  right: number;
}

interface Snapshot {
  chars: StyledChar[];
  caret: number;
  anchor: number;
}

export interface TextEditCallbacks {
  /** The text or layout changed (also fires once the session opens). */
  onChange(session: TextEditSession): void;
  /** The user left the session (Escape). */
  onExit(): void;
  /**
   * Draws the text instead of the session (for a scan, as a piece of image
   * under the caret and selection). Called after every change of layout.
   */
  paint?(session: TextEditSession): void;
}

/**
 * Characters of a paragraph as the engine read them, with spaces at word gaps
 * and line joins. Each keeps its original spacing within its word and a link
 * to its page glyph, so untouched text keeps its exact positions.
 */
export function paragraphChars(paragraph: TextParagraph, measure?: Measure): StyledChar[] {
  const chars: StyledChar[] = [];
  const glyphsPerObject = new Map<number, number>();
  for (const c of paragraph.lines.flatMap((l) => l.chars)) glyphsPerObject.set(c.object, (glyphsPerObject.get(c.object) ?? 0) + 1);
  paragraph.lines.forEach((line, lineIndex) => {
    if (lineIndex > 0 && !paragraph.lines[lineIndex - 1]!.hyphenated && chars.length) {
      chars.push({ char: ' ', style: chars[chars.length - 1]!.style });
    }
    line.chars.forEach((c, i) => {
      const style: CharStyle = {
        font: c.font,
        size: Math.round(c.size * 100) / 100,
        color: c.color,
        rise: Math.round((c.y - line.baseline) * 100) / 100,
      };
      if (i > 0 && line.wordStarts.includes(i)) {
        // Keep the page's space width where nothing stretches it (justified lines get
        // theirs from layout): whatever is left between the previous word, set with
        // the font's advances, and this one.
        const stretched = paragraph.align === 'justify' && lineIndex < paragraph.lines.length - 1;
        const prev = line.chars[i - 1]!;
        const prevStyle = chars[chars.length - 1]!.style;
        const gap = measure && !stretched ? c.x - prev.x - measure(prevStyle, prev.text) : 0;
        chars.push({ char: ' ', style: { ...style, rise: 0 }, ...(gap > 0 ? { advance: gap } : {}) });
      }
      const next = line.chars[i + 1];
      const sameWord = next && !line.wordStarts.includes(i + 1);
      [...c.text].forEach((char, k) => {
        const first = k === 0;
        chars.push({
          char,
          style,
          // Within a word: the distance to the next glyph, kerning included. A word's last
          // glyph takes the font's advance, like the producer did; the space absorbs the rest.
          // Ligatures read as several characters from one glyph: only the first carries the glyph.
          ...(first && sameWord && c.text.length === 1 ? { advance: next.x - c.x } : {}),
          ...(first ? { source: { object: c.object, x: c.x, y: c.y, ownObject: glyphsPerObject.get(c.object) === 1 } } : {}),
        });
      });
    });
  });
  return chars;
}

/** Column the paragraph is set in; single lines may use the page's text block to grow. */
export function paragraphFrame(paragraph: TextParagraph, block: TextBlock): ParagraphFrame {
  const lines = paragraph.lines;
  const body = lines.length > 1 ? lines.slice(1) : lines;
  let x = Math.min(...body.map((l) => l.box.x));
  let right = Math.max(...lines.map((l) => l.box.x + l.box.width));
  if (lines.length === 1) {
    if (paragraph.align === 'left' || paragraph.align === 'justify') right = Math.max(right, block.right);
    else if (paragraph.align === 'right') x = Math.min(x, block.left);
    else {
      const half = Math.max((x + right) / 2 - block.left, block.right - (x + right) / 2);
      const center = (x + right) / 2;
      x = center - half;
      right = center + half;
    }
  }
  return {
    x,
    width: right - x,
    firstBaseline: lines[0]!.baseline,
    baselines: lines.map((l) => l.baseline),
    leading: paragraph.leading,
    indent: paragraph.indent,
    align: paragraph.align,
  };
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/**
 * Editing one paragraph in place. Glyphs are drawn from the document's own
 * font outlines (and the fallback font for characters a subset lacks), so
 * what you see is what will be written. Input goes through a hidden textarea
 * to get IME, dead keys and the clipboard right.
 */
export class TextEditSession {
  readonly group: SVGGElement;
  private readonly selectionLayer: SVGGElement;
  private readonly glyphLayer: SVGGElement;
  private readonly caretEl: SVGLineElement;
  private readonly input: HTMLTextAreaElement;
  private readonly original: string;
  private chars: StyledChar[];
  private caretOffset: number;
  private anchor: number;
  private composing: string | null = null;
  private layoutCache: ParagraphLayout | null = null;
  private layoutChars: StyledChar[] = [];
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastTyping = 0;
  private background: SVGImageElement | null = null;
  /** Remembered x for repeated up/down moves. */
  private goalX: number | null = null;
  private dragging = false;
  private destroyed = false;
  /** Pointer events report no click count (`detail` is 0), so double/triple clicks are counted here. */
  private lastPress = { time: -Infinity, x: 0, y: 0, count: 0 };
  private readonly unsubscribe: () => void;

  constructor(
    readonly view: PageView,
    readonly paragraph: TextParagraph,
    private readonly frame: ParagraphFrame,
    private readonly store: GlyphStore,
    private readonly callbacks: TextEditCallbacks,
    initial: StyledChar[],
  ) {
    this.chars = initial;
    // Compare with the page, not with where this session started: reopening an
    // already edited paragraph and leaving it untouched keeps the edit.
    this.original = paragraphChars(paragraph)
      .map((c) => c.char)
      .join('');
    this.caretOffset = initial.length;
    this.anchor = initial.length;

    this.group = svg('g', { class: 'pdfsdk-text-edit' });
    this.selectionLayer = svg('g', { class: 'pdfsdk-text-edit__selection' });
    this.glyphLayer = svg('g');
    this.caretEl = svg('line', { class: 'pdfsdk-caret' });
    this.group.append(this.selectionLayer, this.glyphLayer, this.caretEl);
    view.textLayer.append(this.group);

    this.input = document.createElement('textarea');
    this.input.className = 'pdfsdk-text-input';
    this.input.setAttribute('aria-label', 'Edit paragraph text');
    this.input.autocapitalize = 'off';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    view.el.append(this.input);
    this.input.addEventListener('keydown', this.onKeyDown);
    this.input.addEventListener('beforeinput', this.onBeforeInput);
    this.input.addEventListener('compositionstart', this.onCompositionStart);
    this.input.addEventListener('compositionupdate', this.onCompositionUpdate);
    this.input.addEventListener('compositionend', this.onCompositionEnd);
    this.input.addEventListener('copy', this.onCopy);
    this.input.addEventListener('cut', this.onCut);
    this.input.addEventListener('paste', this.onPaste);

    // A fallback font arriving changes advances and outlines: lay out again.
    this.unsubscribe = store.onChange(() => this.refresh());
    this.render();
    this.focus();
  }

  // ------------------------------------------------------------- public

  get text(): string {
    return this.chars.map((c) => c.char).join('');
  }

  get changed(): boolean {
    return this.text !== this.original;
  }

  get styledChars(): StyledChar[] {
    return this.chars;
  }

  get layout(): ParagraphLayout {
    if (!this.layoutCache) {
      this.layoutChars = withWordFallback(this.displayChars(), this.store);
      this.layoutCache = layoutParagraph(this.layoutChars, this.frame, (style, char) => this.advance(style, char));
    }
    return this.layoutCache;
  }

  /** The characters `layout` was set from (with any text being composed by an IME); its glyph indices point here. */
  get laidOutChars(): StyledChar[] {
    void this.layout;
    return this.layoutChars;
  }

  /** Extent of the laid out text (its ink, not the whole column) in PDF user space. */
  get box(): Rect {
    const lines = this.layout.lines;
    const metrics = (line: (typeof lines)[number]) => {
      const sizes = line.glyphs.map((g) => g.style);
      const size = Math.max(...sizes.map((s) => s.size), this.chars[0]?.style.size ?? 10);
      const font = sizes[0]?.font ?? this.chars[0]?.style.font ?? FALLBACK_FONT;
      const { ascent, descent } = this.store.metrics(font);
      return { top: line.baseline + ascent * size, bottom: line.baseline + descent * size };
    };
    const top = metrics(lines[0]!).top;
    const bottom = metrics(lines[lines.length - 1]!).bottom;
    // The column of a single line reaches across the page's text block (so a title
    // can grow); a table cell's number shouldn't claim its whole row.
    const left = Math.min(...lines.map((l) => l.left));
    const right = Math.max(...lines.map((l) => l.right));
    return { x: left, y: bottom, width: right - left, height: top - bottom };
  }

  contains([x, y]: Point, pad = 4): boolean {
    const box = this.box;
    return x >= box.x - pad && x <= box.x + box.width + pad && y >= box.y - pad && y <= box.y + box.height + pad;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /**
   * An image drawn under the glyphs: for recognized text, the scan with the
   * paragraph's words erased, so the old words don't show through. `origin`
   * is its bottom-left corner, `xAxis` and `yAxis` its edges, in user space.
   */
  setBackground(image: { href: string; width: number; height: number; origin: Point; xAxis: Point; yAxis: Point }): void {
    if (this.destroyed) return;
    const { width: w, height: h, origin, xAxis, yAxis } = image;
    // Image rows run down from the top edge (origin + yAxis).
    const transform = `matrix(${xAxis[0] / w} ${xAxis[1] / w} ${-yAxis[0] / h} ${-yAxis[1] / h} ${origin[0] + yAxis[0]} ${origin[1] + yAxis[1]})`;
    const el = svg('image', { href: image.href, width: w, height: h, transform, preserveAspectRatio: 'none' });
    this.background?.remove();
    this.background = el;
    this.group.prepend(el);
  }

  /** Re-lays out after glyphs arrived or the zoom changed. */
  refresh(): void {
    this.layoutCache = null;
    this.render();
  }

  /** `clicks` overrides the counted click number (e.g. clicks that arrived before the session opened). */
  pointerDown(point: Point, event: PointerEvent, clicks?: number): void {
    const offset = this.layout.hit(point[0], point[1]);
    this.goalX = null;
    const last = this.lastPress;
    const repeat = event.timeStamp - last.time < 500 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 5;
    const count = clicks ?? (repeat ? last.count + 1 : 1);
    this.lastPress = { time: event.timeStamp, x: event.clientX, y: event.clientY, count };
    if (count === 2) {
      this.selectWord(offset);
    } else if (count >= 3) {
      this.anchor = 0;
      this.caretOffset = this.chars.length;
    } else {
      this.caretOffset = offset;
      if (!event.shiftKey) this.anchor = offset;
      this.dragging = true;
    }
    this.render();
    this.focus();
  }

  pointerMove(point: Point): void {
    if (!this.dragging) return;
    this.caretOffset = this.layout.hit(point[0], point[1]);
    this.render();
  }

  pointerUp(): void {
    this.dragging = false;
  }

  /** Draws the final glyphs without caret or selection, for a paragraph that was edited and left. */
  freeze(): void {
    this.dragging = false;
    this.selectionLayer.replaceChildren();
    this.caretEl.style.display = 'none';
    this.input.remove();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    this.group.remove();
    this.input.remove();
  }

  // ----------------------------------------------------------- editing

  private get selection(): [number, number] {
    return [Math.min(this.caretOffset, this.anchor), Math.max(this.caretOffset, this.anchor)];
  }

  private snapshot(): Snapshot {
    return { chars: this.chars, caret: this.caretOffset, anchor: this.anchor };
  }

  private pushUndo(kind: 'typing' | 'other'): void {
    const now = Date.now();
    if (kind === 'typing' && now - this.lastTyping < TYPING_MERGE_MS && this.undoStack.length) {
      this.lastTyping = now;
      return;
    }
    this.lastTyping = kind === 'typing' ? now : 0;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Style for newly typed text: that of the character before the caret, like a word processor. */
  private styleAt(offset: number): CharStyle {
    const before = this.chars[offset - 1];
    const after = this.chars[offset];
    const source = before && before.char !== '\n' ? before : (after ?? before);
    const style = source?.style ?? { font: FALLBACK_FONT, size: 11, color: '#000000', rise: 0 };
    return style;
  }

  private replace(from: number, to: number, text: string, kind: 'typing' | 'other'): void {
    const style = from < to ? this.chars[from]!.style : this.styleAt(from);
    const inserted = [...text].map((char) => ({ char, style: char === ' ' ? { ...style, rise: 0 } : style }));
    this.pushUndo(kind);
    this.chars = [...this.chars.slice(0, from), ...inserted, ...this.chars.slice(to)];
    this.caretOffset = this.anchor = from + inserted.length;
    this.goalX = null;
    this.changedContent(inserted);
  }

  private insert(text: string, kind: 'typing' | 'other' = 'typing'): void {
    const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
    if (!clean && this.selection[0] === this.selection[1]) return;
    const [from, to] = this.selection;
    this.replace(from, to, clean, kind);
  }

  private deleteRange(from: number, to: number): void {
    if (from === to) return;
    this.replace(Math.max(0, from), Math.min(this.chars.length, to), '', 'other');
  }

  private changedContent(inserted: StyledChar[]): void {
    this.layoutCache = null;
    this.render();
    // Characters the document font hasn't been asked about yet: fetch, then lay out again.
    const byFont = new Map<number, Set<string>>();
    for (const { char, style } of inserted) {
      if (style.font === FALLBACK_FONT) continue;
      const set = byFont.get(style.font) ?? new Set<string>();
      set.add(char);
      byFont.set(style.font, set);
    }
    for (const [font, chars] of byFont) {
      const source = this.fontSource(font);
      if (source) void this.store.ensure(font, source, chars).then(() => this.refresh()).catch(() => undefined);
    }
  }

  private fontSource(font: number) {
    const char = this.paragraph.lines.flatMap((l) => l.chars).find((c) => c.font === font);
    return char ? { page: this.paragraph.pageIndex, object: char.object } : null;
  }

  private restore(snapshot: Snapshot): void {
    this.chars = snapshot.chars;
    this.caretOffset = snapshot.caret;
    this.anchor = snapshot.anchor;
    this.layoutCache = null;
    this.render();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Puts different text in, as the editor's undo history does for a paragraph that was closed. */
  setChars(chars: StyledChar[]): void {
    this.undoStack = [];
    this.redoStack = [];
    this.restore({ chars, caret: chars.length, anchor: chars.length });
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  // ---------------------------------------------------------- movement

  private wordBoundary(offset: number, direction: -1 | 1): number {
    let i = offset;
    const at = (k: number) => this.chars[k]?.char ?? '';
    if (direction < 0) {
      while (i > 0 && !WORD_CHAR.test(at(i - 1))) i--;
      while (i > 0 && WORD_CHAR.test(at(i - 1))) i--;
    } else {
      while (i < this.chars.length && !WORD_CHAR.test(at(i))) i++;
      while (i < this.chars.length && WORD_CHAR.test(at(i))) i++;
    }
    return i;
  }

  private lineBoundary(offset: number, direction: -1 | 1): number {
    const line = this.layout.lines[this.layout.caret(offset).line]!;
    if (direction < 0) return line.start;
    let end = line.end;
    const isLast = line === this.layout.lines[this.layout.lines.length - 1];
    if (line.hardBreak || (!isLast && end > line.start)) end--;
    return end;
  }

  private selectWord(offset: number): void {
    // A separator between digits is part of the number: "4 779,50", "01.09.2026".
    const at = (i: number) => this.chars[i]?.char ?? '';
    const inWord = (i: number) => WORD_CHAR.test(at(i)) || (/^[.,]$/.test(at(i)) && /\p{N}/u.test(at(i - 1)) && /\p{N}/u.test(at(i + 1)));
    if (!inWord(offset) && !inWord(offset - 1)) {
      this.anchor = this.caretOffset = offset;
      return;
    }
    let start = offset;
    let end = offset;
    while (start > 0 && inWord(start - 1)) start--;
    while (end < this.chars.length && inWord(end)) end++;
    this.anchor = start;
    this.caretOffset = end;
  }

  private move(target: number, extend: boolean, keepGoal = false): void {
    this.caretOffset = Math.max(0, Math.min(this.chars.length, target));
    if (!extend) this.anchor = this.caretOffset;
    if (!keepGoal) this.goalX = null;
    this.render();
  }

  // ------------------------------------------------------------ events

  private onKeyDown = (event: KeyboardEvent): void => {
    // Keys handled here never reach the editor's own shortcuts.
    event.stopPropagation();
    if (event.isComposing) return;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const mod = mac ? event.metaKey : event.ctrlKey;
    const word = mac ? event.altKey : event.ctrlKey;
    const [from, to] = this.selection;
    const collapsed = from === to;
    const extend = event.shiftKey;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.callbacks.onExit();
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (!extend && !collapsed && !word && !mod) return this.move(from, false);
        return this.move(
          mod ? this.lineBoundary(this.caretOffset, -1) : word ? this.wordBoundary(this.caretOffset, -1) : this.caretOffset - 1,
          extend,
        );
      case 'ArrowRight':
        event.preventDefault();
        if (!extend && !collapsed && !word && !mod) return this.move(to, false);
        return this.move(
          mod ? this.lineBoundary(this.caretOffset, 1) : word ? this.wordBoundary(this.caretOffset, 1) : this.caretOffset + 1,
          extend,
        );
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        if (mod) return this.move(direction < 0 ? 0 : this.chars.length, extend);
        this.goalX ??= this.layout.caret(this.caretOffset).x;
        return this.move(this.layout.vertical(this.caretOffset, direction, this.goalX), extend, true);
      }
      case 'Home':
        event.preventDefault();
        return this.move(mod ? 0 : this.lineBoundary(this.caretOffset, -1), extend);
      case 'End':
        event.preventDefault();
        return this.move(mod ? this.chars.length : this.lineBoundary(this.caretOffset, 1), extend);
      case 'Tab':
        event.preventDefault();
        return;
    }
    const key = shortcutKey(event);
    if (mod && key === 'a') {
      event.preventDefault();
      this.anchor = 0;
      this.move(this.chars.length, true);
    } else if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    } else if (mod && key === 'y' && !mac) {
      event.preventDefault();
      this.redo();
    }
  };

  private onBeforeInput = (event: InputEvent): void => {
    // Composition is handled by its own events; its input events can't be cancelled.
    if (event.inputType === 'insertCompositionText') return;
    event.preventDefault();
    const [from, to] = this.selection;
    const collapsed = from === to;
    switch (event.inputType) {
      case 'insertText':
      case 'insertReplacementText':
        this.insert(event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        this.insert('\n', 'other');
        break;
      case 'deleteContentBackward':
        if (collapsed) this.deleteRange(this.caretOffset - 1, this.caretOffset);
        else this.deleteRange(from, to);
        break;
      case 'deleteContentForward':
        if (collapsed) this.deleteRange(this.caretOffset, this.caretOffset + 1);
        else this.deleteRange(from, to);
        break;
      case 'deleteWordBackward':
        this.deleteRange(collapsed ? this.wordBoundary(this.caretOffset, -1) : from, collapsed ? this.caretOffset : to);
        break;
      case 'deleteWordForward':
        this.deleteRange(collapsed ? this.caretOffset : from, collapsed ? this.wordBoundary(this.caretOffset, 1) : to);
        break;
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
        this.deleteRange(collapsed ? this.lineBoundary(this.caretOffset, -1) : from, collapsed ? this.caretOffset : to);
        break;
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward':
        this.deleteRange(collapsed ? this.caretOffset : from, collapsed ? this.lineBoundary(this.caretOffset, 1) : to);
        break;
      case 'historyUndo':
        this.undo();
        break;
      case 'historyRedo':
        this.redo();
        break;
      default:
        return;
    }
  };

  private onCompositionStart = (): void => {
    this.composing = '';
  };

  private onCompositionUpdate = (event: CompositionEvent): void => {
    this.composing = event.data;
    this.layoutCache = null;
    this.render();
  };

  private onCompositionEnd = (event: CompositionEvent): void => {
    this.composing = null;
    this.input.value = '';
    if (event.data) this.insert(event.data);
    else this.refresh();
  };

  private onCopy = (event: ClipboardEvent): void => {
    const [from, to] = this.selection;
    if (from === to) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', this.text.slice(from, to));
  };

  private onCut = (event: ClipboardEvent): void => {
    const [from, to] = this.selection;
    if (from === to) return;
    this.onCopy(event);
    this.deleteRange(from, to);
  };

  private onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) this.insert(text, 'other');
  };

  // ----------------------------------------------------------- drawing

  /** Text with the in-progress IME composition shown at the caret. */
  private displayChars(): StyledChar[] {
    if (!this.composing) return this.chars;
    const [from, to] = this.selection;
    const style = this.styleAt(from);
    return [...this.chars.slice(0, from), ...[...this.composing].map((char) => ({ char, style })), ...this.chars.slice(to)];
  }

  private advance(style: CharStyle, char: string): number {
    return this.store.advance(style, char);
  }

  private render(): void {
    if (this.destroyed) return;
    const layout = this.layout;
    const glyphs: SVGElement[] = [];
    if (this.callbacks.paint) this.callbacks.paint(this);
    else for (const line of layout.lines) {
      for (const placed of line.glyphs) {
        if (placed.char === '\n' || placed.char === ' ') continue;
        const { glyph } = this.store.resolve(placed.style.font, placed.char);
        if (!glyph) {
          // Neither the document font nor the fallback has it: show a box, like a viewer would.
          glyphs.push(
            svg('rect', {
              x: placed.x + placed.advance * 0.1,
              y: placed.y,
              width: placed.advance * 0.8,
              height: placed.style.size * 0.7,
              fill: 'none',
              stroke: placed.style.color,
              'stroke-width': placed.style.size * 0.05,
            }),
          );
          continue;
        }
        if (!glyph.path) continue;
        const scale = placed.style.size / glyph.unitsPerEm;
        glyphs.push(
          svg('path', {
            d: glyph.path,
            fill: placed.style.color,
            transform: `matrix(${scale} 0 0 ${scale} ${placed.x} ${placed.y})`,
          }),
        );
      }
    }
    this.glyphLayer.replaceChildren(...glyphs);
    this.renderSelection(layout);
    this.renderCaret(layout);
    this.callbacks.onChange(this);
  }

  private lineMetrics(lineIndex: number, layout: ParagraphLayout): { top: number; bottom: number } {
    const line = layout.lines[lineIndex]!;
    const style = line.glyphs[0]?.style ?? this.styleAt(line.start);
    const size = Math.max(style.size, ...line.glyphs.map((g) => g.style.size));
    const { ascent, descent } = this.store.metrics(style.font);
    return { top: line.baseline + ascent * size, bottom: line.baseline + descent * size };
  }

  private renderSelection(layout: ParagraphLayout): void {
    const [from, to] = this.selection;
    if (from === to || this.composing !== null) {
      this.selectionLayer.replaceChildren();
      return;
    }
    const rects: SVGElement[] = [];
    layout.lines.forEach((line, i) => {
      const start = Math.max(from, line.start);
      const end = Math.min(to, line.end);
      if (start >= end) return;
      const x0 = layout.caret(start).line === i ? layout.caret(start).x : line.left;
      const x1 = end === line.end ? Math.max(line.right, x0) : layout.caret(end).x;
      const { top, bottom } = this.lineMetrics(i, layout);
      rects.push(svg('rect', { x: x0, y: bottom, width: Math.max(x1 - x0, 0.5), height: top - bottom }));
    });
    this.selectionLayer.replaceChildren(...rects);
  }

  private renderCaret(layout: ParagraphLayout): void {
    const offset = this.composing !== null ? this.selection[0] + [...this.composing].length : this.caretOffset;
    const { line, x } = layout.caret(offset);
    const { top, bottom } = this.lineMetrics(line, layout);
    const collapsed = this.selection[0] === this.selection[1];
    this.caretEl.setAttribute('x1', String(x));
    this.caretEl.setAttribute('x2', String(x));
    this.caretEl.setAttribute('y1', String(bottom));
    this.caretEl.setAttribute('y2', String(top));
    this.caretEl.style.display = collapsed || this.composing !== null ? '' : 'none';
    // Restart the blink so the caret is visible right after each move.
    this.caretEl.classList.remove('pdfsdk-caret--blink');
    void this.caretEl.getBoundingClientRect();
    this.caretEl.classList.add('pdfsdk-caret--blink');

    // Keep the hidden textarea at the caret so IME candidate windows open next to it.
    const [left, topPx] = this.view.pdfToElement([x, top]);
    this.input.style.left = `${left}px`;
    this.input.style.top = `${topPx}px`;
  }
}
