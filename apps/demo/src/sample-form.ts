import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** A one-page membership application with a field of each kind, to try form filling. */
export async function createSampleForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Membership application');
  const page = doc.addPage([595, 842]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const ink = rgb(0.1, 0.1, 0.1);
  const grey = rgb(0.45, 0.45, 0.45);

  page.drawText('Membership application', { x: 56, y: 770, size: 22, font: bold, color: ink });
  page.drawText('Northwind Community Library · Please fill in all fields.', {
    x: 56,
    y: 748,
    size: 10,
    font: regular,
    color: grey,
  });

  const label = (text: string, y: number) => page.drawText(text, { x: 56, y, size: 10, font: bold, color: ink });
  const text = (name: string, y: number, width = 300, height = 22) => {
    const field = form.createTextField(name);
    field.addToPage(page, { x: 200, y: y - 6, width, height, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 1 });
    // Without a set size pdf-lib writes its fit-to-box guess (56 pt for the address box) into the field.
    field.setFontSize(11);
    return field;
  };

  label('Full name', 700);
  text('full_name', 700);
  label('Email', 664);
  text('email', 664);
  label('Date of birth', 628);
  text('date_of_birth', 628, 140);
  label('Address', 592);
  text('address', 548, 300, 66).enableMultiline();

  label('Membership', 500);
  const plan = form.createRadioGroup('membership');
  ['Basic', 'Plus', 'Family'].forEach((option, i) => {
    plan.addOptionToPage(option, page, {
      x: 200 + i * 100,
      y: 496,
      width: 14,
      height: 14,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 1,
    });
    page.drawText(option, { x: 220 + i * 100, y: 499, size: 10, font: regular, color: ink });
  });

  label('Country', 460);
  const country = form.createDropdown('country');
  country.addOptions(['United States', 'United Kingdom', 'Canada', 'Australia', 'Germany', 'Poland', 'Ukraine']);
  country.addToPage(page, { x: 200, y: 454, width: 180, height: 22, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 1 });
  country.setFontSize(11);

  const agree = form.createCheckBox('terms');
  agree.addToPage(page, { x: 56, y: 400, width: 14, height: 14, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
  page.drawText('I agree to the library rules and the privacy notice.', { x: 78, y: 403, size: 10, font: regular, color: ink });

  label('Signature', 330);
  page.drawLine({ start: { x: 200, y: 326 }, end: { x: 420, y: 326 }, thickness: 0.8, color: grey });
  page.drawText('Use Sign to add yours.', { x: 200, y: 312, size: 8, font: regular, color: grey });

  return doc.save();
}
