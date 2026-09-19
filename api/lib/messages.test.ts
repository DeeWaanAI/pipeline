// Pure-function tests for server-side i18n (api/lib/messages.ts).
// Covers: dot-path lookup, locale fallback chain (requested → en → key),
// {{param}} interpolation, and Accept-Language / user-pref resolution.
// No DB/network: bundles are static JSON imports.

import { describe, it, expect } from "vitest";
import { msg, resolveLocale } from "./messages";

describe("msg", () => {
  it("resolves a top-level key in English", () => {
    expect(msg("unauthenticated", "en")).toBe("Authentication required");
  });

  it("resolves a nested dot-path key in Chinese", () => {
    expect(msg("mcp.errors.insufficientScope", "zh", { tool: "run_pipeline", scopes: "mcp:run" })).toBe(
      "工具 run_pipeline 权限不足：需要 mcp:run",
    );
  });

  it("interpolates {{param}} placeholders (tolerant of inner whitespace)", () => {
    expect(msg("mcp.errors.insufficientScope", "en", { tool: "t", scopes: "s" })).toBe(
      "Insufficient scope for tool t: requires s",
    );
  });

  it("leaves unmatched placeholders verbatim", () => {
    expect(msg("mcp.errors.insufficientScope", "en", { tool: "t" })).toBe(
      "Insufficient scope for tool t: requires {{scopes}}",
    );
  });

  it("falls back to English when the locale bundle lacks the locale", () => {
    // "fr" is not a bundled locale — requested → en fallback.
    expect(msg("unauthenticated", "fr")).toBe("Authentication required");
  });

  it("returns the key itself when no bundle has it", () => {
    expect(msg("no.such.key", "en")).toBe("no.such.key");
    expect(msg("no.such.key", "zh")).toBe("no.such.key");
  });
});

describe("resolveLocale", () => {
  const headers = (acceptLanguage?: string) =>
    new Headers(acceptLanguage ? { "accept-language": acceptLanguage } : {});

  it("prefers an explicit user preference over the header", () => {
    expect(resolveLocale(headers("en-US"), { locale: "zh-CN" })).toBe("zh");
    expect(resolveLocale(headers("zh-CN"), { locale: "en-GB" })).toBe("en");
  });

  it("maps any zh* preference to zh and en* to en", () => {
    expect(resolveLocale(headers(), { locale: "zh-TW" })).toBe("zh");
    expect(resolveLocale(headers(), { locale: "ZH" })).toBe("zh");
    expect(resolveLocale(headers(), { locale: "EN-us" })).toBe("en");
  });

  it("ignores unsupported preferences and consults Accept-Language", () => {
    expect(resolveLocale(headers("fr-FR"), { locale: "de" })).toBe("en");
    expect(resolveLocale(headers("fr-FR,zh;q=0.8"), { locale: "de" })).toBe("zh");
  });

  it("reads Accept-Language when no preference is set", () => {
    expect(resolveLocale(headers("zh-CN,zh;q=0.9,en;q=0.8"))).toBe("zh");
    expect(resolveLocale(headers("en-US,en;q=0.9"))).toBe("en");
  });

  it("defaults to en with no signals", () => {
    expect(resolveLocale(headers())).toBe("en");
    expect(resolveLocale(headers(), {})).toBe("en");
    expect(resolveLocale(headers(), { locale: null })).toBe("en");
  });
});
