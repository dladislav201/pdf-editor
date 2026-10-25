import { PDFDocument } from 'pdf-lib';

/** A picture to put on a page of its own: PNG or JPEG bytes. */
export interface PageImage {
  bytes: Uint8Array;
  type: 'png' | 'jpeg';
}

/**
 * A PDF with one page per picture, each page the picture's own size as if
 * printed at `dpi` (photos of documents at 150 dpi come out about A4).
 * JPEGs go in as they are, without re-encoding.
 */
export async function imagesToPdf(images: PageImage[], dpi = 150): Promise<Uint8Array> {
  if (!images.length) throw new Error('No pictures to put in the PDF.');
  const doc = await PDFDocument.create();
  for (const { bytes, type } of images) {
    const image = type === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const width = (image.width * 72) / dpi;
    const height = (image.height * 72) / dpi;
    doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  return doc.save();
}
