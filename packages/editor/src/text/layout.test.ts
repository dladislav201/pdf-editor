import { describe, expect, it } from 'vitest';
import { layoutParagraph, type CharStyle, type ParagraphFrame, type StyledChar } from './layout';

const style: CharStyle = { font: 1, size: 10, color: '#000000', rise: 0 };
/** Every char is 5 pt wide (half an em at 10 pt): easy to reason about. */
const measure = () => 5;
const chars = (text: string): StyledChar[] => [...text].map((char) => ({ char, style }));
const frame = (overrides: Partial<ParagraphFrame> = {}): ParagraphFrame => ({
  x: 100,
  width: 100, // 20 chars per line
  firstBaseline: 700,
  leading: 12,
  indent: 0,
  align: 'left',
  ...overrides,
});
const lineTexts = (text: string, f = frame()) =>
  layoutParagraph(chars(text), f, measure).lines.map((l) => [...text].slice(l.start, l.end).join(''));

describe('paragraph layout', () => {
  it('breaks greedily at spaces and keeps trailing spaces on the line', () => {
    expect(lineTexts('the quick brown fox jumps over the lazy dog')).toEqual([
      'the quick brown fox ',
      'jumps over the lazy ',
      'dog',
    ]);
  });

  it('puts a hard break at the end of its line and starts a new one', () => {
    expect(lineTexts('first\nsecond line')).toEqual(['first\n', 'second line']);
    expect(lineTexts('ends with break\n')).toEqual(['ends with break\n', '']);
  });

  it('breaks after a hyphen and splits words longer than the column', () => {
    // 12 chars per line: "a well-known-" (13) doesn't fit, so the line breaks after the first hyphen.
    expect(lineTexts('a well-known-trick here', frame({ width: 60 }))).toEqual(['a well-', 'known-trick ', 'here']);
    expect(lineTexts('abcdefghijklmnopqrstuvwxyz')).toEqual(['abcdefghijklmnopqrst', 'uvwxyz']);
  });

  it('indents the first line and narrows it', () => {
    const layout = layoutParagraph(chars('aaaa bbbb cccc dddd eeee'), frame({ indent: 30 }), measure);
    expect(layout.lines.map((l) => l.left)).toEqual([130, 100]);
    expect(layout.lines[0]!.end).toBe(15); // "aaaa bbbb cccc " fits in 70 pt minus trailing space
  });

  it('aligns right and center by the ink width, ignoring trailing spaces', () => {
    const right = layoutParagraph(chars('abc def'), frame({ align: 'right' }), measure);
    expect(right.lines[0]!.left).toBe(165);
    expect(right.lines[0]!.right).toBe(200);
    const center = layoutParagraph(chars('abc def'), frame({ align: 'center' }), measure);
    expect(center.lines[0]!.left).toBe(132.5);
  });

  it('justifies every line but the last by stretching spaces', () => {
    const layout = layoutParagraph(chars('aaa bbb ccc ddd eee fff ggg'), frame({ align: 'justify' }), measure);
    const [first, last] = layout.lines;
    expect(first!.right).toBeCloseTo(200);
    // Last line keeps natural spacing.
    expect(last!.right - last!.left).toBe(35);
  });

  it('places lines one leading apart and applies rise to glyphs', () => {
    const text = chars('m2 is an area unit that wraps');
    text[1] = { char: '2', style: { ...style, size: 6, rise: 4 } };
    const layout = layoutParagraph(text, frame(), measure);
    expect(layout.lines.map((l) => l.baseline)).toEqual([700, 688]);
    expect(layout.lines[0]!.glyphs[1]!.y).toBe(704);
  });

  it('maps offsets to carets and points back to offsets', () => {
    const layout = layoutParagraph(chars('the quick brown fox jumps over'), frame(), measure);
    expect(layout.caret(0)).toEqual({ line: 0, x: 100 });
    expect(layout.caret(4)).toEqual({ line: 0, x: 120 });
    // At the wrap point the caret belongs to the start of the next line.
    expect(layout.caret(20)).toEqual({ line: 1, x: 100 });
    expect(layout.caret(30)).toEqual({ line: 1, x: 150 });

    expect(layout.hit(121, 703)).toBe(4);
    expect(layout.hit(400, 703)).toBe(19); // right of a wrapped line: before its trailing space
    expect(layout.hit(400, 690)).toBe(30); // right of the last line: end of text
  });

  it('moves the caret up and down keeping the x position', () => {
    const layout = layoutParagraph(chars('the quick brown fox jumps over the lazy dog'), frame(), measure);
    expect(layout.vertical(4, 1)).toBe(24);
    expect(layout.vertical(24, -1)).toBe(4);
    expect(layout.vertical(2, -1)).toBe(0);
    expect(layout.vertical(41, 1)).toBe(43);
  });
});
