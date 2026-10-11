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

/** Waitlist API base (Wave W backend).
 *
 *  `PUBLIC_WAITLIST_API_URL` overrides it. When that build variable is absent
 *  the form used to render a disabled "join by email" paragraph — so a Railway
 *  rebuild that forgot the variable silently stopped writing signup rows to
 *  `waitlist_entries` and left the addresses in a mailbox nobody had been
 *  told to check. The app origin the /connect page and the docs already
 *  advertise is a better default: a wrong default still shows the visitor a
 *  working mail fallback (see WaitlistSection), while a missing form shows
 *  them nothing.
 */
const configuredWaitlistApi = String(import.meta.env.PUBLIC_WAITLIST_API_URL ?? "").trim();
export const WAITLIST_API_URL: string =
  configuredWaitlistApi || `https://${SITE.appDomain}`;

/** DeeWaanAI™ legal line shared by footer + legal pages. */
export const TRADEMARK_LINE =
  `DeeWaanAI is a trading name of Mug and Beyond Ltd, registered in England and Wales (Company No. 14916888). Registered office: 20 Wenlock Road, London N1 7GU, United Kingdom.`;
