# Test fixtures

Real PDFs from different producers, used by the text-model tests.

| File | Producer | Made with |
|---|---|---|
| `chrome-contract.pdf` | Chrome (Skia/PDF), subset CIDFontType2 fonts, one object per glyph | `chrome --headless --print-to-pdf` of `contract.html` |
| `quartz-invoice.pdf` | macOS Quartz, subset TrueType (MacRoman, no ToUnicode), one object per line | `cupsfilter -m application/pdf invoice.txt` |
