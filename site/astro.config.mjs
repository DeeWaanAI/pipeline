// @ts-check
import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import { LOCALES, DEFAULT_LOCALE } from "./src/i18n/locales.ts";

// Canonical origin — set PUBLIC_SITE_DOMAIN in the environment (Railway) to
// the real domain. The placeholder default keeps {{SITE_DOMAIN}} unreplaced
// until the owner supplies the value (see src/config.ts). `||` (not `??`):
// Docker ARG→ENV produces an empty string when the build arg is unset.
const site = process.env.PUBLIC_SITE_DOMAIN || "https://{{SITE_DOMAIN}}";

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "never",
  i18n: {
    defaultLocale: DEFAULT_LOCALE,
    // Adding a language = add its code here + content files. Nothing else.
    locales: [...LOCALES],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    tailwind(),
    sitemap({
      i18n: {
        defaultLocale: DEFAULT_LOCALE,
        locales: Object.fromEntries(LOCALES.map((l) => [l, l])),
      },
    }),
  ],
});
