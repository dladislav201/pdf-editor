// Generates scan-invoice.pdf: a made-up Ukrainian invoice "scanned" at 200 dpi —
// slightly rotated, grey speckles, a blue stamp over the totals and a blue
// signature, saved as one JPEG per page. With `en`, the same invoice in English
// (scan-invoice-en.pdf, the site's sample). Run from packages/editor:
//   node test/fixtures/make-scan.mjs [en]
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const arimo = dirname(require.resolve('@expo-google-fonts/arimo/package.json'));
GlobalFonts.registerFromPath(join(arimo, '400Regular', 'Arimo_400Regular.ttf'), 'Arimo');
GlobalFonts.registerFromPath(join(arimo, '700Bold', 'Arimo_700Bold.ttf'), 'Arimo Bold');

const english = process.argv[2] === 'en';
const T = english
  ? {
      title: 'Invoice No. INV-2026-0042 dated 21 October 2026',
      supplier: 'Supplier: Northwind Supplies Ltd, 12 Test Street, London',
      customer: 'Customer: Contoso Logistics GmbH, Berlin',
      contract: 'Contract: No. 17 of 1 September 2026',
      cells: [
        ['No.', 'Item', 'Unit', 'Qty', 'Price', 'Amount'],
        ['1', 'Office paper A4, 500 sheets', 'pack', '12', '4.50', '54.00'],
        ['2', 'Toner cartridge HP 85A', 'pcs', '3', '89.50', '268.50'],
        ['3', 'Stapler staples No. 24', 'box', '20', '1.80', '36.00'],
      ],
      total: 'Total excl. VAT: GBP 358.50',
      words: 'Amount in words: three hundred and fifty-eight pounds, fifty pence.',
      from: 'For the supplier ____________',
      to: 'Received by ____________',
      // Centred in the stamp.
      stamp: [
        ['NORTHWIND', 170 - 27],
        ['REG. 00000000', 170 - 32],
      ],
      file: './scan-invoice-en.pdf',
    }
  : {
      title: 'Видаткова накладна № ТЕСТ-0042 від 21 жовтня 2026 р.',
      supplier: 'Постачальник: ТОВ "Приклад Постач", м. Київ, вул. Тестова, 12',
      customer: 'Покупець: ФОП Тестовий Іван Петрович, м. Львів',
      contract: 'Договір: № 17 від 01.09.2026',
      cells: [
        ['№', 'Товар', 'Од.', 'Кількість', 'Ціна', 'Сума'],
        ['1', 'Папір офісний A4, 500 арк.', 'пач', '12', '145,00', '1740,00'],
        ['2', 'Toner cartridge HP 85A', 'шт', '3', '890,50', '2671,50'],
        ['3', 'Скоби для степлера №24', 'уп', '20', '18,40', '368,00'],
      ],
      total: 'Разом без ПДВ: 4779,50 грн',
      words: "Всього на суму: чотири тисячі сімсот сімдесят дев'ять гривень 50 копійок.",
      from: 'Від постачальника ____________',
      to: 'Отримав(ла) ____________',
      stamp: [
        ['ПРИКЛАД ПОСТАЧ', 132],
        ['ЄДРПОУ 00000000', 131],
      ],
      file: './scan-invoice.pdf',
    };

const DPI = 200;
const W = Math.round(8.27 * DPI);
const H = Math.round(11.69 * DPI);
const pt = (v) => (v * DPI) / 72;

const page = createCanvas(W, H);
const ctx = page.getContext('2d');
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#1d1d1d';
ctx.strokeStyle = '#1d1d1d';

const text = (s, x, y, size = 10, bold = false) => {
  ctx.font = `${pt(size)}px "${bold ? 'Arimo Bold' : 'Arimo'}"`;
  ctx.fillText(s, pt(x), pt(y));
};

text(T.title, 60, 80, 14, true);
text(T.supplier, 60, 115);
text(T.customer, 60, 133);
text(T.contract, 60, 151);

// Table: column edges and rows in points.
const cols = [60, 85, 300, 335, 395, 460, 535];
const rows = [180, 200, 220, 240, 260];
ctx.lineWidth = pt(0.8);
for (const y of rows) {
  ctx.beginPath();
  ctx.moveTo(pt(cols[0]), pt(y));
  ctx.lineTo(pt(cols.at(-1)), pt(y));
  ctx.stroke();
}
for (const x of cols) {
  ctx.beginPath();
  ctx.moveTo(pt(x), pt(rows[0]));
  ctx.lineTo(pt(x), pt(rows.at(-1)));
  ctx.stroke();
}
T.cells.forEach((row, r) =>
  row.forEach((cell, c) => {
    const numeric = c >= 3 || c === 0;
    ctx.font = `${pt(9)}px "${r === 0 ? 'Arimo Bold' : 'Arimo'}"`;
    const width = ctx.measureText(cell).width;
    const x = numeric && r > 0 ? pt(cols[c + 1]) - pt(4) - width : pt(cols[c]) + pt(4);
    ctx.fillText(cell, x, pt(rows[r] + 14));
  }),
);

text(T.total, 360, 285, 10, true);
text(T.words, 60, 315);
text(T.from, 60, 380);
text(T.to, 330, 380);

// Blue stamp and signature: coloured ink over the text, as on real scans.
ctx.strokeStyle = '#2b4db8';
ctx.fillStyle = '#2b4db8';
ctx.lineWidth = pt(1.6);
ctx.beginPath();
ctx.arc(pt(170), pt(370), pt(48), 0, Math.PI * 2);
ctx.stroke();
ctx.beginPath();
ctx.arc(pt(170), pt(370), pt(36), 0, Math.PI * 2);
ctx.stroke();
ctx.font = `${pt(8)}px "Arimo Bold"`;
ctx.fillText(T.stamp[0][0], pt(T.stamp[0][1]), pt(366));
ctx.fillText(T.stamp[1][0], pt(T.stamp[1][1]), pt(380));
ctx.lineWidth = pt(1.2);
ctx.beginPath();
ctx.moveTo(pt(350), pt(385));
ctx.bezierCurveTo(pt(370), pt(340), pt(390), pt(400), pt(410), pt(360));
ctx.bezierCurveTo(pt(420), pt(345), pt(430), pt(390), pt(455), pt(368));
ctx.stroke();

// The "scanner": a slight rotation, then speckles.
const scan = createCanvas(W, H);
const out = scan.getContext('2d');
out.fillStyle = '#fff';
out.fillRect(0, 0, W, H);
out.translate(W / 2, H / 2);
out.rotate((0.6 * Math.PI) / 180);
out.drawImage(page, -W / 2, -H / 2);
out.setTransform(1, 0, 0, 1, 0, 0);
let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
out.fillStyle = '#8a8a8a';
for (let i = 0; i < 900; i++) out.fillRect(random() * W, random() * H, 1 + random(), 1 + random());

const doc = await PDFDocument.create();
doc.setProducer('pdfsdk make-scan.mjs');
doc.setCreationDate(new Date('2026-10-21T00:00:00Z'));
doc.setModificationDate(new Date('2026-10-21T00:00:00Z'));
const image = await doc.embedJpg(scan.toBuffer('image/jpeg', 80));
const pdfPage = doc.addPage([595.28, 841.89]);
pdfPage.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
writeFileSync(new URL(T.file, import.meta.url), await doc.save());
