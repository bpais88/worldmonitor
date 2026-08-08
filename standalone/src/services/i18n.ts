// Clean-room i18n shim for the standalone freight app.
//
// The freight page renders English and uses this module only for initI18n() (entry
// bootstrap) and getLocale() (number/date formatting in ferry-format). The full
// worldmonitor i18n stack (i18next + translation catalogs) is upstream-licensed and
// unused here, so this is a minimal, dependency-free implementation of the same
// interface. Adding real localization later means growing THIS module, not importing theirs.

export const LANGUAGES = [{ code: 'en', name: 'English' }] as const;

let currentLanguage = 'en';

export async function initI18n(): Promise<void> {
  try {
    const nav = navigator.language || 'en';
    currentLanguage = nav.split('-')[0] || 'en';
  } catch {
    currentLanguage = 'en';
  }
}

/** English-only: keys pass through. Interpolates {{var}} from options when given. */
export function t(key: string, options?: Record<string, unknown>): string {
  if (!options) return key;
  return key.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    name in options ? String(options[name]) : `{{${name}}}`,
  );
}

export async function changeLanguage(lng: string): Promise<void> {
  currentLanguage = lng;
}

export function getCurrentLanguage(): string {
  return currentLanguage;
}

export function isRTL(): boolean {
  return false;
}

/** BCP-47 locale for Intl formatting — the browser's own, defaulting sensibly. */
export function getLocale(): string {
  try {
    return navigator.language || 'en-GB';
  } catch {
    return 'en-GB';
  }
}
