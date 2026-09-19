// ─── Placeholders — replace HERE ONLY (WEBSITE-SPEC.md §9) ───────────
// Do not invent values. When the owner supplies one, change it in this
// file and nowhere else.
export const SITE = {
  companyLegalName: "Mug and Beyond Ltd",
  siteDomain: "deewaanai.com",         // also settable via PUBLIC_SITE_DOMAIN (astro.config)
  appDomain: "app.deewaanai.com",
  discordUrl: "https://discord.gg/nuRKGEEVdE",
  xUrl: "https://x.com/DeeWaanAI",
  githubUrl: "{{GITHUB_URL}}",
  fallbackEmail: "hello@deewaanai.com",
} as const;

/** MCP server URL shown on /connect and in docs. */
export const MCP_URL = `https://${SITE.appDomain}/mcp`;

/** Waitlist API base (Wave W backend). Build-time public env; when missing,
 *  the form renders its disabled state with the fallback email. */
export const WAITLIST_API_URL: string | undefined = import.meta.env.PUBLIC_WAITLIST_API_URL;

/** DeeWaanAI™ legal line shared by footer + legal pages. */
export const TRADEMARK_LINE =
  `DeeWaanAI is a trading name of Mug and Beyond Ltd, registered in England and Wales (Company No. 14916888). Registered office: 20 Wenlock Road, London N1 7GU, United Kingdom.`;
