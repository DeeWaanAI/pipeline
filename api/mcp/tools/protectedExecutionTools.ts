// MCP tools: protected marketplace execution (offering redesign v2, spec §8.1–
// §8.3). D9 means a buyer must be able to run what they bought from a desktop
// app — but only through the SAME service the web uses, so entitlement
// resolution, the trusted-endpoint policy and the buyer-only projection cannot
// be bypassed. Nothing here can return a seller prompt.

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import {
  getProtectedRunView, resolveProtectedExecutionRight, startProtectedRun,
} from "../../services/marketplaceExecutionService";

const startInputSchema = z.object({
  listingId: z.number().int().positive().describe("A v2 listing you are entitled to run"),
  input: z.string().min(1).max(200000).describe("The text you would send this pipeline"),
  providerId: z.number().int().positive().describe("ONE OF YOUR OWN enabled providers — you pay for your own calls"),
  purpose: z.enum(["buyer_execution", "trial"]).default("buyer_execution"),
  idempotencyKey: z.string().min(1).max(120).optional().describe("Retry with the same key returns the run it already made — nothing is billed twice"),
});

export const startProtectedRunTool: McpTool = {
  name: "start_protected_run",
  description:
    "Run a purchased v2 listing server-side WITHOUT ever receiving its definition. The seller's immutable published version is loaded inside a restricted context: no seller prompts, files, memory, repo tokens or tools are reachable, the buyer's own approved provider is the only billable route, and the endpoint must be on the approved list. Returns immediately with a run id and the protection class + provider logging disclosure that applies to it — read them, an approved provider may still log your requests.",
  inputSchema: startInputSchema,
  requiredScopes: ["mcp:run"],
  featureFlag: "v2ProtectedExecution",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = startInputSchema.parse(args);
    return startProtectedRun({
      buyerId: ctx.userId, listingId: input.listingId, input: input.input,
      providerId: input.providerId, purpose: input.purpose, idempotencyKey: input.idempotencyKey,
    });
  },
};

const statusInputSchema = z.object({ swarmRunId: z.number().int().positive() });

export const protectedRunStatusTool: McpTool = {
  name: "protected_run_status",
  description:
    "The buyer's view of a protected run: status, per-step progress METADATA (step number, name, role, state, tokens, latency), totals, the final output when complete, and the error text when it fails. Step prompt/context columns are deliberately not part of this projection.",
  inputSchema: statusInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2ProtectedExecution",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { swarmRunId } = statusInputSchema.parse(args);
    const view = await getProtectedRunView({ buyerId: ctx.userId, swarmRunId });
    if (!view) throw new Error("not_found_or_not_authorized");
    return view;
  },
};

const rightInputSchema = z.object({ listingId: z.number().int().positive() });

export const marketplaceExecutionRightTool: McpTool = {
  name: "marketplace_execution_right",
  description:
    "Whether you may run a listing, which workflow version that entitles you to (an old purchase cannot keep running a superseded version), how the right was obtained, when it expires, and which evidence hash currently backs it.",
  inputSchema: rightInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2ProtectedExecution",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { listingId } = rightInputSchema.parse(args);
    const right = await resolveProtectedExecutionRight({ buyerId: ctx.userId, listingId, purpose: "buyer_execution" });
    return {
      listingId: right.listing.id,
      title: right.listing.title,
      entitled: true,
      viaGrant: !!right.grant,
      grantExpiresAt: right.grant?.expiresAt ?? null,
      soldWorkflowVersionId: right.soldVersionId,
      note: "The definition itself is not part of any buyer-facing response by design (§8.1).",
    };
  },
};

export const PROTECTED_EXECUTION_TOOLS: McpTool[] = [
  startProtectedRunTool,
  marketplaceExecutionRightTool,
  protectedRunStatusTool,
];
