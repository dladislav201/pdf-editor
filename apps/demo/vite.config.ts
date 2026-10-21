import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const fromRoot = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Work against the SDK sources so edits hot-reload without a package build.
    alias: {
      '@pdfsdk/editor': fromRoot('packages/editor/src/index.ts'),
      '@pdfsdk/react': fromRoot('packages/react/src/index.tsx'),
    },
  },
  server: { port: 5180 },
});
