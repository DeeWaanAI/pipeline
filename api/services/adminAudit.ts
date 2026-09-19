// Persistent admin audit trail.
//
// Every privileged mutation (role/tier/flag/SSO/feedback/cert-ops) writes one
// row here. Railway logs are ephemeral; this table is the durable record of
// who changed what, when, and from where.
//
// Fail-open by design: an audit write failure must never break the admin
// action itself — it is logged as an error instead.
import { getDb } from "../queries/connection";
import { adminAuditLog } from "@db/schema";
import { logger } from "../lib/logger";

export interface AdminAuditEntry {
  adminUserId: number;
  /** Stable dotted action name, e.g. "user.set_role", "sso.upsert_connection". */
  action: string;
  targetType?: string;
  targetId?: string | number | null;
  /** Small JSON-serializable context — never secrets, keys, or prompt content. */
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export async function logAdminAction(entry: AdminAuditEntry): Promise<void> {
  try {
    await getDb().insert(adminAuditLog).values({
      adminUserId: entry.adminUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId != null ? String(entry.targetId) : null,
      detail: entry.detail ?? null,
      ip: entry.ip ?? null,
    });
  } catch (err) {
    logger.error("Admin audit write failed", {
      action: entry.action,
      error: (err as Error).message,
    });
  }
}
