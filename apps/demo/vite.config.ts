import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfiumViteConfig } from '../../packages/editor/vite-pdfium.ts';

const fromRoot = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export default defineConfig({
  ...pdfiumViteConfig,
  plugins: [react(), ...pdfiumViteConfig.plugins!],
  resolve: {
    alias: [
      ...(pdfiumViteConfig.resolve!.alias as { find: RegExp; replacement: string }[]),
      // Work against the SDK sources so edits hot-reload without a package build.
      { find: '@pdfsdk/editor', replacement: fromRoot('packages/editor/src/index.ts') },
      { find: '@pdfsdk/react', replacement: fromRoot('packages/react/src/index.tsx') },
    ],
  },
  server: { port: 5180 },
});
