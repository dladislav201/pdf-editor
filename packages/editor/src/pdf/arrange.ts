import { PDFDocument, degrees, type PDFPage } from 'pdf-lib';

/** One page of the result: which source file and page it comes from, and how far to turn it. */
export interface ArrangedPage {
  /** Index into the `sources` given to `arrangePages`. */
  source: number;
  /** 0-based page index in that source. */
  page: number;
  /** Extra clockwise rotation: 0, 90, 180 or 270. */
  rotate?: number;
}

/**
 * Builds a PDF from pages of one or more PDFs, in any order and rotation:
 * reorder, rotate, delete (leave pages out), merge (pages of several
 * sources) and split (take some pages). Page content, annotations and links
 * travel with their pages; the first source's title is kept.
 */
export async function arrangePages(sources: Uint8Array[], pages: ArrangedPage[]): Promise<Uint8Array> {
  const loaded = await Promise.all(sources.map((bytes) => PDFDocument.load(bytes, { updateMetadata: false })));
  const out = await PDFDocument.create({ updateMetadata: false });
  const title = loaded[0]?.getTitle();
  if (title) out.setTitle(title);

  // Copy each source's pages in one go, so resources they share are copied once.
  const copied = new Map<string, PDFPage>();
  for (const [source, doc] of loaded.entries()) {
    const wanted = [...new Set(pages.filter((p) => p.source === source).map((p) => p.page))];
    for (const index of wanted) {
      if (index < 0 || index >= doc.getPageCount()) throw new Error(`Source ${source + 1} has no page ${index + 1}.`);
    }
    if (!wanted.length) continue;
    const result = await out.copyPages(doc, wanted);
    wanted.forEach((index, i) => copied.set(`${source}:${index}`, result[i]!));
  }

  const used = new Set<string>();
  for (const { source, page, rotate = 0 } of pages) {
    const key = `${source}:${page}`;
    // The same page twice needs its own copy.
    const copy = used.has(key) ? (await out.copyPages(loaded[source]!, [page]))[0]! : copied.get(key)!;
    used.add(key);
    out.addPage(copy);
    if (rotate % 360) copy.setRotation(degrees((((copy.getRotation().angle + rotate) % 360) + 360) % 360));
  }
  return out.save();
}
