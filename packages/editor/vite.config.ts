import { defineConfig } from 'vite';
import { pdfiumViteConfig } from './vite-pdfium.ts';

export default defineConfig({
  ...pdfiumViteConfig,
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      // Tesseract.js is loaded on first use of text recognition, from the host's own dependencies.
      external: [/^pdf-lib/, /^@pdf-lib\//, /^tesseract\.js/],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
