// UI string loader with English fallback (SPEC §5.5: layouts receive
// strings, never contain them; a missing translation falls back to EN and
// the page shows a "not yet translated" note — never a 404).
// Bundles are auto-discovered via import.meta.glob: dropping
// src/content/ui/<locale>.json into place is the ONLY step needed —
// no edits here (proven by the xx-locale DoD test).
import en from "../content/ui/en.json";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export type UiStrings = typeof en;

const modules = import.meta.glob("../content/ui/*.json", { eager: true }) as Record<
  string,
  { default: UiStrings }
>;

const BUNDLES: Record<string, UiStrings> = {};
for (const [path, mod] of Object.entries(modules)) {
  const code = path.match(/\/([^/]+)\.json$/)?.[1];
  if (code) BUNDLES[code] = mod.default ?? (mod as unknown as UiStrings);
}

export function getUiStrings(locale: Locale): { strings: UiStrings; translated: boolean } {
  const bundle = BUNDLES[locale];
  if (bundle) return { strings: bundle, translated: true };
  return { strings: BUNDLES[DEFAULT_LOCALE]!, translated: false };
}
