# PDF SDK (working name)

Embeddable web PDF editor for SaaS products. Everything runs in the browser:
files are never uploaded anywhere.

## Packages

| Path | What it is |
|---|---|
| `packages/editor` | `@pdfsdk/editor` — framework-free core: rendering (PDFium WebAssembly in a Web Worker), annotation tools, undo/redo, PDF annotation read/write (pdf-lib) |
| `packages/react` | `@pdfsdk/react` — `<PdfEditor />` component |
| `apps/demo` | Demo site (Vite + React) with a generated sample contract |
| `scripts/copy-engine-assets.mjs` | Copies `pdfium.wasm`, `harfbuzz-subset.wasm`, the fallback fonts and the OCR assets (Tesseract worker, cores, Ukrainian and English models) next to the bundle |

## Run

```bash
npm install
npm run dev        # demo at http://localhost:5180, hot-reloads SDK sources
npm run build      # builds both packages and the demo
npm run typecheck
npm test           # engine, text, OCR, scan editing, annotation and licence tests (vitest)
```

## Deploy the demo

Live: https://pdf-sdk-demo.peer-mcp.workers.dev

The demo is a static site on Cloudflare Workers static assets (the successor
of Pages, free for static traffic). Config: `apps/demo/wrangler.toml`,
response headers: `apps/demo/public/_headers`.

```bash
npx wrangler login     # once per machine
npm run deploy:demo    # builds the demo and uploads it
```

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: `npm ci`, typecheck, all tests (PDFium, HarfBuzz and Tesseract run
in Node) and the build. On `main`, once the checks pass, it deploys the demo
too, provided the repository has a `CLOUDFLARE_API_TOKEN` secret (a
Cloudflare API token with the "Edit Cloudflare Workers" template); without it
that job only leaves a notice.

## Licence keys

The editor takes `licenseKey`. Without a valid key for the page's domain it
runs as a trial: a "PDF SDK · trial" watermark over every page and stamped
into every exported PDF, and a console warning saying why. Nothing else is
limited, and nothing is sent anywhere: the key is checked offline.

A key is `pdfsdk1.<payload>.<signature>`: JSON with the customer, the domains
(`app.acme.com`, `*.acme.com`), the plan and the last valid day, signed with
Ed25519 (`src/license.ts`, verified with `@noble/ed25519`, so it works in
browsers without Ed25519 in WebCrypto). Any valid key also works on
localhost, so customers develop with their production key. An expired key
falls back to the trial. `editor.getLicense()` tells the host app the status.

```bash
node scripts/license.mjs keygen      # once: ~/.pdfsdk/license-signing-key.pem + public key for src/license.ts
node scripts/license.mjs issue --customer "Acme Ltd" --domains "app.acme.com,*.acme.com" \
  --plan business --expires 2027-10-31
```

The signing key lives only in `~/.pdfsdk/` on the vendor's machine; keep a
backup (a password manager). Losing it means shipping a new public key and
reissuing every key. The demo's key (`apps/demo/src/license.ts`) covers only
the demo's domain.

## Usage

```ts
import { PdfEditor } from '@pdfsdk/editor';

const editor = await PdfEditor.create({
  container: document.getElementById('viewer')!, // needs an explicit height
  document: '/files/contract.pdf',               // URL, File/Blob, ArrayBuffer or Uint8Array
  assetsUrl: '/engine/',                         // where dist/engine/pdfium.wasm is served
  fontUrl: '/fonts/DejaVuSans.ttf',              // needed for non-Latin text annotations
  annotations: savedAnnotations,                 // optional, restored from your backend
});

editor.on('annotationsChange', ({ annotations }) => save(annotations));
const pdfBytes = await editor.exportPdf();       // annotations saved as real PDF annotations
const flat = await editor.exportPdf({ flatten: true }); // or burned into the pages
```

React:

```tsx
<PdfEditor
  document={file}
  assetsUrl="/engine/"
  onAnnotationsChange={save}
  ref={editorRef}
/>
```

