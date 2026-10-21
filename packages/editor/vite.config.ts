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
      external: [/^pdf-lib/, /^@pdf-lib\//],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
