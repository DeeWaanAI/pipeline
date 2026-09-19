// Deterministic Marketplace Security Scan (Trust spec §0.2)
// Pure, network-free checks over a listing's visible metadata, generated
// test prompts, and (in-memory decrypted) secret prompts. This is the only
// ungameable safety gate: it must pass before a listing is ever visible.
//
// SECURITY INVARIANTS:
//  - Decrypted secret prompt plaintext is NEVER logged, returned, or stored.
//    Findings contain short codes + the FIELD LABEL only — never content.
//  - Fail closed: anything that cannot be scanned is a finding, not a pass.
//  - This service does NOT mutate listing status; the caller (router) does.

import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { encryptedPrompts, marketplaceListings, testPrompts } from "@db/schema";
import { decryptPrompt } from "../lib/marketplaceCrypto";
import { logger } from "../lib/logger";

export interface SecurityScanResult {
  ok: boolean;
  findings: string[];
}

// ─── Pure string checkers (unit-testable without a DB) ───────────────
// Every checker takes (text, fieldLabel) and returns findings in the form
// "<code>: <human text mentioning only the field label>". The offending
// content itself is never included.

// ─── (a) Unicode hygiene ─────────────────────────────────────────────
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/;
const BIDI_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/;
// C0 controls except \t \n \r, plus DEL and C1 controls.
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function hasMixedScriptRun(text: string): boolean {
  // Split into word-ish tokens; flag a token that mixes Latin letters with
  // Cyrillic or Greek letters (classic homoglyph spoofing, e.g. "pаypal").
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const token of tokens) {
    const hasLatin = /\p{Script=Latin}/u.test(token);
    const hasCyrillicOrGreek = /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(token);
    if (hasLatin && hasCyrillicOrGreek) return true;
  }
  return false;
}

export function checkUnicodeHygiene(text: string, field = "text"): string[] {
  const findings: string[] = [];
  // NFKC first so compatibility lookalikes fold before inspection.
  const normalized = text.normalize("NFKC");
  if (ZERO_WIDTH_RE.test(normalized)) {
    findings.push(`unicode.zero-width: zero-width characters detected in ${field}`);
  }
  if (BIDI_OVERRIDE_RE.test(normalized)) {
    findings.push(`unicode.bidi-override: bidi/RTL override characters detected in ${field}`);
  }
  if (CONTROL_CHAR_RE.test(normalized)) {
    findings.push(`unicode.control-char: disallowed C0/C1 control characters detected in ${field}`);
  }
  if (hasMixedScriptRun(normalized)) {
    findings.push(`unicode.mixed-script: mixed-script (possible homoglyph) run detected in ${field}`);
  }
  return findings;
}

// ─── (b) Injection payloads (case-insensitive) ───────────────────────
const INJECTION_PATTERNS: Array<{ code: string; re: RegExp; label: string }> = [
  {
    code: "injection.ignore-instructions",
    re: /\bignore\s+(?:(?:the|all|any)\s+)*(?:previous|above)\s+instructions?\b/i,
    label: "'ignore previous/above instructions' payload",
  },
  {
    code: "injection.disregard",
    re: /\bdisregard\s+(?:all|prior)\b/i,
    label: "'disregard all/prior' payload",
  },
  {
    code: "injection.role-override",
    re: /\byou\s+are\s+now\b/i,
    label: "'you are now' role-override payload",
  },
  {
    code: "injection.system-prompt",
    re: /\bsystem\s+prompt\b/i,
    label: "'system prompt' reference (possible prompt-extraction attempt)",
  },
];

export function checkInjectionPhrases(text: string, field = "text"): string[] {
  const findings: string[] = [];
  for (const { code, re, label } of INJECTION_PATTERNS) {
    if (re.test(text)) {
      findings.push(`${code}: ${label} detected in ${field}`);
    }
  }
  return findings;
}

// ─── (c) Exfiltration ────────────────────────────────────────────────
const EXFIL_SEND_TO_URL_RE =
  /\b(?:send|post|upload|transmit|forward|ship)\b[^.!?\n]{0,120}?\bto\s+https?:\/\//i;
const EXFIL_EMAIL_RE = /\bemail\s+(?:this|these|the|it)\b[^.!?\n]{0,60}?\bto\b/i;
const IMPERATIVE_VERB_RE =
  /\b(?:send|post|upload|email|transmit|forward|exfiltrate|leak|curl|wget|fetch)\b/i;
const URL_GLOBAL_RE = /https?:\/\//gi;

function hasUrlWithImperativeNearby(text: string): boolean {
  const WINDOW = 160;
  URL_GLOBAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_GLOBAL_RE.exec(text)) !== null) {
    const start = Math.max(0, m.index - WINDOW);
    const end = Math.min(text.length, m.index + WINDOW);
    if (IMPERATIVE_VERB_RE.test(text.slice(start, end))) return true;
  }
  return false;
}

export function checkExfiltration(text: string, field = "text"): string[] {
  const findings: string[] = [];
  if (EXFIL_SEND_TO_URL_RE.test(text)) {
    findings.push(`exfil.send-to-url: 'send/POST/upload … to http(s)://' exfiltration pattern in ${field}`);
  }
  if (EXFIL_EMAIL_RE.test(text)) {
    findings.push(`exfil.email: 'email this/the … to' exfiltration pattern in ${field}`);
  }
  if (hasUrlWithImperativeNearby(text)) {
    findings.push(`exfil.url-imperative: outbound URL combined with an imperative verb in ${field}`);
  }
  return findings;
}

