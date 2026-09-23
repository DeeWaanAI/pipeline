// MCP tools: D14 deliver-then-sweep, for the chat client that owns the folder.
//
// The owner's decision puts the file write in the user's chat client ("option
// 1"), which makes the workbench the surface that actually performs the storage
// promise: the client calls `deliver_work_data`, writes the bundle into the
// folder the user chose with its own file tools, and only then may call
// `sweep_delivered_work` with the receipt. A chat client without file tools can
// still deliver, and is told so, but cannot honestly complete the sweep step —
// which is why the refusal text names the receipt rather than hiding it.
//
// Everything that matters lives in `api/services/dataDelivery.ts`: scope
// resolution, per-row ownership, the protected/shared-run refusals, the signed
// receipt and the never-swept census. These three handlers pass a user id and
// nothing else, so the web app and the workbench cannot have different answers
// about what "your data" includes or what may be deleted.

import type { McpTool } from "../types";
import {
  deliverWorkData, deliverWorkDataInputSchema, previewDeliveryScope,
  sweepDeliveredData, sweepDeliveredDataInputSchema,
} from "../../services/dataDelivery";

export const previewDeliveryScopeTool: McpTool = {
  name: "preview_work_delivery",
  description:
    "Show what a delivery of your own work data WOULD contain — project and run counts, the step-output volume, the bundle hash, and any runs deliberately excluded (a marketplace buyer run or a pipeline shared to you belongs to another account's interest, so it is never carried or cleared). Writes nothing and hands over no content; use it to size the folder before the user commits to a write.",
  inputSchema: deliverWorkDataInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const input = deliverWorkDataInputSchema.parse(args);
    return previewDeliveryScope(ctx.userId, input);
  },
};

export const deliverWorkDataTool: McpTool = {
  name: "deliver_work_data",
  description:
    "Hand over ONE complete bundle of this account's own work data (projects, runs, step prompts and outputs, private benchmark cases, judgments and rationales) with a sha256 over it, plus the signed receipt a later sweep must present. Execution stays server-side and your chat client writes the folder the user chose — there is no upload and no background job. Delivering unchanged data returns the same hash, so a client can tell it already wrote these bytes.",
  inputSchema: deliverWorkDataInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const input = deliverWorkDataInputSchema.parse(args);
    const bundle = await deliverWorkData(ctx.userId, input);
    return {
      ...bundle,
      meaning:
        "This is the copy the platform holds of your own work. Nothing has been deleted: the server keeps it until you sweep it, and the sweep only accepts the receipt returned here.",
      next:
        "Write `bundle` to the folder the user chose with your file tools, verify the sha256 if you can, then call sweep_delivered_work with this receipt — and only after the files are actually on their device.",
    };
  },
};

export const sweepDeliveredWorkTool: McpTool = {
  name: "sweep_delivered_work",
  description:
    "Clear the server's copy of work data that was already delivered. Needs the receipt from deliver_work_data AND the exact confirmation phrase, and it re-derives the bundle from the database before deleting: if anything was added or edited since delivery it refuses with bundle_changed rather than destroying a copy the user does not hold. Content is nulled, structure is not — rows keep their ids, timestamps, token counts and cost ledger, so published versions, evidence, purchases, execution rights, spend approvals and consent records stay exactly as they were. Runs belonging to another account (a buyer run, a shared pipeline) are refused outright.",
  inputSchema: sweepDeliveredDataInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = sweepDeliveredDataInputSchema.parse(args);
    const receipt = await sweepDeliveredData(ctx.userId, input);
    return {
      ...receipt,
      meaning:
        "The server no longer holds the content in this scope; the rows and every financial and evidentiary record remain. Re-delivering now returns the swept placeholders, which is the point — your device holds the work.",
    };
  },
};

export const DATA_DELIVERY_TOOLS: McpTool[] = [
  previewDeliveryScopeTool,
  deliverWorkDataTool,
  sweepDeliveredWorkTool,
];
