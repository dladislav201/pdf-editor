# PDF SDK (working name)

Embeddable web PDF editor for SaaS products. Everything runs in the browser:
files are never uploaded anywhere.

## Packages

| Path | What it is |
|---|---|
| `packages/editor` | `@pdfsdk/editor` — framework-free core: rendering (PDFium WebAssembly in a Web Worker), annotation tools, undo/redo, PDF annotation read/write (pdf-lib) |
| `packages/react` | `@pdfsdk/react` — `<PdfEditor />` component |
| `apps/demo` | The web service (Vite + React): start page with drop zone and tools, and the editor with floating pill toolbars (the editor's built-in toolbar is off). Live as LovelyDoc at https://lovelydoc.com |
| `scripts/copy-engine-assets.mjs` | Copies `pdfium.wasm`, `harfbuzz-subset.wasm`, the fallback fonts and the OCR assets (Tesseract worker, cores, English, Ukrainian, German, Norwegian and Swedish models) next to the bundle |

## Run

```bash
npm install
npm run dev        # demo at http://localhost:5180, hot-reloads SDK sources
npm run build      # builds both packages and the demo
npm run typecheck
npm test           # engine, text, OCR, scan editing, annotation and licence tests (vitest)
npm run e2e        # the built site in Chromium, Edge, Firefox, WebKit and an iPhone (Playwright)
```

## Browser checks

`e2e/site.spec.ts` drives the production build (`vite preview` on port 4180)
the way people use it: opening a PDF, editing a paragraph, search, filling
a form, signing, page thumbnails, compressing, recognizing a scan and a
300-page document; downloads are read back with pdf-lib and PDFium. Each
runs in Chromium, Edge (the installed browser), Firefox, WebKit (Safari's
engine) and an iPhone 14 (WebKit, touch, 390 px). Locally the Playwright
Firefox build doesn't start on this macOS version, so Firefox is covered on
CI (Linux), where Edge is skipped.

Measured in Chromium: a 1000-page text PDF opens in about 1 s and its last
page draws at once (pages render as they scroll in); the first search reads
every page's text in the worker (about 10 ms a page, so 10 s; matches show
as they're found), later searches use the kept index (60 ms).

## Deploy the demo

Live: https://lovelydoc.com (also https://pdf-sdk-demo.peer-mcp.workers.dev)

The domain is registered at Spaceship (renews yearly, auto-renew on) with its
nameservers pointed at Cloudflare; `routes` in `wrangler.toml` attach it and
`www.lovelydoc.com` to the Worker as custom domains.

The demo is a static site on Cloudflare Workers static assets (the successor
of Pages, free for static traffic). Config: `apps/demo/wrangler.toml`,
response headers: `apps/demo/public/_headers`.

```bash
npx wrangler login     # once per machine
npm run deploy:demo    # builds the demo and uploads it
```

## Scan languages

Tesseract models for English, Ukrainian, German, Norwegian (Bokmål) and
Swedish ship in `dist/engine/ocr/lang` (1.3–3 MB each, loaded on first use).
The editor reads scans in the `ocrLanguages` option (default `ukr` +
`eng`); every language added costs time per page. The site reads the
page's language with English: `deu`, `nor`, `swe` on the German, Norwegian
and Swedish pages, `ukr` + `eng` on the English and Ukrainian ones. The
Cyrillic clean-ups (Latin look-alikes, "Ne 17" → "№ 17") only apply with
Ukrainian among the languages. `test/fixtures/scan-invoice-{de,nb,sv}.pdf`
are the synthetic invoice in those languages (`make-scan.mjs de|nb|sv`);
`src/ocr/languages.test.ts` reads them: with its own model the German scan
gives "Müller & Söhne, Hauptstraße, München", with English alone "Miller &
S6hne, Munchen".

## Protected PDFs

A file with an encryption dictionary is decrypted once, when it opens: the
engine worker opens it in PDFium (empty password first, which opens files
with only an owner password, i.e. editing restrictions) and saves a copy
with `FPDF_REMOVE_SECURITY`; everything after (annotations, forms, pdf-lib,
export) works on that plain copy. When the file needs a password to open,
the editor calls the `getPassword({ fileName, incorrect })` option and tries
again until it's right or the answer is null (then the file doesn't open).
`documentUnlocked` tells the app; the site asks in a dialog and says the
downloaded copy won't ask for the password. Merging (Add PDF) goes the same
way. Saving with a password isn't possible yet.

