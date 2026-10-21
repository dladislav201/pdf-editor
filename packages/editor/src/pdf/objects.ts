import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  rgb,
  type RGB,
} from 'pdf-lib';
import type { Rect } from '../types';

export const name = (value: string): PDFName => PDFName.of(value);

export function hexToRgb(hex: string): RGB {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return rgb(0, 0, 0);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function hexToComponents(hex: string): [number, number, number] {
  const { red, green, blue } = hexToRgb(hex);
  return [round3(red), round3(green), round3(blue)];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function toHex(components: number[]): string {
  return `#${components
    .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** PDF color arrays are gray, RGB or CMYK depending on their length. */
export function componentsToHex(components: number[]): string | undefined {
  if (components.length === 1) return toHex([components[0]!, components[0]!, components[0]!]);
  if (components.length === 3) return toHex(components);
  if (components.length === 4) {
    const [c, m, y, k] = components as [number, number, number, number];
    return toHex([(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]);
  }
  return undefined;
}

/** `D:YYYYMMDDHHmmSSZ`, the PDF date format. */
export function pdfDate(date: Date): string {
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return `D:${valid.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

export function rectToArray({ x, y, width, height }: Rect): number[] {
  return [x, y, x + width, y + height];
}

// ------------------------------------------------------------------ reading

export function numbersOf(array: PDFArray | undefined): number[] {
  if (!array) return [];
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const value = array.lookupMaybe(i, PDFNumber);
    if (value) out.push(value.asNumber());
  }
  return out;
}

export function readNumber(dict: PDFDict, key: string): number | undefined {
  return dict.lookupMaybe(name(key), PDFNumber)?.asNumber();
}

export function readText(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(name(key), PDFString, PDFHexString)?.decodeText();
}

export function readDate(dict: PDFDict, key: string): Date | undefined {
  try {
    const date = dict.lookupMaybe(name(key), PDFString, PDFHexString)?.decodeDate();
    return date && !Number.isNaN(date.getTime()) ? date : undefined;
  } catch {
    return undefined;
  }
}

/** Normalized rectangle from a `[x1 y1 x2 y2]` array (corners may come in any order). */
export function readRect(dict: PDFDict, key = 'Rect'): Rect | undefined {
  const values = numbersOf(dict.lookupMaybe(name(key), PDFArray));
  if (values.length !== 4) return undefined;
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** Border width from `/BS /W`, falling back to the legacy `/Border` array, then the PDF default of 1. */
export function readBorderWidth(dict: PDFDict): number {
  const bs = dict.lookupMaybe(name('BS'), PDFDict);
  const fromBs = bs ? readNumber(bs, 'W') : undefined;
  if (fromBs !== undefined) return fromBs;
  const border = numbersOf(dict.lookupMaybe(name('Border'), PDFArray));
  return border[2] ?? 1;
}
