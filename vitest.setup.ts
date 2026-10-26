// Deterministic test environment.
//
// `api/lib/env.ts` reads process.env at import time, and dotenv (loaded there)
// never overwrites a variable that is already set. Without this the unit suite
// depends on file order: a test that signs a token fails with "Zero-length key"
// unless some earlier file happened to assign APP_SECRET, and a developer's
// .env with an empty placeholder silently changes what the suite exercises.
//
// Only non-secret-grade defaults, and only when the value is missing or clearly a
// placeholder. Integration harnesses set their own DATABASE_URL and keys in
// beforeAll, before importing the app, so they still win.
const defaults: Record<string, string> = {
  APP_ID: "vitest",
  APP_SECRET: "1".repeat(64),
  AI_SWARM_MASTER_KEY: "2".repeat(64),
  MARKETPLACE_MASTER_KEY: "3".repeat(64),
};

for (const [key, value] of Object.entries(defaults)) {
  const current = process.env[key];
  if (!current || current.length < 16) process.env[key] = value;
}
