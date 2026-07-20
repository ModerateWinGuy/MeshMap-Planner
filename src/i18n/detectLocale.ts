export const SUPPORTED_LOCALES = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'sv', name: 'Svenska', flag: '🇸🇪' },
  { code: 'pl', name: 'Polski', flag: '🇵🇱' },
  { code: 'nb', name: 'Norsk', flag: '🇳🇴' },
] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]['code'];

const CODES: readonly string[] = SUPPORTED_LOCALES.map((l) => l.code);

// Norwegian ships two written forms; only Bokmål (nb) is bundled, so the generic 'no' tag and
// Nynorsk ('nn') both map to it rather than falling through to English.
const ALIASES: Record<string, LocaleCode> = { no: 'nb', nn: 'nb' };

export function detectLocale(languages: readonly string[] = navigator.languages ?? [navigator.language]): LocaleCode {
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if (ALIASES[base]) return ALIASES[base];
    if (CODES.includes(base)) return base as LocaleCode;
  }
  return 'en';
}
