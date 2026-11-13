// Generates ordered-subset.pdf: a paragraph in a simple TrueType subset of
// Arimo whose codes follow the order the text first uses each glyph (space
// keeps 0x20, the rest count up from 0x21), with a ToUnicode map, as some
// producers write subsets. The text has no capital "D", and code 0x44, where
// a standard encoding has "D", is this font's "f". Run from packages/editor:
//   node test/fixtures/make-ordered-subset.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFHexString, beginText, endText, moveText, setFontAndSize, showText } from 'pdf-lib';
import { createSubsetter } from '../../src/engine/hb-subset.ts';

const require = createRequire(import.meta.url);
const arimo = readFileSync(
  join(dirname(require.resolve('@expo-google-fonts/arimo/package.json')), '400Regular', 'Arimo_400Regular.ttf'),
);
const subsetter = await createSubsetter(readFileSync(join(dirname(require.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')));

const LINES = [
  'Payment terms: the buyer receives one invoice per month, payable within',
  '30 days (net) by bank wire to account no. 4417-2209; late fees apply.',
];
const FIRST = 0x20;
const chars = [' ', ...new Set(LINES.join('').replaceAll(' ', ''))];
const codeOf = (char) => FIRST + chars.indexOf(char);
if (LINES.join('').includes('D') || chars[0x44 - FIRST] !== 'f') throw new Error('The text no longer puts "f" at 0x44.');

const hex = (n, width) => n.toString(16).toUpperCase().padStart(width, '0');

/** The subset with its cmap replaced by a (1,0) format 0 table: code → glyph. */
function orderedFont() {
  const subset = subsetter.subset(new Uint8Array(arimo), chars);
  const parsed = fontkit.create(subset);
  const cmap = new Uint8Array(12 + 262);
  const view = new DataView(cmap.buffer);
  view.setUint16(2, 1); // one encoding record
  view.setUint16(4, 1); // Macintosh
  view.setUint16(6, 0); // Roman
  view.setUint32(8, 12);
  view.setUint16(14, 262); // format 0, its length
  for (const char of chars) cmap[18 + codeOf(char)] = parsed.glyphForCodePoint(char.codePointAt(0)).id;
  return { bytes: replaceTable(subset, 'cmap', cmap), font: parsed };
}

function replaceTable(font, tag, data) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = [];
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    const name = String.fromCharCode(...font.subarray(record, record + 4));
    const offset = view.getUint32(record + 8);
    if (name !== tag) tables.push({ tag: name, data: font.slice(offset, offset + view.getUint32(record + 12)) });
  }
  tables.push({ tag, data });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const pad = (n) => (n + 3) & ~3;
  let size = 12 + tables.length * 16;
  const offsets = tables.map((t) => (size += pad(t.data.length)) - pad(t.data.length));
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  const power = 2 ** Math.floor(Math.log2(tables.length));
  o.setUint32(0, 0x00010000);
  o.setUint16(4, tables.length);
  o.setUint16(6, power * 16);
  o.setUint16(8, Math.log2(power));
  o.setUint16(10, tables.length * 16 - power * 16);
  tables.forEach((t, i) => {
    const record = 12 + i * 16;
    const padded = new Uint8Array(pad(t.data.length));
    padded.set(t.data);
    const words = new DataView(padded.buffer);
    let sum = 0;
    for (let k = 0; k < padded.length; k += 4) sum = (sum + words.getUint32(k)) >>> 0;
    for (let k = 0; k < 4; k++) out[record + k] = t.tag.charCodeAt(k);
    o.setUint32(record + 4, sum);
    o.setUint32(record + 8, offsets[i]);
    o.setUint32(record + 12, t.data.length);
    out.set(t.data, offsets[i]);
  });
  return out;
}

const { bytes, font } = orderedFont();
const doc = await PDFDocument.create();
doc.setProducer('make-ordered-subset.mjs');
doc.setCreator('make-ordered-subset.mjs');
const page = doc.addPage([595, 842]);
const ctx = doc.context;
const toUnicode = [
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
  '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
  '1 begincodespacerange <00> <FF> endcodespacerange',
  `${chars.length} beginbfchar`,
  ...chars.map((char) => `<${hex(codeOf(char), 2)}> <${hex(char.codePointAt(0), 4)}>`),
  'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
].join('\n');
const descriptor = ctx.obj({
  Type: 'FontDescriptor',
  FontName: 'BCDEFG+Arimo',
  Flags: 4, // symbolic: the codes are the font's own
  FontBBox: [-544, -303, 1302, 980],
  ItalicAngle: 0,
  Ascent: 905,
  Descent: -212,
  CapHeight: 716,
  StemV: 80,
  FontFile2: ctx.register(ctx.flateStream(bytes, { Length1: bytes.length })),
});
const fontRef = ctx.register(
  ctx.obj({
    Type: 'Font',
    Subtype: 'TrueType',
    BaseFont: 'BCDEFG+Arimo',
    FirstChar: FIRST,
    LastChar: FIRST + chars.length - 1,
    Widths: chars.map((char) => Math.round((font.glyphForCodePoint(char.codePointAt(0)).advanceWidth * 1000) / font.unitsPerEm)),
    FontDescriptor: ctx.register(descriptor),
    ToUnicode: ctx.register(ctx.flateStream(toUnicode)),
  }),
);
const key = page.node.newFontDictionary('F1', fontRef);
const encode = (line) => PDFHexString.of([...line].map((char) => hex(codeOf(char), 2)).join(''));
page.pushOperators(beginText(), setFontAndSize(key, 11), moveText(56, 760));
LINES.forEach((line, i) => page.pushOperators(...(i ? [moveText(0, -14)] : []), showText(encode(line))));
page.pushOperators(endText());

writeFileSync(new URL('./ordered-subset.pdf', import.meta.url), await doc.save({ useObjectStreams: false }));
