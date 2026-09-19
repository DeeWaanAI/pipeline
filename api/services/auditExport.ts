// ═══════════════════════════════════════════════════════════════════
//  AUDIT EXPORT SERVICE — signed compliance ledger (Phase 3)
// ═══════════════════════════════════════════════════════════════════
// Builds the full workspace audit ledger (runs, approval decisions,
// entitlement/subscription changes, MCP audit log, OAuth client/token
// metadata) in bounded batches, signs it with HMAC-SHA256 over a
// canonical JSON serialization, and renders per-section CSV files.
//
// Hard rules:
//  - NEVER export prompt/output content, token hashes, or secrets.
//  - Queries are batched (LIMIT/OFFSET, <= 1000 rows/batch) so no
//    single unbounded SELECT runs against a table.

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { and, asc, gte, lte, type Column, type GetColumnData, type SQL } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  swarmRuns,
  approvalAssignments,
  entitlements,
  subscriptions,
  mcpAuditLog,
  oauthClients,
  oauthRefreshTokens,
  users,
} from "@db/schema";
import { env } from "../lib/env";
import type { RateLimitConfig } from "../lib/rateLimiter";

// ─── Rate limit (local config — generous admin budget) ──────────────
// Exports scan many tables, so keep them human-paced: 30/hour per admin.
export const AUDIT_EXPORT_RATE_LIMIT: RateLimitConfig = {
  maxTokens: 30,
  refillRate: 30 / 3600,
  windowMs: 3_600_000,
};

const BATCH_SIZE = 1000;

// ─── Ledger row types (JSON-serializable, no sensitive fields) ──────

interface LedgerRunRow {
  id: number;
  projectId: number;
  userId: number;
  status: string;
  currentStep: string | null;
  pipelineVersion: string | null;
  isTestRun: boolean | null;
  totalTokensUsed: number | null;
  totalLatencyMs: number | null;
  /** Derived error presence — swarm_runs has no error column. */
  hasError: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
  // NOTE: userPrompt, executionState content, and runParams are NOT exported.
}

interface LedgerApprovalRow {
  /** "assignment" = approval_assignments row, "decision" = run pendingApproval. */
  kind: "assignment" | "decision";
  id: number | null;
  swarmRunId: number;
  assigneeUserId: number | null;
  assignedBy: number | null;
  /** Assignment status, or the recorded decision action. */
  status: string;
  stepOrder: number | null;
  hasInstructions: boolean | null;
  createdAt: Date | null;
  completedAt: Date | null;
}

