// MCP tools: take a shared pipeline off the platform, and bring one home.
//
// These two are the reason sharing is worth anything: the recipient ends up with
// a file they own, in a folder they chose, running in the desktop app they
// already use — not a loan from our database. Verification is offline by design;
// see api/services/pipelineBundle.ts for what each refusal protects.

import type { McpTool } from "../types";
import { exportOwnPipelineBundle, exportPipelineBundleInputSchema, importPipelineBundleInputSchema, importPipelineBundle } from "../../services/pipelineDelivery";
import { z } from "zod";

export const importPipelineBundleTool: McpTool = {
  name: "import_pipeline_bundle",
  description:
    "Import a DeeWaanAI pipeline bundle file into your own account: it becomes a project you own and can edit, with a template and a first immutable version, attributed to whoever originally made it. The bundle is verified before anything is written — the steps must hash to the declared definition hash, and the evidence attestation must verify against the platform's signing key and name this exact listing and version. An intact but unsigned bundle still imports, because it is somebody's own work, but the answer says plainly that its benchmark claim is unproven. Read `verification.evidenceState` and `meaning` out to the user.",
  inputSchema: importPipelineBundleInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = importPipelineBundleInputSchema.parse(args);
    return importPipelineBundle(ctx.userId, input);
  },
};

const ExportOwnSchema = z.object({
  projectId: z.number().int().positive(),
  benchmarkId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

export const exportPipelineBundleTool: McpTool = {
  name: "export_pipeline_bundle",
  description:
    "Export one of YOUR OWN pipelines as a portable file you can send to anyone — the local-first sharing step that needs no server, no listing and no payment. Optional `benchmarkId` attaches that benchmark's full archive (plan, cases, inputs, outputs, judgments, judging prompts) inside the same file, and the file's signature covers both, so pipeline and evidence travel together and cannot be swapped independently. No benchmark is required: without one the file simply carries no scores. Hand the returned object to the client's filesystem tools as JSON; the recipient imports it with import_pipeline_bundle.",
  inputSchema: exportPipelineBundleInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const input = exportPipelineBundleInputSchema.parse(args);
    return exportOwnPipelineBundle(ctx.userId, input);
  },
};

export const PIPELINE_BUNDLE_TOOLS: McpTool[] = [
  exportPipelineBundleTool,
  importPipelineBundleTool,
];
