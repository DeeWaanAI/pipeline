// ═══════════════════════════════════════════════════════════════════
//  MESSAGES — server-side i18n lookup (F0)
// ═══════════════════════════════════════════════════════════════════
// Dot-path lookup over the static locale bundles with {{param}}
// interpolation and a fallback chain: requested locale → en → the key.
// Bundles live in api/locales/{en,zh}/server.json.

import en from "../locales/en/server.json";
import zh from "../locales/zh/server.json";

const bundles: Record<string, unknown> = { en, zh };

/** Resolve a dot-path key against one locale bundle. Returns undefined when absent. */
function lookup(key: string, locale: string): string | undefined {
  const bundle = bundles[locale];
  if (bundle === null || typeof bundle !== "object") return undefined;
  let node: unknown = bundle;
  for (const part of key.split(".")) {
    if (node !== null && typeof node === "object" && part in node) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * Translate a dot-path key for a locale, interpolating {{param}} placeholders.
 * Fallback chain: requested locale → en → the key itself.
 */
export function msg(key: string, locale: string, params?: Record<string, string>): string {
  const template = lookup(key, locale) ?? lookup(key, "en") ?? key;
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match,
  );
}

/**
 * Resolve the effective locale: explicit user preference first, then the
 * Accept-Language header (any "zh" → zh), defaulting to "en".
 */
export function resolveLocale(
  reqHeaders: Headers,
  userPrefs?: { locale?: string | null },
): "en" | "zh" {
  const pref = userPrefs?.locale?.toLowerCase();
  if (pref) {
    if (pref.startsWith("zh")) return "zh";
    if (pref.startsWith("en")) return "en";
  }
  const accept = reqHeaders.get("accept-language")?.toLowerCase() ?? "";
  if (accept.includes("zh")) return "zh";
  return "en";
}
