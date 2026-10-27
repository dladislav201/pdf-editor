import { describe, expect, it } from 'vitest';
import { pushDown, type PushItem } from './push';

const page = { x: 0, y: 0, width: 600, height: 800 };
const options = { keepGap: 28, page };
/** A box from its left, top, right and bottom. */
const box = (left: number, topY: number, right: number, bottom: number) => ({ x: left, y: bottom, width: right - left, height: topY - bottom });

describe('pushDown', () => {
  it('moves the paragraphs below in the same column by as much as the edited one grew', () => {
    const items: PushItem[] = [
      { id: 'edited', box: box(50, 700, 300, 660), growth: 14 },
      { id: 'next', box: box(50, 655, 300, 600) },
      { id: 'after', box: box(50, 594, 300, 560) },
      { id: 'other column', box: box(320, 655, 550, 600) },
      { id: 'above', box: box(50, 760, 300, 720) },
    ];
    expect(pushDown(items, options)).toEqual(
      new Map([
        ['next', 14],
        ['after', 14],
      ]),
    );
  });

  it('lets a wide gap (above a footer) take up the growth', () => {
    const items: PushItem[] = [
      { id: 'edited', box: box(50, 700, 300, 660), growth: 30 },
      { id: 'last', box: box(50, 655, 300, 600) },
      { id: 'footer', box: box(250, 60, 350, 50) },
    ];
    const shifts = pushDown(items, options)!;
    expect(shifts.get('last')).toBe(30);
    expect(shifts.has('footer')).toBe(false);
  });

  it('moves a table below as a whole: its lines and the text in its cells', () => {
    const items: PushItem[] = [
      { id: 'edited', box: box(50, 700, 550, 660), growth: 12 },
      { id: 'grid', box: box(50, 650, 550, 550), graphic: true },
      { id: 'cell a', box: box(55, 645, 200, 630) },
      { id: 'cell b', box: box(305, 645, 545, 630) },
      { id: 'row 2', box: box(305, 600, 545, 585) },
    ];
    expect(pushDown(items, options)).toEqual(
      new Map([
        ['grid', 12],
        ['cell a', 12],
        ['cell b', 12],
        ['row 2', 12],
      ]),
    );
  });

  it('pushes nothing when the paragraph sits in a cell or a box', () => {
    const items: PushItem[] = [
      { id: 'cell', box: box(50, 700, 200, 640), graphic: true },
      { id: 'edited', box: box(55, 695, 195, 670), growth: 12 },
      { id: 'below', box: box(55, 660, 195, 645) },
    ];
    expect(pushDown(items, options)).toBeNull();
  });

  it('ignores a background covering the page', () => {
    const items: PushItem[] = [
      { id: 'background', box: box(0, 800, 600, 0), graphic: true },
      { id: 'edited', box: box(50, 700, 300, 660), growth: 12 },
      { id: 'next', box: box(50, 655, 300, 600) },
    ];
    expect(pushDown(items, options)).toEqual(new Map([['next', 12]]));
  });

  it('gives up when text would leave the page or something fixed would move', () => {
    const near = [
      { id: 'edited', box: box(50, 100, 300, 40), growth: 30 },
      { id: 'next', box: box(50, 38, 300, 10) },
    ];
    expect(pushDown(near, options)).toBeNull();
    const fixed = [
      { id: 'edited', box: box(50, 700, 300, 660), growth: 12 },
      { id: 'next', box: box(50, 655, 300, 600), fixed: true },
    ];
    expect(pushDown(fixed, options)).toBeNull();
  });

  it('moves an edited paragraph below another one and adds its own growth', () => {
    const items: PushItem[] = [
      { id: 'first', box: box(50, 700, 300, 660), growth: 10 },
      { id: 'second', box: box(50, 655, 300, 620), growth: 5 },
      { id: 'third', box: box(50, 615, 300, 600) },
    ];
    expect(pushDown(items, options)).toEqual(
      new Map([
        ['second', 10],
        ['third', 15],
      ]),
    );
  });

  it('pulls up what follows a paragraph that got shorter, keeping the gaps, but not a footer', () => {
    const items: PushItem[] = [
      { id: 'heading', box: box(50, 760, 300, 745) },
      { id: 'edited', box: box(50, 740, 300, 660), growth: -28 },
      { id: 'next', box: box(50, 654, 300, 600) },
      { id: 'rule', box: box(50, 596, 300, 595), graphic: true },
      { id: 'after', box: box(50, 589, 300, 560) },
      { id: 'other column', box: box(320, 654, 550, 600) },
      { id: 'footer', box: box(250, 60, 350, 50) },
    ];
    expect(pushDown(items, options)).toEqual(
      new Map([
        ['next', -28],
        ['rule', -28],
        ['after', -28],
      ]),
    );
  });

  it('pulls a table up as a whole, but nothing inside a box around the paragraph', () => {
    const table: PushItem[] = [
      { id: 'edited', box: box(50, 700, 550, 660), growth: -12 },
      { id: 'grid', box: box(50, 650, 550, 550), graphic: true },
      { id: 'cell a', box: box(55, 645, 200, 630) },
      { id: 'cell b', box: box(305, 600, 545, 585) },
    ];
    expect(pushDown(table, options)).toEqual(
      new Map([
        ['grid', -12],
        ['cell a', -12],
        ['cell b', -12],
      ]),
    );
    const cell: PushItem[] = [
      { id: 'cell', box: box(50, 700, 200, 600), graphic: true },
      { id: 'edited', box: box(55, 695, 195, 670), growth: -12 },
      { id: 'below in the cell', box: box(55, 660, 195, 645) },
      { id: 'below the cell', box: box(50, 590, 200, 575) },
    ];
    expect(pushDown(cell, options)).toEqual(new Map());
  });

  it('leaves fixed text, and what follows it, where it is', () => {
    const items: PushItem[] = [
      { id: 'edited', box: box(50, 700, 300, 660), growth: -14 },
      { id: 'fixed', box: box(50, 655, 300, 640), fixed: true },
      { id: 'after', box: box(50, 635, 300, 620) },
    ];
    expect(pushDown(items, options)).toEqual(new Map());
  });

  it('does nothing when no paragraph grew', () => {
    expect(pushDown([{ id: 'a', box: box(0, 10, 10, 0) }], options)).toEqual(new Map());
  });
});