## Undo

`undo()` / `redo()` (⌘Z, ⇧⌘Z, Ctrl+Y) cover everything: in an open
paragraph they step through the typing; otherwise through one history of
annotation changes and paragraph edits, where each paragraph left after
changing it (Escape, a click elsewhere) is one step, scanned paragraphs
included. Shortcuts go by the key's place (`event.code`), so they work with
any keyboard layout (⌘Z on a Ukrainian one reports "я"). The site shows Undo
and Redo with the Edit text tool too, without taking the caret away. The
`textEditing` event says when a paragraph opens and closes; the site's hint
mentions Esc only then.

## Search engines

The site is built for search as well as for use (`apps/demo`):

- **A page per task people search for**: `/edit-pdf-text`, `/edit-scanned-pdf`,
  `/ocr-pdf`, `/sign-pdf`, `/fill-pdf-form`, `/annotate-pdf`, `/compress-pdf`,
  `/merge-pdf`, `/split-pdf`, `/rotate-pdf`, `/delete-pdf-pages`, `/pdf-to-jpg`,
  `/jpg-to-pdf`, plus the start page. Each has its own title, description,
  heading, three steps and questions (`src/site.ts`), opens a chosen file
  straight in its tool, and every page links to every other in the footer.
- **Static HTML**: after `vite build`, `src/entry-server.tsx` is built for
  Node and `scripts/prerender.mjs` writes each page (`compress-pdf.html`,
  served as `/compress-pdf`) with its words in the markup, a canonical link,
  Open Graph and Twitter tags, and JSON-LD (`WebApplication`, free offer, and
  `FAQPage`); also `404.html` (noindex; unknown paths now answer 404),
  `sitemap.xml` and `robots.txt`.
