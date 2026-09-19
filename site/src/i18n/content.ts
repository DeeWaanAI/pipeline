// Locale-scoped content resolution with English fallback (SPEC §5.5):
// entries are addressed as "<locale>/<slug>"; a page whose translation is
// missing in the current locale renders the EN entry and reports
// translated=false (Base shows the "not yet translated" note — never a 404).
import { getCollection, type CollectionEntry } from "astro:content";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export interface Localized<T> {
  slug: string;
  entry: T;
  translated: boolean;
}

function splitId(id: string): { loc: string; slug: string } {
  // The glob loader collapses index files: "en/index.md" → id "en".
  const sep = id.indexOf("/");
  return sep === -1
    ? { loc: id, slug: "index" }
    : { loc: id.slice(0, sep), slug: id.slice(sep + 1) };
}

function pickLocale<T extends { id: string }>(entries: T[], locale: Locale): Localized<T>[] {
  const bySlug = new Map<string, Localized<T>>();
  for (const e of entries) {
    const { loc, slug } = splitId(e.id);
    if (loc === locale) bySlug.set(slug, { slug, entry: e, translated: true });
  }
  for (const e of entries) {
    const { loc, slug } = splitId(e.id);
    if (loc === DEFAULT_LOCALE && !bySlug.has(slug)) {
      bySlug.set(slug, { slug, entry: e, translated: false });
    }
  }
  return [...bySlug.values()];
}

export function docsForLocale(locale: Locale): Promise<Localized<CollectionEntry<"docs">>[]> {
  return getCollection("docs").then((all) => pickLocale(all, locale));
}

export function blogForLocale(locale: Locale): Promise<Localized<CollectionEntry<"blog">>[]> {
  return getCollection("blog").then((all) => pickLocale(all, locale));
}