interface LedgerEntitlementRow {
  id: number;
  subjectType: string;
  subjectId: number;
  capability: string;
  source: string;
  sourceRef: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

interface LedgerSubscriptionRow {
  id: number;
  userId: number | null;
  teamId: number | null;
  plan: string;
  status: string;
  seats: number;
  currentPeriodEnd: Date | null;
  /** Stripe linkage recorded as booleans — raw Stripe IDs not exported. */
  hasStripeCustomer: boolean;
  hasStripeSubscription: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface LedgerMcpAuditRow {
  id: number;
  userId: number;
  clientId: string;
  toolName: string;
  latencyMs: number;
  status: string;
  /** Error text may contain sensitive detail — presence only. */
  hasError: boolean;
  createdAt: Date;
}

interface LedgerOAuthClientRow {
  id: number;
  clientId: string;
  clientName: string | null;
  redirectUris: string[] | null;
  createdAt: Date;
  // oauth_clients stores no secrets by design.
}

interface LedgerRefreshTokenRow {
  id: number;
  userId: number;
  clientId: string;
  scopes: string[] | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  // tokenHash is NEVER exported.
}

interface LedgerUserRow {
  id: number;
  username: string | null;
  email: string | null;
}

export type AuditLedgerSection =
  | "runs"
  | "approvals"
  | "entitlements"
  | "subscriptions"
  | "mcpAuditLog"
  | "oauthClients"
  | "oauthRefreshTokens"
  | "users";

export interface AuditLedger {
  version: 1;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  counts: Record<AuditLedgerSection, number>;
  sections: {
    runs: LedgerRunRow[];
    approvals: LedgerApprovalRow[];
    entitlements: LedgerEntitlementRow[];
    subscriptions: LedgerSubscriptionRow[];
    mcpAuditLog: LedgerMcpAuditRow[];
    oauthClients: LedgerOAuthClientRow[];
    oauthRefreshTokens: LedgerRefreshTokenRow[];
    users: LedgerUserRow[];
  };
}

export interface SignedLedger {
  payload: AuditLedger;
  signature: string;
  algorithm: "HMAC-SHA256";
  signedAt: string;
  keyId: LedgerKeyId;
}

export interface LedgerRange {
  from?: Date;
  to?: Date;
}

// ─── Batched fetch helper (bounded LIMIT/OFFSET pagination) ─────────

async function fetchBatched<T>(
  page: (limit: number, offset: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const batch = await page(BATCH_SIZE, offset);
    out.push(...batch);
    if (batch.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return out;
}

/** Build an optional created/started-at range predicate for a table column. */
function rangeWhere<TColumn extends Column>(
  col: TColumn,
  from?: Date,
  to?: Date,
): SQL | undefined {
  const conds: SQL[] = [];
  // Cast is safe: callers only pass timestamp columns (Date raw values).
  if (from) conds.push(gte(col, from as GetColumnData<TColumn, "raw">));
  if (to) conds.push(lte(col, to as GetColumnData<TColumn, "raw">));
  return conds.length > 0 ? and(...conds) : undefined;
}

// ─── Ledger builder ─────────────────────────────────────────────────

/**
 * Build the full audit ledger. All sections are fetched in batches of
 * <= 1000 rows, ordered by primary key for stable pagination. Rows with
 * a NULL timestamp column are excluded when a date range is given.
 */
export async function buildAuditLedger(range: LedgerRange = {}): Promise<AuditLedger> {
  const { from, to } = range;
  if (from && to && from.getTime() > to.getTime()) {
    throw new Error("Invalid date range: 'from' must be before 'to'.");
  }
  const db = getDb();

  // ── Runs (metadata only — no prompts/outputs) ──
  // Decisions from executionState.pendingApproval are extracted here too,
  // so the run rows only get scanned once.
  const runs: LedgerRunRow[] = [];
  const decisions: LedgerApprovalRow[] = [];
  await fetchBatched(async (limit, offset) => {
    const batch = await db
      .select({
        id: swarmRuns.id,
        projectId: swarmRuns.projectId,
        userId: swarmRuns.userId,
        status: swarmRuns.status,
        currentStep: swarmRuns.currentStep,
        pipelineVersion: swarmRuns.pipelineVersion,
        isTestRun: swarmRuns.isTestRun,
        totalTokensUsed: swarmRuns.totalTokensUsed,
        totalLatencyMs: swarmRuns.totalLatencyMs,
        startedAt: swarmRuns.startedAt,
        completedAt: swarmRuns.completedAt,
        pendingApproval: swarmRuns.executionState,
      })
      .from(swarmRuns)
      .where(rangeWhere(swarmRuns.startedAt, from, to))
      .orderBy(asc(swarmRuns.id))
      .limit(limit)
      .offset(offset);

    for (const r of batch) {
      runs.push({
        id: r.id,
        projectId: r.projectId,
        userId: r.userId,
        status: r.status,
        currentStep: r.currentStep,
        pipelineVersion: r.pipelineVersion,
        isTestRun: r.isTestRun,
        totalTokensUsed: r.totalTokensUsed,
        totalLatencyMs: r.totalLatencyMs,
        hasError: r.status === "failed",
        startedAt: r.startedAt,
        completedAt: r.completedAt,
      });
      const pa = r.pendingApproval?.pendingApproval;
      if (pa) {
        // Record decision metadata only — lastOutput content is NOT exported.
        decisions.push({
          kind: "decision",
          id: null,
          swarmRunId: r.id,
          assigneeUserId: null,
          assignedBy: null,
          status: pa.action ?? "pending",
          stepOrder: pa.stepOrder,
          hasInstructions: pa.instructions != null && pa.instructions !== "",
          createdAt: r.startedAt,
          completedAt: null,
        });
      }
    }
    return batch;
  });

  // ── Approval assignments (cross-app handoffs) ──
  const assignments = await fetchBatched((limit, offset) =>
    db
      .select({
        id: approvalAssignments.id,
        swarmRunId: approvalAssignments.swarmRunId,
        assigneeUserId: approvalAssignments.assigneeUserId,
        assignedBy: approvalAssignments.assignedBy,
        status: approvalAssignments.status,
        createdAt: approvalAssignments.createdAt,
        completedAt: approvalAssignments.completedAt,
      })
      .from(approvalAssignments)
      .where(rangeWhere(approvalAssignments.createdAt, from, to))
      .orderBy(asc(approvalAssignments.id))
      .limit(limit)
      .offset(offset),
  );

  const approvals: LedgerApprovalRow[] = [
    ...assignments.map((a) => ({
      kind: "assignment" as const,
      id: a.id,
      swarmRunId: a.swarmRunId,
      assigneeUserId: a.assigneeUserId,
      assignedBy: a.assignedBy,
      status: a.status,
      stepOrder: null,
      hasInstructions: null,
      createdAt: a.createdAt,
      completedAt: a.completedAt,
    })),
    ...decisions,
  ];

  // ── Entitlements (grants; expiry marks revocation) ──
  const entitlementRows = await fetchBatched((limit, offset) =>
    db
      .select({
        id: entitlements.id,
        subjectType: entitlements.subjectType,
        subjectId: entitlements.subjectId,
        capability: entitlements.capability,
        source: entitlements.source,
        sourceRef: entitlements.sourceRef,
        expiresAt: entitlements.expiresAt,
        createdAt: entitlements.createdAt,
      })
      .from(entitlements)
      .where(rangeWhere(entitlements.createdAt, from, to))
      .orderBy(asc(entitlements.id))
      .limit(limit)
      .offset(offset),
  );

  // ── Subscriptions (no raw Stripe IDs) ──
  const subscriptionRows = await fetchBatched(async (limit, offset) => {
    const batch = await db
      .select({
        id: subscriptions.id,
        userId: subscriptions.userId,
        teamId: subscriptions.teamId,
        plan: subscriptions.plan,
        status: subscriptions.status,
        seats: subscriptions.seats,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        stripeCustomerId: subscriptions.stripeCustomerId,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        createdAt: subscriptions.createdAt,
        updatedAt: subscriptions.updatedAt,
      })
      .from(subscriptions)
      .where(rangeWhere(subscriptions.createdAt, from, to))
      .orderBy(asc(subscriptions.id))
      .limit(limit)
      .offset(offset);
    return batch.map((s) => ({
      id: s.id,
      userId: s.userId,
      teamId: s.teamId,
      plan: s.plan,
      status: s.status,
      seats: s.seats,
      currentPeriodEnd: s.currentPeriodEnd,
      hasStripeCustomer: s.stripeCustomerId != null && s.stripeCustomerId !== "",
      hasStripeSubscription: s.stripeSubscriptionId != null && s.stripeSubscriptionId !== "",
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  });

  // ── MCP audit log (error presence only, no error text) ──
  const mcpRows = await fetchBatched(async (limit, offset) => {
    const batch = await db
      .select({
        id: mcpAuditLog.id,
        userId: mcpAuditLog.userId,
        clientId: mcpAuditLog.clientId,
        toolName: mcpAuditLog.toolName,
        latencyMs: mcpAuditLog.latencyMs,
        status: mcpAuditLog.status,
        error: mcpAuditLog.error,
        createdAt: mcpAuditLog.createdAt,
      })
      .from(mcpAuditLog)
      .where(rangeWhere(mcpAuditLog.createdAt, from, to))
      .orderBy(asc(mcpAuditLog.id))
      .limit(limit)
      .offset(offset);
    return batch.map((m) => ({
      id: m.id,
      userId: m.userId,
      clientId: m.clientId,
      toolName: m.toolName,
      latencyMs: m.latencyMs,
      status: m.status,
      hasError: m.error != null && m.error !== "",
      createdAt: m.createdAt,
    }));
  });

  // ── OAuth client registrations (no secrets exist on this table) ──
  const clientRows = await fetchBatched((limit, offset) =>
    db
      .select({
        id: oauthClients.id,
        clientId: oauthClients.clientId,
        clientName: oauthClients.clientName,
        redirectUris: oauthClients.redirectUris,
        createdAt: oauthClients.createdAt,
      })
      .from(oauthClients)
      .where(rangeWhere(oauthClients.createdAt, from, to))
      .orderBy(asc(oauthClients.id))
      .limit(limit)
      .offset(offset),
  );

  // ── Refresh-token metadata (NEVER the token hash) ──
  const refreshRows = await fetchBatched((limit, offset) =>
    db
      .select({
        id: oauthRefreshTokens.id,
        userId: oauthRefreshTokens.userId,
        clientId: oauthRefreshTokens.clientId,
        scopes: oauthRefreshTokens.scopes,
        expiresAt: oauthRefreshTokens.expiresAt,
        revokedAt: oauthRefreshTokens.revokedAt,
        createdAt: oauthRefreshTokens.createdAt,
      })
      .from(oauthRefreshTokens)
      .where(rangeWhere(oauthRefreshTokens.createdAt, from, to))
      .orderBy(asc(oauthRefreshTokens.id))
      .limit(limit)
      .offset(offset),
  );

  // ── Users (minimal identity: id/username/email only) ──
  const userRows = await fetchBatched((limit, offset) =>
    db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
      })
      .from(users)
      .where(rangeWhere(users.createdAt, from, to))
      .orderBy(asc(users.id))
      .limit(limit)
      .offset(offset),
  );

  const counts: Record<AuditLedgerSection, number> = {
    runs: runs.length,
    approvals: approvals.length,
    entitlements: entitlementRows.length,
    subscriptions: subscriptionRows.length,
    mcpAuditLog: mcpRows.length,
    oauthClients: clientRows.length,
    oauthRefreshTokens: refreshRows.length,
    users: userRows.length,
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    range: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
    },
    counts,
    sections: {
      runs,
      approvals,
      entitlements: entitlementRows,
      subscriptions: subscriptionRows,
      mcpAuditLog: mcpRows,
      oauthClients: clientRows,
      oauthRefreshTokens: refreshRows,
      users: userRows,
    },
  };
}

// ─── Canonical JSON + HMAC-SHA256 signing ───────────────────────────

/** Recursively sort object keys and normalize Dates for deterministic JSON. */
function sortValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Deterministic JSON: stable recursive key sort, ISO dates. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Signing key id — identifies which secret produced a signature. */
export type LedgerKeyId = "app-secret" | "audit-export-key";

/**
 * Signing key: SHA-256 of AUDIT_EXPORT_KEY when configured, else APP_SECRET
 * (legacy derivation, same as tokenService). The dedicated key lets operators
 * rotate APP_SECRET (which invalidates sessions) without breaking
 * verification of historical audit exports.
 */
function signingKey(): { key: Buffer; keyId: LedgerKeyId } {
  if (env.auditExportKey) {
    return { key: createHash("sha256").update(env.auditExportKey).digest(), keyId: "audit-export-key" };
  }
  return { key: createHash("sha256").update(env.appSecret).digest(), keyId: "app-secret" };
}

/** Resolve the key for a given keyId; null when that key isn't available. */
function keyForId(keyId: string): Buffer | null {
  if (keyId === "audit-export-key") {
    return env.auditExportKey ? createHash("sha256").update(env.auditExportKey).digest() : null;
  }
  if (keyId === "app-secret") {
    return createHash("sha256").update(env.appSecret).digest();
  }
  return null;
}

function hmacHex(payload: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(payload), "utf8").digest("hex");
}

/** Sign a ledger; the signature covers `payload` only (not signedAt). */
export function signLedger(ledger: AuditLedger): SignedLedger {
  const { key, keyId } = signingKey();
  return {
    payload: ledger,
    signature: hmacHex(ledger, key),
    algorithm: "HMAC-SHA256",
    signedAt: new Date().toISOString(),
    keyId,
  };
}

/**
 * Verify a signed ledger envelope (timing-safe comparison). Accepts both
 * keyIds so exports signed before an APP_SECRET rotation — or before the
 * dedicated AUDIT_EXPORT_KEY was configured — remain verifiable.
 */
export function verifyLedgerSignature(signed: SignedLedger): boolean {
  if (signed.algorithm !== "HMAC-SHA256") return false;
  const key = keyForId(signed.keyId);
  if (!key) return false;
  const expected = hmacHex(signed.payload, key);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signed.signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── CSV rendering ──────────────────────────────────────────────────

/** Stable CSV headers per section (emitted even when a section is empty). */
export const SECTION_CSV_HEADERS: Record<AuditLedgerSection, string[]> = {
  runs: [
    "id", "projectId", "userId", "status", "currentStep", "pipelineVersion",
    "isTestRun", "totalTokensUsed", "totalLatencyMs", "hasError",
    "startedAt", "completedAt",
  ],
  approvals: [
    "kind", "id", "swarmRunId", "assigneeUserId", "assignedBy", "status",
    "stepOrder", "hasInstructions", "createdAt", "completedAt",
  ],
  entitlements: [
    "id", "subjectType", "subjectId", "capability", "source", "sourceRef",
    "expiresAt", "createdAt",
  ],
  subscriptions: [
    "id", "userId", "teamId", "plan", "status", "seats", "currentPeriodEnd",
    "hasStripeCustomer", "hasStripeSubscription", "createdAt", "updatedAt",
  ],
  mcpAuditLog: [
    "id", "userId", "clientId", "toolName", "latencyMs", "status",
    "hasError", "createdAt",
  ],
  oauthClients: ["id", "clientId", "clientName", "redirectUris", "createdAt"],
  oauthRefreshTokens: [
    "id", "userId", "clientId", "scopes", "expiresAt", "revokedAt", "createdAt",
  ],
  users: ["id", "username", "email"],
};

function escapeCsvField(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "object") s = canonicalJson(value);
  else s = String(value);
  // RFC 4180 quoting: wrap fields containing comma, quote, or newline;
  // embedded double quotes are escaped by doubling.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Render rows as CSV with a header row. When `headers` is given it fixes
 * the column order (extra keys found in rows are appended, sorted).
 */
export function toCsv(rows: Record<string, unknown>[], headers?: string[]): string {
  const cols = headers ? [...headers] : [];
  const seen = new Set(cols);
  const extras = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) extras.add(key);
    }
  }
  if (!headers && rows.length > 0) {
    // No explicit headers: first-row key order, then extras sorted.
    cols.push(...Object.keys(rows[0]));
    for (const k of cols) seen.add(k);
    for (const k of [...extras].sort()) {
      if (!seen.has(k)) cols.push(k);
    }
  } else {
    for (const k of [...extras].sort()) cols.push(k);
  }
  if (cols.length === 0) return "";

  const lines = [cols.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCsvField(row[c])).join(","));
  }
  return lines.join("\r\n");
}

/** Render every ledger section as its own CSV string. */
export function ledgerToCsvFiles(ledger: AuditLedger): Record<AuditLedgerSection, string> {
  const files = {} as Record<AuditLedgerSection, string>;
  for (const section of Object.keys(ledger.sections) as AuditLedgerSection[]) {
    files[section] = toCsv(
      ledger.sections[section] as unknown as Record<string, unknown>[],
      SECTION_CSV_HEADERS[section],
    );
  }
  return files;
}
