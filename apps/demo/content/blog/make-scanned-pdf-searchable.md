---
title: How to make a scanned PDF searchable
description: Add a hidden text layer to scanned PDF pages with OCR, so you can search them, copy text from them and find them later.
date: 2026-10-26
tool: /ocr-pdf
toolName: Make a scanned PDF searchable
---

You know the invoice number is somewhere in that scanned PDF, but Ctrl+F finds nothing and you can’t select a single word. That’s because a scan is a picture of a page: there is no text in it to search.

Making it searchable means **reading** the page (OCR, optical character recognition) and putting what was read into the PDF as text.

## How it works

The recognized text goes in as an **invisible layer** under the scan, the way Acrobat’s “Recognize text” does it. The page looks exactly the same: same pixels, same stamps, same signatures. But underneath, every word now sits where it appears on the scan, so:

- **Search** finds it, in any PDF viewer.
- **Selecting** a line highlights it and **copy** gives you the text.
- Your computer’s file search can find the document by its content.

## Step by step

1. Open the scanned PDF in **Make a scanned PDF searchable**.
2. Its pages are read right away, in your browser. A page takes a few seconds; nothing is uploaded.
3. Try it: press Ctrl+F (⌘F on a Mac) and search for a word on the page.
4. Download the PDF. The text layer is saved in the file.

## Getting good results

- **Resolution matters.** 200–300 dpi scans read best; low-resolution faxes and photos read worse.
- **Straight pages.** A slight tilt is corrected automatically; pages photographed at an angle are not.
- **Tables are read cell by cell**, so numbers next to table borders aren’t lost.
- **Stamps and coloured signatures are ignored** while reading, so the text under them is still found.
- **Languages:** English and Ukrainian. Handwriting isn’t recognized.

## Why do it in the browser?

Scanned documents are often the sensitive ones: signed contracts, invoices with bank details, IDs. Here they are read on your own device, and the file is never sent anywhere.

And once a page has been read, you can also change its text: pick **Edit text** and click a line.
