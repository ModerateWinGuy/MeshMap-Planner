import { createI18n } from 'vue-i18n';
import { detectLocale, SUPPORTED_LOCALES, type LocaleCode } from './detectLocale.ts';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import sv from './locales/sv.json';
import pl from './locales/pl.json';
import nb from './locales/nb.json';

const STORAGE_KEY = 'locale';

// i18n has to exist (with the right locale) before main.ts mounts the app, i.e. before Pinia and
// the store exist — so read the persisted choice directly rather than waiting for the store's
// useLocalStorage field (which uses the same key and will agree with this on first read).
function storedLocale(): LocaleCode | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return SUPPORTED_LOCALES.some((l) => l.code === parsed) ? (parsed as LocaleCode) : null;
  } catch {
    return null;
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: storedLocale() ?? detectLocale(),
  fallbackLocale: 'en',
  messages: { en, es, fr, de, sv, pl, nb },
});

export { SUPPORTED_LOCALES, type LocaleCode };
