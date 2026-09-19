/**
 * Language configuration — single source of truth for available languages.
 *
 * To add a new language:
 *   1. Create `src/locales/<code>/` with all namespace JSON files
 *   2. Add an entry below with the code, label, and namespace imports
 *   3. Done — i18n.ts and LanguageSwitcher.tsx read from this config automatically
 */

import enCommon from "./locales/en/common.json";
import enLogin from "./locales/en/login.json";
import enDashboard from "./locales/en/dashboard.json";
import enWorkspace from "./locales/en/workspace.json";
import enSettings from "./locales/en/settings.json";
import enAudit from "./locales/en/audit.json";
import enAgents from "./locales/en/agents.json";
import enPipeline from "./locales/en/pipeline.json";
import enPages from "./locales/en/pages.json";
import enConnect from "./locales/en/connect.json";
import enMcp from "./locales/en/mcp.json";
import enCertification from "./locales/en/certification.json";
import enPricing from "./locales/en/pricing.json";
import enTeamsync from "./locales/en/teamsync.json";

import zhCommon from "./locales/zh/common.json";
import zhLogin from "./locales/zh/login.json";
import zhDashboard from "./locales/zh/dashboard.json";
import zhWorkspace from "./locales/zh/workspace.json";
import zhSettings from "./locales/zh/settings.json";
import zhAudit from "./locales/zh/audit.json";
import zhAgents from "./locales/zh/agents.json";
import zhPipeline from "./locales/zh/pipeline.json";
import zhPages from "./locales/zh/pages.json";
import zhConnect from "./locales/zh/connect.json";
import zhMcp from "./locales/zh/mcp.json";
import zhCertification from "./locales/zh/certification.json";
import zhPricing from "./locales/zh/pricing.json";
import zhTeamsync from "./locales/zh/teamsync.json";

export interface LanguageConfig {
  /** ISO 639-1 language code */
  code: string;
  /** Native display name shown in the language switcher */
  label: string;
  /** Namespace translations */
  namespaces: Record<string, unknown>;
}

export const LANGUAGES: LanguageConfig[] = [
  {
    code: "en",
    label: "English",
    namespaces: {
      common: enCommon,
      login: enLogin,
      dashboard: enDashboard,
      workspace: enWorkspace,
      settings: enSettings,
      audit: enAudit,
      agents: enAgents,
      pipeline: enPipeline,
      pages: enPages,
      connect: enConnect,
      mcp: enMcp,
      certification: enCertification,
      pricing: enPricing,
      teamsync: enTeamsync,
    },
  },
  {
    code: "zh",
    label: "中文",
    namespaces: {
      common: zhCommon,
      login: zhLogin,
      dashboard: zhDashboard,
      workspace: zhWorkspace,
      settings: zhSettings,
      audit: zhAudit,
      agents: zhAgents,
      pipeline: zhPipeline,
      pages: zhPages,
      connect: zhConnect,
      mcp: zhMcp,
      certification: zhCertification,
      pricing: zhPricing,
      teamsync: zhTeamsync,
    },
  },
  // To add a new language (e.g. Japanese):
  // {
  //   code: "ja",
  //   label: "日本語",
  //   namespaces: {
  //     common: jaCommon,
  //     login: jaLogin,
  //     ...
  //   },
  // },
];

/** All namespace names — derived from the first language's keys */
export const NAMESPACES = Object.keys(LANGUAGES[0].namespaces);

/** All supported language codes */
export const SUPPORTED_LANG_CODES = LANGUAGES.map((l) => l.code);