API surface: `load`, `exportPdf`, `download`, `getAnnotations` / `setAnnotations` /
`addAnnotation` / `removeAnnotation`, `select`, `deleteSelected`, `undo` / `redo`,
`setTool`, `setColor`, `setZoom` / `zoomIn` / `zoomOut`, `goToPage`, `getPageText`,
`getSelectedParagraph`, `on(event)`, `destroy`.
Set `toolbar: false` to drive it from your own UI.

Keyboard: V select, E edit text, H highlight, R rectangle, D draw, T text, Del delete,
Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo, arrows nudge the selection, Ctrl+wheel zoom.

## PDF annotations

Saving writes standard annotation objects with appearance streams, so other
viewers show them and can edit them. Checked so far with Apple PDFKit (Preview,
Quick Look) and pdf.js (Firefox); Acrobat and Chrome (PDFium) not yet tested.

| Editor | PDF |
|---|---|
| highlight | `/Highlight` with `/QuadPoints` (one quad per line segment) |
| rectangle | `/Square` with `/BS` |
| ink | `/Ink` with `/InkList` |
| text | `/FreeText` with `/DA`, text in the embedded `fontUrl` font |

The annotation id is stored in `/NM`, author in `/T`, comments in `/Contents`.

On open, those four types are read from the file (including ones made by
other tools: `/RD` insets, legacy `/Border`, gray/CMYK colors, `/DA` text
color), removed from the copy the engine renders, and become editable. Their
popups go with them. Everything else (links, form fields, stamps, notes,
hidden annotations) is left untouched and written back as is. Pass
`importAnnotations: false` to keep all annotations as static page content, or
`annotations` to start from your own saved state instead.

## Page text model

`getPageText(pageIndex)` returns how the engine reads a page: paragraphs →
lines → glyphs, with runs (font, size, color), alignment (left, right, center,
justify), leading and first-line indent, all in PDF points. The Edit text tool
(E) outlines paragraphs on hover and selects them on click
(`paragraphSelect` event).

## Editing page text in place

With Edit text (E), clicking a paragraph opens it for editing right on the
page; `exportPdf()` / Download write the edits into the PDF
(`getTextEdits()`, `textEditsChange`).

- Glyphs are drawn from the document's own font outlines (PDFium
  `FPDFFont_GetGlyphPath`), so subset fonts without a usable cmap still look
  exactly like the page. Characters a subset font lacks come from the
  fallback font (`fontUrl`). The original text objects are switched off in the
  page bitmap (`FPDFPageObj_SetIsActive`) while their paragraph is edited.
- Missing glyphs are detected per character: PDFium returns the font's
  ".notdef" box for them, so an outline equal to that box, a zero advance, or
  a visible character without an outline counts as missing.
- `text/layout.ts` sets the paragraph: greedy breaking with real advances
  (after spaces and hyphens, hard breaks, over-long words split), first-line
  indent, left/right/center/justify; single-line paragraphs may grow to the
  page's text block. Styles (font, size, color, super/subscript rise) are kept
  per character; typed text takes the style before the caret.
- Input goes through a hidden textarea (`beforeinput`), so IME composition,
  dead keys and the clipboard work. Keys: arrows with Alt/Ctrl (words) and
  Cmd (line ends), Home/End, Backspace/Delete by word or line, Enter (line
  break), Cmd+A, Cmd+Z / Shift+Cmd+Z; mouse click, drag, Shift+click, double
  (word) and triple (all) click. Escape leaves the paragraph; edited
  paragraphs stay drawn and reopen with their edits.
- Paragraphs whose page objects also hold other text, or that sit in form
  XObjects, are read-only for now.
- Text that grows into other content is flagged with a red outline; content
  below does not move (as in Acrobat).

### Writing edits into the PDF

On save, each edited paragraph becomes a plan (`text/write-plan.ts`) that the
engine applies to a copy of the file (`applyTextPlans`), then
`FPDFPage_GenerateContent`:

- A glyph that still exists keeps its own page object and is only moved
  (Chrome/Skia draw one object per glyph), so unchanged text stays the same
  glyphs, kerning included. Original glyph spacing and line baselines are kept
  in the layout, so a paragraph whose text didn't change is rewritten with
  **zero changed pixels** (tested).
