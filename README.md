# PDF SDK (working name)

Embeddable web PDF editor for SaaS products. Everything runs in the browser:
files are never uploaded anywhere.

## Packages

| Path | What it is |
|---|---|
| `packages/editor` | `@pdfsdk/editor` — framework-free core: rendering (PDFium WebAssembly in a Web Worker), annotation tools, undo/redo, PDF annotation read/write (pdf-lib) |
| `packages/react` | `@pdfsdk/react` — `<PdfEditor />` component |
| `apps/demo` | Demo site (Vite + React) with a generated sample contract |
| `scripts/copy-engine-assets.mjs` | Copies `pdfium.wasm` next to the bundle |

## Run

```bash
npm install
npm run dev        # demo at http://localhost:5180, hot-reloads SDK sources
npm run build      # builds both packages and the demo
npm run typecheck
npm test           # engine + annotation round-trip tests (vitest)
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
(`paragraphSelect` event); editing them in place is the next stage.

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
- invisible (OCR) and rotated text is skipped; text inside form XObjects is
  read but marked `editable: false` with a `reason`.

Fixtures from Chrome, macOS Quartz and pdf-lib live in
`packages/editor/test/fixtures` (with their sources) and are checked by
`src/text/analyze.test.ts`.

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
- Text annotations on rotated pages are not counter-rotated.
- No form filling, signatures, page operations, search, thumbnails or password
  prompt yet.
- No license key check, no CI; tests cover only annotation read/write.
