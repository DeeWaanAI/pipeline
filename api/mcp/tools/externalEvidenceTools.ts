import type { McpTool } from "../types";
import {
  previewExternalInputSchema, reportExternalInputSchema, getExternalInputSchema, listExternalInputSchema,
  previewExternal, reportExternal, getExternal, listExternal, withdrawExternalInputSchema, withdrawExternal,
} from "../../services/externalEvidenceService";

export const previewExternalEvidenceTool: McpTool = {
  name: "preview_external_evidence",
  description: "Preview an external community report without writing or running anything. All declared inputs, outputs, model, date and rubric remain user-reported and not independently verified. Only public v2 listings and their current sold version are accepted. No attachments or fetched URLs. Returns the exact disclosure, consent version, hash and secret findings.",
  inputSchema: previewExternalInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => ({
    ...await previewExternal(ctx.userId, args),
    next: "Nothing is public yet. Show the user the complete report and obtain explicit consent before calling report_external_evidence with the same content, consentVersion, previewHash and publishConsent=true. Secret findings must be resolved first.",
  }),
};

export const reportExternalEvidenceTool: McpTool = {
  name: "report_external_evidence",
  description: "Publish the exact previewed external community report after explicit user consent. Requires previewHash, consentVersion and publishConsent=true. Refuses secrets, stale hashes and unavailable listing/version pairs. Stores only user declarations: no benchmark, execution, judgment, score, attestation or seller certification is created.",
  inputSchema: reportExternalInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: false },
  handler: (args, ctx) => reportExternal(ctx.userId, args),
};

export const getExternalEvidenceTool: McpTool = {
  name: "get_external_evidence",
  description: "Read a user-reported external community report for a public v2 listing. The report is not independently verified; declaredDate is author-supplied text and reportedAt is only the submission time, never a platform test time. Returns no private workflow definition or attachments.",
  inputSchema: getExternalInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: (args) => getExternal(args),
};

export const listExternalEvidenceTool: McpTool = {
  name: "list_external_evidence",
  description: "List external community reports for a public v2 listing, newest report first. Every report is user-reported and not independently verified, separate from seller evidence. Use the last reportId as beforeId for the next page. Unavailable listings return an empty list.",
  inputSchema: listExternalInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: (args) => listExternal(args),
};

export const withdrawExternalEvidenceTool: McpTool = {
  name: "withdraw_external_evidence",
  description: "Withdraw your own external community report from public reads. Author-only and idempotent; retains the report and durable consent proof without deleting or republishing anything. Available even when publication is disabled or the listing is no longer public.",
  inputSchema: withdrawExternalInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: (args, ctx) => withdrawExternal(ctx.userId, args),
};

export const EXTERNAL_EVIDENCE_TOOLS: McpTool[] = [
  previewExternalEvidenceTool,
  reportExternalEvidenceTool,
  getExternalEvidenceTool,
  listExternalEvidenceTool,
  withdrawExternalEvidenceTool,
];
