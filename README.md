# PDF SDK (working name)

Embeddable web PDF editor for SaaS products. Everything runs in the browser:
files are never uploaded anywhere.

## Packages

| Path | What it is |
|---|---|
| `packages/editor` | `@pdfsdk/editor` — framework-free core: rendering (pdf.js), annotation tools, undo/redo, export (pdf-lib) |
| `packages/react` | `@pdfsdk/react` — `<PdfEditor />` component |
| `apps/demo` | Demo site (Vite + React) with a generated sample contract |
| `scripts/copy-pdfjs-assets.mjs` | Copies the pdf.js worker, cmaps, fonts and wasm next to the bundle |

## Run

```bash
npm install
npm run dev        # demo at http://localhost:5180, hot-reloads SDK sources
npm run build      # builds both packages and the demo
npm run typecheck
```

## Usage

```ts
import { PdfEditor } from '@pdfsdk/editor';

const editor = await PdfEditor.create({
  container: document.getElementById('viewer')!, // needs an explicit height
  document: '/files/contract.pdf',               // URL, File/Blob, ArrayBuffer or Uint8Array
  assetsUrl: '/pdfjs/',                          // where dist/pdfjs/* is served
  fontUrl: '/fonts/DejaVuSans.ttf',              // needed for non-Latin text annotations
  annotations: savedAnnotations,                 // optional, restored from your backend
});

editor.on('annotationsChange', ({ annotations }) => save(annotations));
const pdfBytes = await editor.exportPdf();       // annotations burned into the pages
```

React:

```tsx
<PdfEditor
  document={file}
  assetsUrl="/pdfjs/"
  onAnnotationsChange={save}
  ref={editorRef}
/>
```

API surface: `load`, `exportPdf`, `download`, `getAnnotations` / `setAnnotations` /
`addAnnotation` / `removeAnnotation`, `select`, `deleteSelected`, `undo` / `redo`,
`setTool`, `setColor`, `setZoom` / `zoomIn` / `zoomOut`, `goToPage`, `on(event)`, `destroy`.
Set `toolbar: false` to drive it from your own UI.

Keyboard: V select, H highlight, R rectangle, D draw, T text, Del delete,
Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo, arrows nudge the selection, Ctrl+wheel zoom.

## Design notes

- Annotations live in PDF user space (points, bottom-left origin), so they are
  zoom-independent and the exporter writes them without conversion.
- Each page is a canvas plus an SVG overlay; pages render lazily as they near
  the viewport and release their bitmaps when far away.
- Styles are injected at runtime under `.pdfsdk-root`; theme tokens are CSS
  variables (`--pdfsdk-accent`, …), `theme: 'light' | 'dark' | 'auto'`.

## Known gaps (next steps)

- Export flattens annotations into page content. Next: write real PDF
  annotation objects (Highlight, Square, Ink, FreeText) so they stay editable
  in Acrobat, and read existing ones on load.
- Highlight is a free rectangle; text-aware highlighting needs the pdf.js text layer.
- Text annotations on rotated pages are not counter-rotated.
- No form filling, signatures, page operations, search, thumbnails or password
  prompt yet.
- No license key check, no tests, no CI.
