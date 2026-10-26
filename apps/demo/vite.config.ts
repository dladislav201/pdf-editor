import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfiumViteConfig } from '../../packages/editor/vite-pdfium.ts';

const fromRoot = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** Whether any guide in content/blog is published (not a draft); until then the site doesn't link to them. */
function hasGuides(): boolean {
  const folder = fileURLToPath(new URL('content/blog/', import.meta.url));
  return readdirSync(folder)
    .filter((file) => file.endsWith('.md'))
    .some((file) => !/^draft:\s*true\s*$/m.test(readFileSync(folder + file, 'utf8')));
}

export default defineConfig(({ command }) => ({
  ...pdfiumViteConfig,
  define: {
    // While developing the drafts show too.
    __GUIDES__: JSON.stringify(command === 'serve' || process.env.DRAFTS === '1' || hasGuides()),
  },
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
}));
