import { createContext, useContext, type ReactNode } from 'react';
import { load } from '../reload';
import { en, type Messages } from './en';

export type { LandingText, Messages } from './en';

/** English lives at the root; the others under their code: /de, /nb, /sv, /uk. */
export const LOCALES = ['en', 'de', 'nb', 'sv', 'uk'] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language's name in itself, for the switcher. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  nb: 'Norsk',
  sv: 'Svenska',
  uk: 'Українська',
};
/** Offered on an English page to someone whose browser prefers another of our languages, in that language. */
export const SUGGEST: Record<Locale, string> = {
  en: 'This page is also in English.',
  de: 'Diese Seite gibt es auch auf Deutsch.',
  nb: 'Denne siden finnes også på norsk.',
  sv: 'Den här sidan finns även på svenska.',
  uk: 'Ця сторінка є також українською.',
};
/** For og:locale. */
export const REGIONS: Record<Locale, string> = { en: 'en_US', de: 'de_DE', nb: 'nb_NO', sv: 'sv_SE', uk: 'uk_UA' };

export const localePrefix = (locale: Locale) => (locale === 'en' ? '' : `/${locale}`);

export function localeOfPath(path: string): Locale {
  const first = path.split('/')[1] ?? '';
  return (LOCALES as readonly string[]).includes(first) && first !== 'en' ? (first as Locale) : 'en';
}

/** The browser's preferred language among ours ("no" and "nn" read as Norwegian Bokmål). */
export function browserLocale(): Locale | null {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const code = tag.toLowerCase().split('-')[0]!;
    const locale = code === 'no' || code === 'nn' ? 'nb' : code;
    if ((LOCALES as readonly string[]).includes(locale)) return locale as Locale;
  }
  return null;
}

/** Only the page's language is downloaded. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  switch (locale) {
    case 'de':
      return (await load(() => import('./de'))).de;
    case 'nb':
      return (await load(() => import('./nb'))).nb;
    case 'sv':
      return (await load(() => import('./sv'))).sv;
    case 'uk':
      return (await load(() => import('./uk'))).uk;
    default:
      return en;
  }
}

const I18n = createContext<{ locale: Locale; t: Messages }>({ locale: 'en', t: en });

export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: ReactNode }) {
  return <I18n.Provider value={{ locale, t: messages }}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);
