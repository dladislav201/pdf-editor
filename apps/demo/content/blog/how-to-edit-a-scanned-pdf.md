---
title: How to edit a scanned PDF and keep the original look
description: A scanned PDF is a picture of a page, so ordinary editors can’t change its text. Here is how to edit it anyway, in letters taken from the scan itself.
date: 2026-10-26
tool: /edit-scanned-pdf
toolName: Edit a scanned PDF
---

You open a scanned contract or invoice, click on a word to fix it, and nothing happens. That’s not your editor failing: a scanned PDF doesn’t contain text at all. Each page is a photograph of paper, and to a computer the letters on it are just dark pixels.

To change a word on a scan, two things have to happen. First the page has to be **read**, so the editor knows which pixels are which letters. Then the new word has to be **drawn** so that it looks like it was always there.

## Step 1: let the page be read

Reading a page image is called OCR (optical character recognition). In most tools it’s a separate step you have to find and run. In the editor here it happens when you need it:

1. Open the PDF and pick **Edit text**.
2. Click the line you want to change.
3. The first click on a scanned page reads that page. It takes a few seconds and happens on your device; nothing is uploaded.
4. When it’s done, the line you clicked opens for editing.

From then on every paragraph on that page opens instantly.

## Step 2: change the words

Type as you would in any document. Lines wrap as you write, and the paragraph keeps its width and alignment.

The interesting part is what happens when you finish. Most editors cover the old words with a white box and type the new ones on top in a standard font, which is easy to spot: the font is too clean, too black, and perfectly straight on a page that is slightly tilted.

Here the new words are set **in letters cut out of the scan itself**. Every “a” you type is an “a” that already appears somewhere on the page, at the same size and weight, toned to the same ink, and placed along the same slight slant as the rest of the line. Words you didn’t touch keep their original pixels. The result is a page that still looks scanned, with your changes in it.

## What about stamps and signatures?

They stay. Only the black letters you change are erased and redrawn. If a blue stamp or a signature runs across the line, the stamp is kept, and the gaps where old letters were are filled with the stamp around them rather than with white holes.

## Getting good results

- **Scan at 200–300 dpi.** Low resolution scans have too few pixels per letter to read reliably.
- **Keep the page flat and straight.** A slight tilt is corrected; a photo taken at an angle is not.
- **Typed text only.** Handwriting isn’t recognized.
- **Languages:** English and Ukrainian are recognized.
- If you type a letter that doesn’t appear anywhere on the page, it’s drawn from a matching open font, so a rare letter may look a little cleaner than the rest.

## Is it private?

Yes. The scan is read and edited in your browser. The file never leaves your device, which matters for exactly the kind of documents that get scanned: contracts, invoices and IDs.

When you’re done, download the PDF. The changed text is also part of a hidden text layer, so the page can be searched and copied, and edited again later.
