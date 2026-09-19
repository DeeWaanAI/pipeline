import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { LANGUAGES, NAMESPACES, SUPPORTED_LANG_CODES } from "./i18n-languages";

// Build resources from the centralized language config
const resources: Resource = Object.fromEntries(
  LANGUAGES.map((lang) => [lang.code, lang.namespaces])
) as Resource;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANG_CODES,
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
    ns: NAMESPACES,
    defaultNS: "common",
  });
