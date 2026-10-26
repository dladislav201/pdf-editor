# Test fixtures

Real PDFs from different producers, used by the text-model tests.

| File | Producer | Made with |
|---|---|---|
| `chrome-contract.pdf` | Chrome (Skia/PDF), subset CIDFontType2 fonts, one object per glyph | `chrome --headless --print-to-pdf` of `contract.html` |
| `quartz-invoice.pdf` | macOS Quartz, subset TrueType (MacRoman, no ToUnicode), one object per line | `cupsfilter -m application/pdf invoice.txt` |
| `scan-invoice.pdf` | A made-up Ukrainian invoice "scanned" at 200 dpi: one JPEG per page, rotated 0.6°, speckles, a blue stamp and signature | `node test/fixtures/make-scan.mjs` |
| `scan-invoice-en.pdf` | The same invoice in English, with a blue stamp over "For the supplier"; the site's scanned sample | `node test/fixtures/make-scan.mjs en` |
| `protected-user.pdf`, `protected-owner.pdf` | `chrome-contract.pdf` saved by macOS PDFKit (RC4-128) with a password to open (`secret`), and with an owner password only | `PDFDocument.write(to:withOptions:)` with `userPasswordOption` / `ownerPasswordOption` |