// ─── (d) Secrets / abuse ─────────────────────────────────────────────
const API_KEY_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI-style
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bAIza[0-9A-Za-z_-]{20,}\b/, // Google API key
  /\b(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{12,}/i, // key=value dumps
];
const BASE64_BLOB_RE = /\b[A-Za-z0-9+/]{512,}={0,2}\b/;
const EMAIL_GLOBAL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CREDIT_CARD_GLOBAL_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** Luhn checksum — real card numbers pass; git blob hashes / random digit runs do not. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Git diff blob-hash lines ("index 1111111..2222222 100644") produce 13-digit
// runs that sometimes even pass Luhn — strip them before card detection.
const GIT_INDEX_LINE_RE = /^index [0-9a-f]+\.\.[0-9a-f]+ \d{6}\s*$/gim;

function hasPaymentCardNumber(text: string): boolean {
  const sanitized = text.replace(GIT_INDEX_LINE_RE, " ");
  CREDIT_CARD_GLOBAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREDIT_CARD_GLOBAL_RE.exec(sanitized)) !== null) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

export function checkSecretsAndAbuse(text: string, field = "text"): string[] {
  const findings: string[] = [];
  for (const re of API_KEY_RES) {
    if (re.test(text)) {
      findings.push(`secrets.api-key: API-key-shaped string detected in ${field}`);
      break; // one finding per field is enough
    }
  }
  if (BASE64_BLOB_RE.test(text)) {
    findings.push(`secrets.base64-blob: base64 blob longer than 512 characters detected in ${field}`);
  }
  const emails = text.match(EMAIL_GLOBAL_RE);
  if (emails && emails.length >= 3) {
    findings.push(`secrets.pii-dump: ${emails.length} email addresses (possible PII dump) in ${field}`);
  }
  if (hasPaymentCardNumber(text)) {
    findings.push(`secrets.pii-payment-card: payment-card-shaped number detected in ${field}`);
  }
  return findings;
}

/**
 * Run all checkers over a single string. Returns findings as
 * "<code>: <human text>" entries; an empty array means clean.
 */
export function scanText(text: string, field = "text"): string[] {
  if (!text) return [];
  return [
    ...checkUnicodeHygiene(text, field),
    ...checkInjectionPhrases(text, field),
    ...checkExfiltration(text, field),
    ...checkSecretsAndAbuse(text, field),
  ];
}

// ─── DB-loading wrapper (spec §0.2) ──────────────────────────────────

/**
 * Scan a marketplace listing before it becomes visible.
 *
 * Inputs scanned:
 *  - decrypted `encryptedPrompts` (decrypted IN MEMORY via marketplaceCrypto;
 *    plaintext is never logged, returned, or persisted),
 *  - every `testPrompts.inputText` for the listing,
 *  - title / description / objectives / inputFormat / outputFormat / remarks.
 *
 * Returns findings only — the CALLER decides status changes and persists
 * findings (prefixed `[SECURITY]`) in the router layer.
 */
export async function scanListingSecurity(listingId: number): Promise<SecurityScanResult> {
  const findings: string[] = [];
  const db = getDb();

  const [listing] = await db
    .select()
    .from(marketplaceListings)
    .where(eq(marketplaceListings.id, listingId));

  if (!listing) {
    // Fail closed: an unscannable listing is not OK.
    return { ok: false, findings: ["scan.listing-not-found: listing does not exist"] };
  }

  // 1) Visible metadata fields
  const metadataFields: Array<[string, string | null]> = [
    ["title", listing.title],
    ["description", listing.description],
    ["objectives", listing.objectives],
    ["inputFormat", listing.inputFormat],
    ["outputFormat", listing.outputFormat],
    ["remarks", listing.remarks],
  ];
  for (const [label, value] of metadataFields) {
    if (value) findings.push(...scanText(value, label));
  }

  // 2) Generated test prompt inputs
  const prompts = await db
    .select()
    .from(testPrompts)
    .where(eq(testPrompts.listingId, listingId));
  for (const p of prompts) {
    findings.push(...scanText(p.inputText, `testPrompts[${p.promptIndex}]`));
  }

  // 3) Secret prompts — decrypt in memory, scan, discard. Plaintext NEVER
  // appears in findings, logs, or return values.
  const encPrompts = await db
    .select()
    .from(encryptedPrompts)
    .where(eq(encryptedPrompts.listingId, listingId));
  for (const ep of encPrompts) {
    let plaintext: string;
    try {
      plaintext = decryptPrompt(ep.encryptedPrompt, listingId);
    } catch (err) {
      // Fail closed: an undecryptable prompt cannot be scanned → finding.
      logger.error("Security scan could not decrypt a prompt (fail-closed)", {
        listingId,
        agentIndex: ep.agentIndex,
        error: (err as Error).message,
      });
      findings.push(
        `scan.decrypt-failure: encrypted prompt at agentIndex ${ep.agentIndex} could not be decrypted for scanning`,
      );
      continue;
    }
    findings.push(...scanText(plaintext, `prompt[${ep.agentIndex}]`));
    plaintext = ""; // drop the reference promptly
  }

  if (findings.length > 0) {
    // Log codes + field labels only — never content.
    logger.warn("Marketplace security scan found issues", {
      listingId,
      count: findings.length,
      codes: findings.map((f) => f.split(":")[0]),
    });
  } else {
    logger.info("Marketplace security scan passed", { listingId });
  }

  return { ok: findings.length === 0, findings };
}