- **A light start page**: the editor, PDFium and pdf-lib load when a file is
  opened (the start page's script went from the whole app to about 250 KB),
  and the handwriting fonts load with the signature dialog only.
- **Brand**: LovelyDoc, a page with a heart. The name (`SITE.name`) is in
  titles, the top bar and the footer; the mark is `src/Logo.tsx` and
  `public/favicon.svg`. PNG icons and `public/og.png` (1200×630) are drawn
  from it by `scripts/make-images.mjs`.

**Languages**: English, German, Norwegian (Bokmål), Swedish and Ukrainian.
Every word of the site and the editor's own messages are in
`apps/demo/src/i18n/<code>.ts`: `en.ts` is the reference, and the others
must have the same keys and arguments (TypeScript checks it); counts are
functions, so each language says "1 Seite / 2 Seiten", "1 сторінка / 2
сторінки / 5 сторінок" its own way. English lives at `/`, the others under
`/de`, `/nb`, `/sv`, `/uk`, with the tool pages at addresses in their own
words (`/de/pdf-komprimieren`, `/sv/komprimera-pdf`; `src/site.ts`). Each
page is prerendered with its `lang`, `og:locale` and `hreflang` links to
the other languages (and `x-default` to English), and the sitemap lists
the alternates. A language menu on the start page goes to the same page in
another language; an English page offers the visitor's browser language
once. The page's dictionary alone is downloaded. The editor takes its
words through the new `messages` option (`EditorMessages`). Guides and scan
recognition stay English (and Ukrainian, for OCR).

**Guides** (`/blog`): step-by-step articles for the longer searches people
make ("how to edit a scanned PDF", "compress a PDF for email"…), each
leading to its tool page. A guide is a Markdown file in
`apps/demo/content/blog/` with a front matter block (`title`, `description`,
`date`, `tool`, `toolName`, optional `draft: true`); the build turns it into
a static page with `Article` structured data and adds it to the sitemap.
Drafts show with `npm run dev` (at `/blog`) and in `DRAFTS=1` builds, not on
the live site; the footer links to the guides only once one is published.
To publish, remove the draft line and push.

The name and address are placeholders in `src/site.ts` (`SITE`): a custom
domain, set there and added to the Worker in Cloudflare, is the next step,
then Google Search Console and Bing Webmaster Tools with the sitemap.

## Usage counts and feedback

The site's Worker (`apps/demo/worker/`) serves the static files and, under
`/api`, takes anonymous usage counts, error reports and feedback into a D1
database (`pdf-sdk-site`, schema in `apps/demo/migrations/`). Nothing can
identify a person or a file: no cookies or ids, counts are per day and
event name (`open.sample.scan`, `tool.editText`, `download.compressed.strong`,
`pages.apply`, `ocr.run`…), errors per day and message (links stripped),
feedback keeps the message, an optional email and the browser family only
("Safari on iOS"). Only same-origin posts are taken; a hidden field catches
form bots. The site batches counts (`src/telemetry.ts`, sent every 5 s and
when the page is hidden) and stays quiet in development. The start page says
so in one line.

```bash
npm run stats      # uses per event, last 30 days
npm run errors     # errors seen, last 30 days
npm run feedback   # latest 50 notes
```

`npm run deploy:demo` applies new migrations before deploying. Locally,
`npx wrangler dev --local` in `apps/demo` (after a build and
`wrangler d1 migrations apply pdf-sdk-site --local`) runs the same Worker
with a local database.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: `npm ci`, typecheck, all tests (PDFium, HarfBuzz and Tesseract run
in Node) and the build, and in a second job the browser checks in Chromium
and the iPhone profile, inside Playwright's image (browsers preinstalled,
so no download step). `nightly.yml` runs them in every profile, Firefox and
desktop WebKit included, each night and on demand (Actions › Nightly
browsers › Run workflow). On `main`, once the checks pass, it deploys the demo
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
- Bold and italic: Cmd/Ctrl+B and +I, or `toggleTextStyle('bold' | 'italic')`
  (`getTextStyle()`, `textStyleChange` for toolbars). The selection — or, with
  nothing selected, what is typed next — goes to a font of the same family the
  page already uses (Helvetica → Helvetica-Bold), else to the matching
  fallback (Arimo/Tinos/Cousine Bold, Italic, Bold Italic). Families are
  matched by PostScript name without the subset prefix and style
  (`ABCDEF+Arial-BoldMT` = `ArialMT`). Not for a scan's letters.
- A paragraph that gets longer pushes what is below it down
  (`text/push.ts`), like a word processor: paragraphs, lines, pictures and
  whole tables in the same column move as far as it grew, and push what is
  under them in turn; a gap wider than two lines (above a footer) takes up
  some of it first. On screen the moved objects are rendered shifted
  (`render(…, moved)`), and on save they are moved in the file. Nothing moves
  — the text is flagged with a red outline instead — when the paragraph sits
  in a cell or a box (a graphic around its end), when text would leave the
  page, when it would move text inside a form XObject, or on a page with
  recognized text (the scan underneath can't move).

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

With the Edit text tool, a click on a scanned page that has no text yet
reads that page first and then opens the paragraph under the click, as
Acrobat does (`recognizeOnEdit`, on by default); the site says so while
Edit text is on a scan.

### Editing a scan

Recognized text is edited like any text, with the Edit text tool (as in
Acrobat), but it stays a scan: the result is a piece of the scan, not a font.

- **Letters from the scan itself** (`src/ocr/scan-font.ts`). Tesseract
  reports a box per letter; the page's letters are cut out (per weight and
  size), and samples OCR got wrong are dropped: a top or bottom that doesn't
  sit where that kind of letter sits (a capital read as lower case, "р" read
  as "г"), or a shape unlike the letter's other samples. Spacing is the
  page's own: what each letter keeps on either side, the gap between words,
  the narrower one between groups of digits, digits on the page's fixed
  pitch, and each paragraph's own tightness (a table cell sits closer than
  prose).
