import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [/^pdfjs-dist/, /^pdf-lib/, /^@pdf-lib\//],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
