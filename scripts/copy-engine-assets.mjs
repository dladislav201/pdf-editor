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
// OCR: Tesseract's worker, its LSTM-only WebAssembly cores (the browser picks
// one by SIMD support) and the Ukrainian + English models. Loaded only when
// text recognition runs.
mkdirSync(join(out, 'ocr', 'lang'), { recursive: true });
const tesseractDist = join(dirname(require.resolve('tesseract.js/package.json')), 'dist');
cpSync(join(tesseractDist, 'worker.min.js'), join(out, 'ocr', 'worker.min.js'));
const coreDir = dirname(require.resolve('tesseract.js-core/package.json', { paths: [tesseractDist] }));
for (const core of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  cpSync(join(coreDir, `${core}.wasm.js`), join(out, 'ocr', `${core}.wasm.js`));
}
for (const lang of ['eng', 'ukr', 'deu', 'nor', 'swe']) {
  const data = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  cpSync(join(data, '4.0.0_best_int', `${lang}.traineddata.gz`), join(out, 'ocr', 'lang', `${lang}.traineddata.gz`));
}
console.log(`engine assets copied to ${out}`);
