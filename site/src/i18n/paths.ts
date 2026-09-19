// Static path helper (SPEC §5.5): every page lives under
// src/pages/[...locale]/ and exports localeStaticPaths() as its
// getStaticPaths. The default locale renders at the UNPREFIXED url
// (rest param undefined); other locales render at /<locale>/...
// Adding a language = LOCALES entry + content files. Nothing else.
import { LOCALES, DEFAULT_LOCALE } from "./locales";

export function localeStaticPaths() {
  return LOCALES.map((locale) => ({
    params: { locale: locale === DEFAULT_LOCALE ? undefined : locale },
  }));
}
