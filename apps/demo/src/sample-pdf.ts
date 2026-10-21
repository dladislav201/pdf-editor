import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 64;
const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.85, 0.86, 0.88);

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

class Writer {
  y: number;
  constructor(
    readonly page: PDFPage,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.y = page.getHeight() - MARGIN;
  }

  heading(text: string, size = 13) {
    this.y -= size + 10;
    this.page.drawText(text, { x: MARGIN, y: this.y, size, font: this.bold, color: INK });
    this.y -= 8;
  }

  paragraph(text: string, size = 10.5) {
    const width = this.page.getWidth() - MARGIN * 2;
    for (const line of wrap(text, this.regular, size, width)) {
      this.y -= size * 1.5;
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font: this.regular, color: INK });
    }
    this.y -= 6;
  }

  footer(index: number, total: number) {
    const text = `Page ${index} of ${total}`;
    this.page.drawLine({ start: { x: MARGIN, y: 48 }, end: { x: this.page.getWidth() - MARGIN, y: 48 }, color: RULE });
    this.page.drawText('Northwind Software Ltd. · Confidential', { x: MARGIN, y: 32, size: 8.5, font: this.regular, color: MUTED });
    this.page.drawText(text, {
      x: this.page.getWidth() - MARGIN - this.regular.widthOfTextAtSize(text, 8.5),
      y: 32,
      size: 8.5,
      font: this.regular,
      color: MUTED,
    });
  }
}

/** A small, realistic-looking contract to try the editor on without uploading anything. */
export async function createSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Software Services Agreement');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = [doc.addPage(A4), doc.addPage(A4), doc.addPage(A4)];
  const [p1, p2, p3] = pages.map((page) => new Writer(page, regular, bold)) as [Writer, Writer, Writer];

  p1.page.drawText('SOFTWARE SERVICES AGREEMENT', { x: MARGIN, y: p1.y - 20, size: 20, font: bold, color: INK });
  p1.y -= 44;
  p1.page.drawText('Agreement No. NW-2026-0417  ·  Effective 1 November 2026', { x: MARGIN, y: p1.y, size: 10, font: regular, color: MUTED });
  p1.y -= 24;
  p1.paragraph(
    'This Software Services Agreement (the "Agreement") is entered into by and between Northwind Software Ltd., a company registered in Ireland ("Provider"), and Contoso Logistics GmbH, a company registered in Germany ("Customer"). Provider and Customer are each a "Party" and together the "Parties".',
  );
  p1.heading('1. Scope of Services');
  p1.paragraph(
    'Provider shall deliver the document management platform described in Schedule A, including hosting, maintenance, security updates and second-line technical support. Any work outside Schedule A requires a written change request signed by both Parties.',
  );
  p1.paragraph(
    'Provider shall make the platform available 99.9% of each calendar month, excluding scheduled maintenance announced at least five business days in advance.',
  );
  p1.heading('2. Fees and Payment');
  p1.paragraph(
    'Customer shall pay a monthly subscription fee of EUR 4,800 for up to 250 named users, plus EUR 18 per additional user. Invoices are issued on the first business day of each month and are payable within thirty (30) days.',
  );
  p1.paragraph(
    'Late payments accrue interest at 1% per month. Provider may suspend the services if an undisputed invoice remains unpaid for more than sixty (60) days after written notice.',
  );
  p1.heading('3. Term and Termination');
  p1.paragraph(
    'The initial term is twenty-four (24) months from the Effective Date and renews automatically for successive twelve-month periods unless either Party gives ninety (90) days written notice before the end of the current term.',
  );

  p2.heading('4. Service Levels', 13);
  p2.paragraph('Response times depend on the severity of the incident reported by Customer:');
  const rows = [
    ['Severity', 'Example', 'First response', 'Resolution target'],
    ['Critical', 'Platform unavailable', '30 minutes', '4 hours'],
    ['High', 'Core feature broken', '2 hours', '1 business day'],
    ['Medium', 'Feature degraded', '1 business day', '5 business days'],
    ['Low', 'Question or cosmetic issue', '2 business days', 'Next release'],
  ];
  const columns = [MARGIN, MARGIN + 90, MARGIN + 250, MARGIN + 360];
  p2.y -= 14;
  rows.forEach((row, r) => {
    const y = p2.y - r * 26;
    if (r === 0) p2.page.drawRectangle({ x: MARGIN - 6, y: y - 8, width: A4[0] - MARGIN * 2 + 12, height: 24, color: rgb(0.95, 0.96, 0.97) });
    row.forEach((cell, c) => p2.page.drawText(cell, { x: columns[c]!, y, size: 10, font: r === 0 ? bold : regular, color: INK }));
    p2.page.drawLine({ start: { x: MARGIN - 6, y: y - 9 }, end: { x: A4[0] - MARGIN + 6, y: y - 9 }, color: RULE });
  });
  p2.y -= rows.length * 26 + 10;
  p2.heading('5. Data Protection');
  p2.paragraph(
    'Provider processes personal data only on documented instructions from Customer and in accordance with the Data Processing Agreement in Schedule B. All customer data is stored in data centres located in the European Union.',
  );
  p2.paragraph(
    'Provider shall notify Customer without undue delay, and in any event within forty-eight (48) hours, after becoming aware of a personal data breach affecting Customer data.',
  );
  p2.heading('6. Limitation of Liability');
  p2.paragraph(
    "Except for breaches of confidentiality or data protection obligations, each Party's total liability under this Agreement is limited to the fees paid by Customer in the twelve (12) months preceding the event giving rise to the claim.",
  );

  p3.heading('7. Governing Law', 13);
  p3.paragraph(
    'This Agreement is governed by the laws of Ireland. The courts of Dublin have exclusive jurisdiction over any dispute arising out of or in connection with this Agreement.',
  );
  p3.heading('8. Signatures');
  p3.paragraph('Signed by the authorised representatives of the Parties on the dates written below.');
  p3.y -= 40;
  for (const [i, party] of ['Northwind Software Ltd.', 'Contoso Logistics GmbH'].entries()) {
    const x = MARGIN + i * 250;
    p3.page.drawText(party, { x, y: p3.y, size: 10.5, font: bold, color: INK });
    for (const [j, label] of ['Signature', 'Name', 'Date'].entries()) {
      const y = p3.y - 50 - j * 44;
      p3.page.drawLine({ start: { x, y }, end: { x: x + 200, y }, color: MUTED, thickness: 0.75 });
      p3.page.drawText(label, { x, y: y - 13, size: 8.5, font: regular, color: MUTED });
    }
  }

  [p1, p2, p3].forEach((writer, i) => writer.footer(i + 1, pages.length));
  return doc.save();
}
