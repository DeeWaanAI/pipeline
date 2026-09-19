// ─── Locale registry (WEBSITE-SPEC.md §5.5) ──────────────────────────
// Adding a language = add its code here (and in astro.config via this array)
// + content files under src/content/{docs,blog}/<locale>/ + ui/<locale>.json.
// No component/layout changes — everything reads from this module.

export const LOCALES = ["en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/** URL prefix for a locale (default locale is unprefixed). */
export function localePrefix(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? "" : `/${locale}`;
}

/** BCP-47-ish tag for og:locale / hreflang. */
export function localeTag(locale: Locale): string {
  return locale === "en" ? "en_US" : locale;
}

/** True when more than one locale is configured (drives the switcher). */
export const MULTI_LOCALE = LOCALES.length > 1;
