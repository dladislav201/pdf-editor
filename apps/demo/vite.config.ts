import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfiumViteConfig } from '../../packages/editor/vite-pdfium.ts';

const fromRoot = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** The languages with a published guide (not a draft) in content/blog (English) or content/blog/<locale>; the site links only to those. */
function guideLocales(drafts: boolean): string[] {
  const folder = fileURLToPath(new URL('content/blog/', import.meta.url));
  const published = (dir: string) =>
    readdirSync(folder + dir)
      .filter((file) => file.endsWith('.md'))
      .some((file) => drafts || !/^draft:\s*true\s*$/m.test(readFileSync(`${folder}${dir}${file}`, 'utf8')));
  const others = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return ['', ...others.map((name) => `${name}/`)].filter(published).map((dir) => dir.replace('/', '') || 'en');
}

export default defineConfig(({ command }) => ({
  ...pdfiumViteConfig,
  define: {
    // While developing the drafts show too.
    __GUIDES__: JSON.stringify(guideLocales(command === 'serve' || process.env.DRAFTS === '1')),
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
