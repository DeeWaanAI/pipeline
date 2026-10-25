/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEATURE FLAG SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides runtime checks for feature flags. Used by:
 * - Plugin registry to determine which plugins are active
 * - UI to conditionally render plugin components
 * - Backend to gate plugin routes
 *
 * Checks in order:
 *   1. If flag is fully enabled → allow all
 *   2. If rolloutPercent > 0 → allow by userId hash
 *   3. If allowedUserIds set → allow if userId in list
 *   4. Otherwise → deny
 */

import { getDb } from "../queries/connection";
import { featureFlags } from "@db/schema";
import { eq } from "drizzle-orm";

// In-memory cache (refreshed every 60s)
let cache: Map<string, { enabled: boolean; rollout: number; allowed: number[] }> | null = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

async function loadFlags(): Promise<Map<string, { enabled: boolean; rollout: number; allowed: number[] }>> {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  const db = getDb();
  const rows = await db.select().from(featureFlags);

  const map = new Map<string, { enabled: boolean; rollout: number; allowed: number[] }>();
  for (const row of rows) {
    map.set(row.key, {
      enabled: row.enabled,
      rollout: row.rolloutPercent || 0,
      allowed: row.allowedUserIds || [],
    });
  }

  cache = map;
  cacheTime = now;
  return map;
}

/**
 * Check if a feature is enabled for a user.
 */
export async function isFeatureEnabled(flagKey: string, userId?: number): Promise<boolean> {
  const flags = await loadFlags();
  const flag = flags.get(flagKey);
  return evaluateFlag(flag, userId);
}

/**
 * Drop the in-process flag cache so the next check re-reads the table. The
 * 60s TTL is fine for a UI toggle but makes "enable, then assert behaviour"
 * undeterministic for callers that must know the gate applied — notably the
 * integration drills for the v2 phase flags.
 */
export function resetFlagCache(): void {
  cache = null;
  cacheTime = 0;
}

/**
 * Pure flag-evaluation helper (extracted for unit testing).
 * Does NOT touch the database — caller must pass the resolved flag config.
 */
export function evaluateFlag(
  flag: { enabled: boolean; rollout: number; allowed: number[] } | undefined,
  userId?: number,
): boolean {
  if (!flag) return false;
  if (flag.enabled) return true;
  if (flag.rollout > 0 && userId) {
    const hash = hashUserId(userId, "teamsync"); // salt is flag key in practice
    return hash <= flag.rollout;
  }
  if (userId && flag.allowed.includes(userId)) return true;
  return false;
}

/**
 * Get all feature flags (for admin UI).
 */
export async function getAllFlags() {
  const db = getDb();
  return db.select().from(featureFlags);
}

/**
 * Seed default feature flags on first boot.
 * Call this from boot.ts if needed.
 */
export async function seedDefaultFlags() {
  const db = getDb();
  const defaults = [
    { key: "circuit_breaker", name: "Circuit Breaker", description: "Pipeline safety limits", enabled: true, rolloutPercent: 100 },
    { key: "local_folder", name: "Local Folder Access", description: "Link local project folders via File System Access API", enabled: true, rolloutPercent: 100 },
    // Research Mode (Phase 0): batch runs + pipeline chaining. Default OFF.
    { key: "batch_mode", name: "Research Mode — Batch Runs", description: "Run up to 100 pipeline inputs in parallel", enabled: false, rolloutPercent: 0 },
    { key: "pipeline_chaining", name: "Research Mode — Pipeline Chaining", description: "Chain pipeline outputs into evaluation pipelines", enabled: false, rolloutPercent: 0 },
    // Offering redesign v2 (OFFERING-REDESIGN-TECH-SPECS.md §13 G1). All
    // default OFF: additive schema exists but no v2 entry point activates
    // until its phase gate passes. v2Commercial stays OFF until the spec's
    // open policy register (P1–P7) is resolved by the owner.
    { key: "v2DesignJobs", name: "V2 — Durable Design Jobs", description: "Auto-design as durable queued jobs with revision-safe apply", enabled: true, rolloutPercent: 100 },
    { key: "v2Benchmarks", name: "V2 — Private Evaluation", description: "Benchmark workspace: grade-only and optional comparisons", enabled: true, rolloutPercent: 100 },
    { key: "v2Publication", name: "V2 — Evidence Publication", description: "Transparency-manifest publishing for sellers and community", enabled: false, rolloutPercent: 0 },
    { key: "v2ProtectedExecution", name: "V2 — Protected Marketplace Execution", description: "Server-side buyer runs of protected workflow versions", enabled: false, rolloutPercent: 0 },
    { key: "v2Commercial", name: "V2 — Commercial Features", description: "Subscription/payouts/trials — blocked pending P1–P7 policy approval", enabled: false, rolloutPercent: 0 },
  ];

  for (const def of defaults) {
    const existing = await db.select().from(featureFlags).where(eq(featureFlags.key, def.key)).limit(1);
    if (existing.length === 0) {
      await db.insert(featureFlags).values(def);
    }
  }
}

// Simple deterministic hash for rollout percentage
function hashUserId(userId: number, salt: string): number {
  let hash = 0;
  const str = `${userId}:${salt}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash) % 101; // 0-100
}
