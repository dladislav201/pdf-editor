import type { OpenRequest } from './Home';
import { LOCALES, localePrefix, localeOfPath, type Locale } from './i18n';

/**
 * The site's name and address, used in titles, canonical links, the sitemap
 * and structured data. Change them here once the product has its own name
 * and domain.
 */
export const SITE = {
  name: 'Private PDF Editor',
  url: 'https://lovelydoc.com',
};

/** Pages people can land on from a search: the start page and one per tool. Their words are in i18n/<locale>.ts. */
export const LANDING_IDS = [
  'home',
  'editText',
  'editScan',
  'ocr',
  'sign',
  'fillForm',
  'annotate',
  'compress',
  'merge',
  'split',
  'rotate',
  'deletePages',
  'pdfToJpg',
  'jpgToPdf',
] as const;
export type LandingId = (typeof LANDING_IDS)[number];

/** What "Choose a PDF" does on each page, and whether it takes pictures instead. */
export const LANDING_TOOLS: Record<LandingId, { open?: Omit<OpenRequest, 'file'>; pictures?: boolean }> = {
  home: {},
  editText: { open: { tool: 'editText' } },
  editScan: { open: { tool: 'editText', recognize: true } },
  ocr: { open: { recognize: true } },
  sign: { open: { sign: true } },
  fillForm: { open: { tool: 'select' } },
  annotate: { open: { tool: 'highlight' } },
  compress: { open: { dialog: 'compress' } },
  merge: { open: { pages: true } },
  split: { open: { pages: true } },
  rotate: { open: { pages: true } },
  deletePages: { open: { pages: true } },
  pdfToJpg: { open: { dialog: 'images' } },
  jpgToPdf: { pictures: true },
};

/** Each page's address in each language, in the words people search with there. */
const SLUGS: Record<Exclude<LandingId, 'home'>, Record<Locale, string>> = {
  editText: { en: 'edit-pdf-text', de: 'pdf-text-bearbeiten', nb: 'rediger-pdf-tekst', sv: 'redigera-pdf-text', uk: 'redaguvaty-tekst-pdf' },
  editScan: {
    en: 'edit-scanned-pdf',
    de: 'gescanntes-pdf-bearbeiten',
    nb: 'rediger-skannet-pdf',
    sv: 'redigera-skannad-pdf',
    uk: 'redaguvaty-skanovanyi-pdf',
  },
  ocr: { en: 'ocr-pdf', de: 'pdf-durchsuchbar-machen', nb: 'gjor-pdf-sokbar', sv: 'gor-pdf-sokbar', uk: 'rozpiznaty-tekst-pdf' },
  sign: { en: 'sign-pdf', de: 'pdf-unterschreiben', nb: 'signer-pdf', sv: 'signera-pdf', uk: 'pidpysaty-pdf' },
  fillForm: { en: 'fill-pdf-form', de: 'pdf-formular-ausfuellen', nb: 'fyll-ut-pdf-skjema', sv: 'fyll-i-pdf-formular', uk: 'zapovnyty-pdf-formu' },
  annotate: { en: 'annotate-pdf', de: 'pdf-kommentieren', nb: 'kommenter-pdf', sv: 'kommentera-pdf', uk: 'anotuvaty-pdf' },
  compress: { en: 'compress-pdf', de: 'pdf-komprimieren', nb: 'komprimer-pdf', sv: 'komprimera-pdf', uk: 'stysnuty-pdf' },
  merge: { en: 'merge-pdf', de: 'pdf-zusammenfuegen', nb: 'sla-sammen-pdf', sv: 'sla-ihop-pdf', uk: 'obiednaty-pdf' },
  split: { en: 'split-pdf', de: 'pdf-teilen', nb: 'del-pdf', sv: 'dela-pdf', uk: 'rozdilyty-pdf' },
  rotate: { en: 'rotate-pdf', de: 'pdf-drehen', nb: 'roter-pdf', sv: 'rotera-pdf', uk: 'povernuty-pdf' },
  deletePages: {
    en: 'delete-pdf-pages',
    de: 'pdf-seiten-loeschen',
    nb: 'slett-pdf-sider',
    sv: 'ta-bort-pdf-sidor',
    uk: 'vydalyty-storinky-pdf',
  },
  pdfToJpg: { en: 'pdf-to-jpg', de: 'pdf-in-jpg', nb: 'pdf-til-jpg', sv: 'pdf-till-jpg', uk: 'pdf-v-jpg' },
  jpgToPdf: { en: 'jpg-to-pdf', de: 'jpg-in-pdf', nb: 'jpg-til-pdf', sv: 'jpg-till-pdf', uk: 'jpg-v-pdf' },
};

/** A page's address in a language, e.g. ("compress", "de") → "/de/pdf-komprimieren". */
export function landingPath(id: LandingId, locale: Locale): string {
  const path = localePrefix(locale) + (id === 'home' ? '' : `/${SLUGS[id][locale]}`);
  return path || '/';
}

/** Which page an address is (in which language); undefined for anything else. */
export function routeOf(path: string): { id: LandingId; locale: Locale } | undefined {
  const clean = path.replace(/\/+$/, '') || '/';
  const locale = localeOfPath(clean);
  const id = LANDING_IDS.find((landing) => landingPath(landing, locale) === clean);
  return id ? { id, locale } : undefined;
}

/** Every page in every language, for the build. */
export const ALL_PAGES = LOCALES.flatMap((locale) => LANDING_IDS.map((id) => ({ id, locale, path: landingPath(id, locale) })));
