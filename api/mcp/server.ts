// ═══════════════════════════════════════════════════════════════════
//  MCP SERVER FACTORY — one McpServer per session, tools from ./tools
// ═══════════════════════════════════════════════════════════════════
// For each registered McpTool:
//   1. Scope gate — ctx.scopes must include every requiredScope
//      (else JSON-RPC InvalidRequest, -32600).
//   2. Feature-flag gate (Phase 2, additive) — a tool declaring
//      `featureFlag` is only registered when isFeatureEnabled(flag,
//      ctx.userId) is true; otherwise it is hidden from tools/list and
//      tools/call for it fails as an unknown tool. Flag-check failures
//      fail CLOSED (tool hidden + warning logged).
//   3. Args are validated+parsed by the SDK against tool.inputSchema
//      (zod object schema; invalid input → McpError InvalidParams).
//   4. Result gets a readable Markdown preview plus exact structuredContent.
//   5. Every call is recorded in mcp_audit_log (latency + status) and
//      counted in usage_counters (metric "mcp_tool_call", period yyyymm).
//      Telemetry is fire-and-forget and never fails the tool call.
//
// SDK note (v1.29): registerTool accepts a full zod v4 object schema as
// inputSchema directly — no JSON-schema conversion needed. The SDK runs
// safeParseAsync on it and raises a clean InvalidParams error itself.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { mcpAuditLog, usageCounters } from "@db/schema";
import { usageCounters as sqliteUsageCounters } from "@db/schema.sqlite";
import { upsertOnUniqueKey } from "../lib/upsert";
import { logger } from "../lib/logger";
import { msg } from "../lib/messages";
import { isFeatureEnabled } from "../plugins/featureFlags";
import { ACTIVE_TOOLS } from "./tools/index";
import type { McpAuthContext, McpTool } from "./types";
import { renderToolResult } from "./renderResult";

const SERVER_NAME = "deewaanai-companion";
const SERVER_VERSION = "0.1.0";
const USAGE_METRIC = "mcp_tool_call";

type CallStatus = "ok" | "error" | "denied";

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Fire-and-forget telemetry: audit row + monthly usage counter. Never throws. */
function recordToolCall(
  auth: McpAuthContext,
  toolName: string,
  latencyMs: number,
  status: CallStatus,
  error: string | null,
): void {
  void (async () => {
    try {
      await getDb().insert(mcpAuditLog).values({
        userId: auth.userId,
        clientId: auth.clientId,
        toolName,
        latencyMs,
        status,
        error,
      });
    } catch (err) {
      logger.warn("MCP audit insert failed", { toolName, error: (err as Error).message });
    }
    try {
      await upsertOnUniqueKey({
        db: getDb(),
        mysqlTable: usageCounters,
        sqliteTable: sqliteUsageCounters,
        values: {
          subjectId: auth.userId,
          metric: USAGE_METRIC,
          period: currentPeriod(),
          count: 1,
        },
        conflictTarget: (t) => [t.subjectId, t.metric, t.period],
        set: (t) => ({ count: sql`${t.count} + 1` }),
      });
    } catch (err) {
      logger.warn("MCP usage counter increment failed", { toolName, error: (err as Error).message });
    }
  })();
}

function registerToolOnServer(server: McpServer, tool: McpTool, auth: McpAuthContext): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      // SDK 1.29 takes the zod object schema as-is (zod v4 classic extends
      // the v4 core $ZodType the SDK accepts) and validates input for us.
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    },
    async (args: unknown) => {
      const started = Date.now();
      let status: CallStatus = "ok";
      let errorText: string | null = null;
      try {
        const missing = tool.requiredScopes.filter((s) => !auth.scopes.has(s));
        if (missing.length > 0) {
          status = "denied";
          throw new McpError(
            ErrorCode.InvalidRequest,
            msg("mcp.errors.insufficientScope", auth.locale, {
              tool: tool.name,
              scopes: missing.join(", "),
            }),
          );
        }

        const result = await tool.handler(args, auth);
        return renderToolResult(tool.name, result);
      } catch (err) {
        if (status !== "denied") status = "error";
        errorText = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        recordToolCall(auth, tool.name, Date.now() - started, status, errorText);
      }
    },
  );
}

/**
 * Build a fresh McpServer bound to one authenticated session.
 * A new server per session keeps the protocol instance and the auth
 * context strictly scoped to that session's transport.
 *
 * Async because feature-flagged tools are resolved per session: flagged
 * tools are only registered when the flag is enabled for this user, so
 * they are hidden from tools/list and rejected as unknown tools.
 */
async function buildMcpServer(auth: McpAuthContext): Promise<McpServer> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Defensive: a broken tools module must not break app boot or the
  // MCP handshake — an empty tool list is a valid, debuggable state.
  const tools = Array.isArray(ACTIVE_TOOLS) ? ACTIVE_TOOLS : [];
  if (tools.length === 0) {
    logger.warn("MCP: no tools registered (tools/index missing or empty)");
  }
  let registered = 0;
  let hidden = 0;
  for (const tool of tools) {
    try {
      // Feature-flag gate (additive): unflagged tools are unaffected.
      if (tool.featureFlag) {
        let enabled = false;
        try {
          enabled = await isFeatureEnabled(tool.featureFlag, auth.userId);
        } catch (err) {
          // Fail closed: a flag-check error hides the tool, never exposes it.
          logger.warn("MCP: feature flag check failed, hiding tool", {
            toolName: tool.name,
            featureFlag: tool.featureFlag,
            error: (err as Error).message,
          });
        }
        if (!enabled) {
          hidden++;
          continue;
        }
      }
      registerToolOnServer(server, tool, auth);
      registered++;
    } catch (err) {
      logger.error("MCP: failed to register tool", {
        toolName: tool?.name,
        error: (err as Error).message,
      });
    }
  }

  logger.debug("MCP server created", {
    userId: auth.userId,
    clientId: auth.clientId,
    toolCount: registered,
    hiddenByFlag: hidden,
  });
  return server;
}

/**
 * A server factory result with the same connect() surface transport.ts
 * uses (`await createMcpServer(auth).connect(transport)`). The actual
 * McpServer is built — including async per-session feature-flag gating —
 * inside connect(), so callers keep a synchronous factory signature.
 * connect() resolves to the built McpServer so the transport can hold a
 * reference (session-scoped sampling bridge, Phase A).
 */
export interface DeferredMcpServer {
  connect(transport: Transport): Promise<McpServer>;
}

export function createMcpServer(auth: McpAuthContext): DeferredMcpServer {
  return {
    connect: async (transport: Transport) => {
      const server = await buildMcpServer(auth);
      await server.connect(transport);
      return server;
    },
  };
}
