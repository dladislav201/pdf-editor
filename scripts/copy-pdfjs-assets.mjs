// Copies the pdf.js runtime assets (worker, cmaps, standard fonts, wasm decoders)
// into a target folder so they can be served next to the editor.
// Usage: node scripts/copy-pdfjs-assets.mjs <targetDir>
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: copy-pdfjs-assets.mjs <targetDir>');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const out = resolve(target);
mkdirSync(out, { recursive: true });

cpSync(join(pdfjsRoot, 'build/pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(pdfjsRoot, dir), join(out, dir), { recursive: true });
}
console.log(`pdf.js assets copied to ${out}`);
