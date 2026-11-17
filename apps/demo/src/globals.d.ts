/** Set by vite.config.ts: the languages with published guides (with drafts too while developing); the site links only to those. */
declare const __GUIDES__: import('./i18n').Locale[];

/** Tact's site script (index.html), when it has loaded. */
interface Window {
  tact?: (event: 'signup') => void;
}
