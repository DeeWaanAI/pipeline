// MCP tool: sample_ping — Phase A spike. Sends a minimal sampling request
// through the live session to the connected desktop client's own LLM and
// reports what came back: whether the client supports sampling at all,
// which model answered, latency, and the reply text. Feature-flagged
// (mcp_sampling) — this tool exists to validate the sampling path before
// the auto designer runs on it.

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";

const inputSchema = z.object({});

interface CreateMessageResultLike {
  model?: string;
  stopReason?: string;
  role?: string;
  content?: { type?: string; text?: string };
}

export const samplePing: McpTool = {
  name: "sample_ping",
  description:
    "Diagnostic: ask the connected desktop app's own LLM to reply (MCP sampling). Reports whether your app supports sampling, the model used, and the reply — no API key involved.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  featureFlag: "mcp_sampling",
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    if (!ctx.runtime?.sample) {
      return { supported: false, reason: "no live session bridge (connect via the MCP endpoint)" };
    }
    const started = Date.now();
    try {
      const res = (await ctx.runtime.sample({
        messages: [
          { role: "user", content: { type: "text", text: "Reply with exactly the word: PONG" } },
        ],
        maxTokens: 16,
      })) as CreateMessageResultLike;
      return {
        supported: true,
        model: res.model ?? null,
        stopReason: res.stopReason ?? null,
        text: res.content?.text ?? null,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("SAMPLING_UNSUPPORTED")) {
        return { supported: false, reason: "client did not advertise the sampling capability" };
      }
      return { supported: false, reason: message, latencyMs: Date.now() - started };
    }
  },
};
