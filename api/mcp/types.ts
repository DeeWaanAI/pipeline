// ═══════════════════════════════════════════════════════════════════
//  MCP SHARED CONTRACT — types consumed by tools/* (worker B),
//  auth.ts (worker C), and server/transport/context/register (worker A).
//  Do not change without coordinating all three workers.
// ═══════════════════════════════════════════════════════════════════

import type { ZodType } from "zod";

export interface McpAuthContext {
  userId: number;
  scopes: Set<string>;
  clientId: string;
  requestId: string;
  locale: "en" | "zh";
  /**
   * Per-session runtime bridge (additive, Phase A sampling spike).
   * Filled by transport.ts after the session initializes: lets tools reach
   * back through the live MCP session — e.g. issue sampling/createMessage
   * requests to the connected desktop client. Undefined before init and in
   * non-session contexts.
   */
  runtime?: {
    sessionId?: string;
    /** Throws Error("SAMPLING_UNSUPPORTED") when the client lacks the capability. */
    sample?: (params: unknown) => Promise<unknown>;
    /** Cheap probe: did the connected client advertise MCP sampling? (No request issued.)
     *  A function because client capabilities only exist AFTER the initialize
     *  handshake — evaluating eagerly at connect time would always be false. */
    samplingSupported?: () => boolean;
  };
}

export interface McpTool {
  name: string;                       // permanent snake_case
  description: string;
  inputSchema: ZodType;               // zod object schema
  requiredScopes: string[];           // e.g. ["mcp:run"]
  // Phase 2 (additive): when set, the server only registers this tool for
  // sessions where isFeatureEnabled(featureFlag, ctx.userId) is true —
  // hidden from tools/list and unreachable by tools/call otherwise.
  featureFlag?: string;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  handler: (args: unknown, ctx: McpAuthContext) => Promise<unknown>; // JSON-serializable
}