- **Untouched words keep their pixels** (`src/text/scan-type.ts`). Words the
  user didn't change are copied from the scan as they are (moved along if
  the line reflows); new words are set from the samples, the area's own
  letters first, on the scan's skew, toned to the paragraph's ink. A letter
  the page lacks is drawn from Arimo's outline; a bold letter the page only
  has in regular is thickened.
- **One piece of image** under the caret while editing, and in the saved
  PDF: the piece is cut from the scan's own pixels and put back on its pixel
  grid, under an invisible text layer for the new text, so the paragraph can
  still be searched, copied and edited again.

- **Stamps stay** (`src/ocr/erase.ts`). Under a stamp or signature only
  the letters are erased (black ink, and black blended into the stamp's
  colour); the stamp's own strokes and tints stay, and a letter's place is
  filled with the stamp and paper around it instead of a white hole. Words
  moved along a reflowed line take only their own ink, not the stamp over
  them, and letters cut from under a stamp are used only when the page has
  no clean sample of that letter.

Pages recognized by `recognizeText` keep their letters in memory; a page
recognized earlier (or by another tool) is read again for its letters (a
page pass, no table cells) as soon as the Edit text tool is on with that
page in view, so the first click opens the paragraph at once (2 s → 0.1 s
on the sample). If that fails, the paragraph is set in Arimo of
its weight over the scan with its words erased (`src/text/scan-edit.ts`).
`src/text/scan-type.test.ts` checks it on the synthetic scan: an untouched
paragraph comes back as it was, a new amount and a new word are drawn and
stay searchable, nothing outside the piece changes.

## Signatures and pictures

`editor.placeImage({ src, width, height, kind })` puts a picture (a PNG or
JPEG data URL) where the user clicks next (the `image` tool), a third of the
page wide at most; it is then selected, can be moved, and resizes from its
bottom-right corner keeping its proportions. It is an `image` annotation:
saved as a PDF Stamp (`/Name /Signature` for signatures) whose appearance
draws the picture, with the original file kept alongside so reopening the
PDF here gives back the same picture, still movable; flattening draws it
into the page.

The site's Sign dialog makes the picture: draw it (a pen that thins when
moving fast), type it in one of three script fonts, or upload a photo of it
(the paper turns transparent); black or blue ink; the last three signatures
are kept in this browser only.

## Search

`editor.search(query)` finds text on every page, recognized text of scans
included, paragraph by paragraph (so a phrase that wraps onto the next line
is found), ignoring case and extra spaces by default; it marks every match
under the page content and returns them (page, a box per line, the text).
`showSearchMatch(i)` marks one as current and scrolls to it;
`clearSearch()` removes the marks. Pages are searched in the engine worker,
ten at a time (`onProgress` reports matches so far), and each page's text is
kept there as a compact index (`indexPage`: strings and typed arrays of
boxes), so a long document's text models never fill the page's memory
(1000 pages: 45 MB instead of 700 MB) and refining a query is instant. The site opens its search bar with
⌘F / Ctrl+F: Enter and Shift+Enter step through the matches, Esc closes.

## Forms

