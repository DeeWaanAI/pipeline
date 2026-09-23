// MCP tool: send feedback WITH the object it is about (D11, ticket #22).
//
// D9 made the workbench a primary interface, so "I want to tell you that THIS
// run is broken" has to be answerable from chat — a description of a symptom
// with nothing attached behind it is the bug report support cannot act on.
//
// This file deliberately contains NO logic of its own: it is an adapter over
// `api/services/feedbackAttachments.ts`, which is the single place that decides
// what a consented attachment may hold. So the two rules a caller cannot get
// round from here are the same two the web form is held to:
//   * nothing is attached without an explicit per-item consent, and the stored
//     receipt records WHICH consent text was agreed to;
//   * the snapshot is built from the projections THIS account can already read,
//     so attaching a `run_only` shared run or a marketplace buyer run carries
//     the redacted view that run's owner sees — never the grantor's or the
//     seller's prompts, model bindings or credentials (spec A12).
//
// Not feature-flagged: it is a plain account-scoped write, gated by auth and by
// ownership alone. Adding a flag here would have to be mirrored in the help
// guide, and `registry.test.ts` / `helpContent.test.ts` pin that a flag the
// guide shows as locked is one the server enforces — so an unnecessary flag is
// a false promise, not a free safety margin.

import type { McpTool } from "../types";
import { DEFAULT_CONSENT_VERSION } from "../../services/evidenceService";
import {
  MAX_ATTACHMENTS_PER_FEEDBACK, feedbackSubmitInputSchema, submitFeedbackWithAttachments,
} from "../../services/feedbackAttachments";

export const sendFeedbackTool: McpTool = {
  name: "send_feedback",
  description:
    `Send feedback to the DeeWaanAI team about a specific pipeline, run or benchmark, and attach THAT object so support can see what you saw. Pass attachments[] as { kind: pipeline|run|benchmark, refId, consent: true } — ONE EXPLICIT OPT-IN PER ITEM: nothing is harvested automatically, consent is required on that one object (an unticked or unseen item refuses the whole submission and writes nothing), and the receipt stores the consent version (currently ${DEFAULT_CONSENT_VERSION}). Find the ids with list_pipelines (a pipeline is a project id), run_status/run_pipeline (a run id) or list_benchmarks (a benchmark id). The attached snapshot is exactly what YOUR account can already read: for a pipeline someone shared with you as run_only, or a marketplace workflow you bought, that means the redacted view you already get — their prompts, model bindings and keys are never copied into it. Up to ${MAX_ATTACHMENTS_PER_FEEDBACK} items per submission.`,
  inputSchema: feedbackSubmitInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = feedbackSubmitInputSchema.parse(args);
    const result = await submitFeedbackWithAttachments(ctx.userId, input);
    return {
      ...result,
      meaning: result.attachments.length === 0
        ? "Feedback recorded with no attachments — nothing was collected about your objects, which is the default."
        : `Feedback recorded with ${result.attachments.length} consented attachment(s). Each one is a frozen copy of what your own account can read, and the row records that you opted in on it under ${DEFAULT_CONSENT_VERSION}.`,
      attachmentsWithMeaning: result.attachments.map((a) => ({
        ...a,
        redacted: a.visibility !== "owner_full",
        note: a.visibility === "owner_full"
          ? "A full copy of what your own account can read for this object."
          : "Redacted: this object belongs to another account and you were entitled to run it, not to read it, so the snapshot is the same withheld view your own status read gives.",
      })),
    };
  },
};

export const FEEDBACK_TOOLS = [sendFeedbackTool];
