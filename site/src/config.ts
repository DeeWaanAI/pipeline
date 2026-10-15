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

/** Local MCP URL shown on /connect and in docs. DeeWaanAI runs on the
 *  user's own computer — there is no hosted MCP endpoint to advertise. */
export const LOCAL_MCP_URL = "http://localhost:3000/mcp";

/** DeeWaanAI™ legal line shared by footer + legal pages. */
export const TRADEMARK_LINE =
  `DeeWaanAI is a trading name of Mug and Beyond Ltd, registered in England and Wales (Company No. 14916888). Registered office: 20 Wenlock Road, London N1 7GU, United Kingdom.`;
