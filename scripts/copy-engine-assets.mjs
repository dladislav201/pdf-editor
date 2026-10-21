// Copies the engine runtime assets (the PDFium WebAssembly binary) into a
// target folder so they can be served next to the editor.
// Usage: node scripts/copy-engine-assets.mjs <targetDir>
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: copy-engine-assets.mjs <targetDir>');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const pdfiumDist = dirname(require.resolve('@embedpdf/pdfium'));
const out = resolve(target);
mkdirSync(out, { recursive: true });
cpSync(join(pdfiumDist, 'pdfium.wasm'), join(out, 'pdfium.wasm'));
console.log(`engine assets copied to ${out}`);
