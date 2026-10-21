import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin, UserConfig } from 'vite';

const require = createRequire(import.meta.url);
/** Browser build of the PDFium glue code (the package's default entry targets Node). */
const pdfiumBrowserEntry = join(dirname(require.resolve('@embedpdf/pdfium')), 'index.browser.js');

/**
 * The PDFium glue code points at its wasm with `new URL('pdfium.wasm',
 * import.meta.url)`, which a library build inlines as 6 MB of base64. We always
 * hand it the wasm bytes ourselves (fetched from `assetsUrl`), so that URL is
 * dead code: replace it with a plain string before Vite sees it.
 */
function dropPdfiumWasmUrl(): Plugin {
  return {
    name: 'pdfsdk:drop-pdfium-wasm-url',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@embedpdf/pdfium')) return null;
      return code.replace(/new URL\(\s*[`'"]pdfium\.wasm[`'"]\s*,\s*import\.meta\.url\s*\)(\.href)?/g, '"pdfium.wasm"');
    },
  };
}

/** Vite settings any build that bundles the engine worker from source needs. */
export const pdfiumViteConfig: Pick<UserConfig, 'plugins' | 'worker' | 'resolve'> = {
  plugins: [dropPdfiumWasmUrl()],
  worker: { format: 'es', plugins: () => [dropPdfiumWasmUrl()] },
  resolve: { alias: [{ find: /^@embedpdf\/pdfium$/, replacement: pdfiumBrowserEntry }] },
};