`readFormFields(doc)` (`src/pdf/forms.ts`, pdf-lib) lists the fields a user
can fill (text, multi-line text, check boxes, radio groups, dropdowns,
lists) with their value, options and widgets (page and box). The editor
reads them on open and puts an HTML input over each widget, sized with the
page (`--pdfsdk-scale`) and active with the Select tool; Tab moves between
them. `getFormFields()`, `setFormValue(name, value)` and the `formChange`
event (`onFormChange` in React) give apps the same access. On save the
values go into the form and every field's appearance is redrawn, with the
document font for text outside Latin-1; `flatten: true` burns the fields
into the pages.

PDFium draws form fields only through a form-fill environment, so
documents with a form get one (empty callbacks, no JavaScript) and each
render adds `FPDF_FFLDraw` on top; buttons and signature fields show up
too. The site's "A form" sample is a membership application with a field of
each kind.

## Compress and convert

`editor.compress(level)` makes the document (with its edits) smaller: in
the engine worker each picture sharper than the level's resolution where
it's drawn (`light` 200 dpi, `recommended` 150, `strong` 110 at lower
quality) is scaled down and stored as JPEG through PDFium
(`FPDFImageObj_LoadJpegFileInline`, fed by a JS callback), if that is
smaller. Pictures with transparency, 1-bit fax scans and pictures shared by
several pages stay as they are; text and drawings are untouched. The
synthetic scan goes from 152 KB to 50 KB on `strong`.

`imagesToPdf(images)` makes a PDF with one page per JPEG or PNG, sized as
printed at 150 dpi (JPEGs go in unchanged). The site's Download menu adds
"Compressed PDF" and "Pictures" (every page as PNG or JPG at 72/150/300
dpi, several pages as a ZIP); dropping photos on the start page turns them
into a PDF.

## Pages

`editor.pages()` gives the open document's pages for thumbnails (sizes and a
renderer); `editor.openPages(file)` opens another PDF alongside it (the
engine worker now keeps several documents) to merge it in.
`arrangePages(sources, pages)` (`src/pdf/arrange.ts`, pdf-lib) builds a PDF
from pages of one or more PDFs in any order and rotation, so it covers
reorder, rotate, delete, merge and split (extract some pages); annotations
and links travel with their pages. `editor.arrangePages()` runs it on the
current document with its edits, and `editor.applyPageArrangement()` goes
on editing the result.

The site's Pages view (Edit / Pages at the top) shows the thumbnails:
click, ⌘/Ctrl-click and Shift-click to select, drag to reorder (the
selection moves together), rotate and delete per page or for the selection,
Extract downloads the selected pages as a new PDF, Add PDF appends the pages
of other PDFs; Apply changes rebuilds the document and keeps editing it.

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
- Text editing: no font picker or sizes; the live document isn't modified
  until save, so page text search/selection reflects the original (and the
  place of pushed text) until the file is reopened; annotations on pushed text
  stay where they were; a paragraph in a table cell can't grow its cell (it
  overlaps, flagged); a shorter paragraph leaves its space empty instead of
  pulling what is below up; not yet checked in Acrobat and Chrome.
- Text annotations on rotated pages are not counter-rotated.
- OCR: a letter the page doesn't contain at all is drawn in Arimo; a viewer
  may draw the edited piece a fraction of a pixel off the page image; the
  image work (ink, skew, cells) runs on the main thread between Tesseract
  calls (about 0.1 s a page on the sample); handwriting and photographed
  (perspective) pages are not handled.
- Phones: reordering pages relies on HTML drag and drop (iOS 15+ after a
  long press; not yet checked on a real device); the theme switch and zoom
  buttons are hidden (pinch to zoom).
- Forms: no JavaScript (calculated fields, formatting, validation), no
  XFA-only forms, comb fields and rich text are filled as plain text;
  signature fields are left to Sign.
- Licence keys are issued by hand with `scripts/license.mjs`; the customer
  dashboard (WorkOS sign-in, self-serve keys, billing) doesn't exist yet. Like
  any client-side check, the watermark can be removed by someone patching the
  bundle; it is there to make paying the easy path.