- New or retyped text becomes words in the same document font; lines drawn as
  one object (Quartz, pdf-lib, Word) are redrawn word by word.
- Invisible space glyphs (Chrome writes them as objects) are kept when their
  neighbours stay together and removed otherwise, so copy/search don't see
  spaces inside reflowed words.
- A word with any character the (subset) document font lacks is set entirely
  in a fallback font matching the family and style: Arimo (≈ Arial/Helvetica),
  Tinos (≈ Times), Cousine (≈ Courier), each in regular/bold/italic/bold
  italic, metric-compatible and with full Cyrillic. They load lazily from
  `fallbackFontsUrl` (default `engine/fonts/`) and are embedded subset to the
  used characters with HarfBuzz's `hb-subset` (`harfbuzz-subset.wasm`) — a few
  KB instead of 300+. (pdf-lib's fontkit subsetter drops composite glyphs in
  these fonts, so it is not used for this.)

Checked by `src/text/write.test.ts` on Chrome, Quartz and standard-font files
(text read back, pixels outside the paragraph unchanged, fallback words
actually rendered) and by eye in Apple Quick Look and pdf.js.

Built from PDFium's glyphs in the worker (~20 ms per page):

- lines: glyphs sharing a baseline, split at wide gaps so columns and table
  cells stay apart; sub/superscripts are folded back into their line;
- paragraphs: same size, consistent leading, aligned edges; a new one starts at
  an indented first line, after the short last line of justified text, or when
  the next line's first word would have fit on the previous one (list items,
  hard breaks);
- justification is told from ragged text by stretched word gaps, not edges;
- single lines are aligned against the page's text block (centered titles,
  right-aligned page numbers);
- invisible text (an OCR layer) becomes paragraphs with `recognized: true`,
  grouped along the scan's skew; rotated text is skipped; text inside form XObjects is read but marked `editable: false`
  with a `reason`.

Fixtures from Chrome, macOS Quartz and pdf-lib live in
`packages/editor/test/fixtures` (with their sources) and are checked by
`src/text/analyze.test.ts`.

## Scanned pages: text recognition (OCR)

A page that is one big picture with (almost) no text is a scan:
`editor.getScanInfo(page)` says so (`{ scanned, recognized, dpi }`) and the
demo offers to recognize it. `editor.recognizeText()` (or the toolbar's
Recognize text) reads every scanned page without recognized text and puts
the text under the scan as invisible text, like Acrobat's Recognize Text: the
page looks the same, but the text can be selected, searched and copied, here
and in any viewer, and it is part of the downloaded PDF.

```ts
editor.on('ocrProgress', ({ pageIndex, done, total }) => showProgress(done, total));
const pages = await editor.recognizeText({ languages: ['ukr', 'eng'] }); // words, boxes, confidence per page
```

Per page (all in the browser, Tesseract.js 7 LSTM `best_int` models):

1. the page is rendered at 300 dpi without annotations;
2. coloured ink (blue stamps, signatures) is dropped, black and grey stay;
3. skew is measured on long rules and the page straightened;
4. Tesseract reads the page; table cells are found from their rulings and
   each one is re-read on its own at 2× (borders erased, numbers with a digits
   alphabet when that reads better), since cell borders eat short numbers;
5. noise is dropped and Latin look-alikes in Cyrillic words are mapped back
   ("TOBAPUCTBO", "Ha", "Ne 17" → «№ 17»), real Latin words stay;
6. each word goes into the page as invisible text (render mode 3) in an Arimo
   subset, stretched along its baseline over the word on the scan, skew
   included, at the size it appears in (from the height of its ink), bold
   where its strokes are thick for that size, in the colour of its ink.

### Editing a scan

Recognized text is edited like any text, with the Edit text tool (as in
Acrobat): the paragraph is set anew in Arimo of its weight, at the measured
size and colour, and its words come off the scan underneath. The cleaned
piece is cut from the scan's own pixels and put back exactly on them, with
only the words' ink replaced by the paper colour; table borders and rules
crossing it are kept, and nothing outside it changes (`src/text/scan-edit.ts`,
`src/ocr/erase.ts`, `PdfiumDocument.scanPatch`). While editing, the same
cleaned piece is shown under the new text; on save it goes into the PDF as an
image, under the new visible text, and the paragraph's invisible text is
removed. `src/text/scan-edit.test.ts` checks it on the synthetic scan: the
total and a table cell edited, the rest of the page pixel-identical, borders
kept, the new text extracted as visible text.

