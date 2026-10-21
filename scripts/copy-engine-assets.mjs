// Copies the engine runtime assets into a target folder so they can be served
// next to the editor: the PDFium and HarfBuzz-subset WebAssembly binaries, and the fallback fonts
// (metric-compatible with Arial, Times New Roman and Courier New) used when
// edited text needs characters a document's subset font lacks.
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
const out = resolve(target);
mkdirSync(join(out, 'fonts'), { recursive: true });
cpSync(join(dirname(require.resolve('@embedpdf/pdfium')), 'pdfium.wasm'), join(out, 'pdfium.wasm'));
// HarfBuzz's subsetter: shrinks a fallback font to the characters edited text uses before it is embedded.
cpSync(join(dirname(require.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm'), join(out, 'harfbuzz-subset.wasm'));

const families = { Arimo: 'arimo', Tinos: 'tinos', Cousine: 'cousine' };
const styles = { Regular: '400Regular', Bold: '700Bold', Italic: '400Regular_Italic', BoldItalic: '700Bold_Italic' };
for (const [family, pkg] of Object.entries(families)) {
  const root = dirname(require.resolve(`@expo-google-fonts/${pkg}/package.json`));
  for (const [style, folder] of Object.entries(styles)) {
    cpSync(join(root, folder, `${family}_${folder}.ttf`), join(out, 'fonts', `${family}-${style}.ttf`));
  }
}
console.log(`engine assets copied to ${out}`);