Assets: `dist/engine/ocr/` (worker, three LSTM cores — the browser picks
relaxed-SIMD, SIMD or plain — and `lang/{ukr,eng}.traineddata.gz`, ~5 MB),
fetched on first use; `ocrUrl` moves them. `tesseract.js` is an external
dependency of the package, imported on first use. Pages with unsaved text
edits are skipped; a page that already has a text layer is never read twice.

Measured: a real 300 dpi Ukrainian invoice with stamps (kept local) — 87% of
characters, 94% of words, 15 of 15 key fields, ~4 s per page in Node; the
synthetic scan in the demo — 1.6 s in Chrome once the models are cached.
`src/ocr/ocr.test.ts` checks each step and the whole path on
`test/fixtures/scan-invoice.pdf` (generated by `make-scan.mjs`: rotated
0.6°, speckles, a blue stamp): text found, stamp text not, totals in place,
the page renders pixel-identical after the layer is written, and the layer
reads back as whole lines.

## Design notes

- Rendering runs on PDFium (the engine in Chrome) compiled to WebAssembly
  (`@embedpdf/pdfium`, MIT; PDFium itself BSD/Apache) inside a Web Worker, so
  big pages never block the UI. The worker is a separate file in
  `dist/assets/`; the 4.6 MB wasm (2.1 MB gzipped) is fetched from
  `assetsUrl`. Pass `workerUrl` to serve the worker from elsewhere (CSP, CDN).
  The same engine will edit page text, so what you see is what gets saved.

- Annotations live in PDF user space (points, bottom-left origin), so they are
  zoom-independent and the exporter writes them without conversion.
- Each page is a canvas plus an SVG overlay; pages render lazily as they near
  the viewport and release their bitmaps when far away.
- Styles are injected at runtime under `.pdfsdk-root`; theme tokens are CSS
  variables (`--pdfsdk-accent`, …), `theme: 'light' | 'dark' | 'auto'`.

## Known gaps (next steps)

- Importing parses the file with pdf-lib on the main thread and re-saves it
  when it held editable annotations; very large files will feel that. Move to
  a worker, or skip the re-save by hiding annotations at render time.
- Rich text (`/RC`) of FreeText annotations is read as plain `/Contents`;
  other markup types (underline, strike-out, circle, line, polygon, sticky
  notes) are shown but not editable yet.
- Highlight is a free rectangle; text-aware highlighting can now build on the page text model.
- Text model: two plain text lines without spacing (e.g. from a .txt) read as one
  paragraph; bullets drawn as shapes are not part of the item's text; vertical
  and rotated text is skipped.
- Text editing: no bold/italic toggles or font picker; text edits have their own
  undo inside a paragraph but are outside the editor's undo history; the
  live document isn't modified until save, so page text search/selection
  reflects the original until the file is reopened; a paragraph that grows
  overlaps content below instead of pushing it down; not yet checked in
  Acrobat and Chrome.
- Text annotations on rotated pages are not counter-rotated.
- OCR: edited scan text is always set in Arimo (no serif or other look-alike
  font yet); the cleaned area is flat paper colour, so on grainy scans its
  edge can show faintly; a stamp crossing an edited word loses the part over
  it; the image work (ink, skew, cells) runs on the main thread between
  Tesseract calls; handwriting and photographed (perspective) pages are
  not handled; only Ukrainian and English models ship.
- No form filling, signatures, page operations, search, thumbnails or password
  prompt yet.
- Licence keys are issued by hand with `scripts/license.mjs`; the customer
  dashboard (WorkOS sign-in, self-serve keys, billing) doesn't exist yet. Like
  any client-side check, the watermark can be removed by someone patching the
  bundle; it is there to make paying the easy path.
