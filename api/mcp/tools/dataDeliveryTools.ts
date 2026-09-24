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
  sweepDeliveredData, sweepDeliveredDataInputSchema, WORK_DATA_RETENTION,
} from "../../services/dataDelivery";

export const previewDeliveryScopeTool: McpTool = {
  name: "preview_work_delivery",
  description:
    `Show delivery scope, counts, hash, excluded runs, and the retention notice before confirmation. Writes nothing and hands over no content. ${WORK_DATA_RETENTION.notice}`,
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
    `Hand over the selected sweepable work data with its sha256 and signed receipt. Execution stays server-side; your chat client writes the folder the user chose and verifies the saved bundle before sweeping. Delivering unchanged data returns the same hash. ${WORK_DATA_RETENTION.notice}`,
  inputSchema: deliverWorkDataInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const input = deliverWorkDataInputSchema.parse(args);
    const bundle = await deliverWorkData(ctx.userId, input);
    return {
      ...bundle,
      meaning:
        `This bundle contains the selected sweepable work data. Nothing has been deleted. ${WORK_DATA_RETENTION.notice}`,
      next:
        "Show the retention notice to the user. Write `bundle` to their selected folder, verify the saved bundle's sha256, then call sweep_delivered_work with this receipt only after the files are on their device and they confirm the selective sweep.",
    };
  },
};

export const sweepDeliveredWorkTool: McpTool = {
  name: "sweep_delivered_work",
  description:
    `Clear only the named sweepable columns after delivery and client file verification. Requires the signed receipt and exact confirmation phrase; changed bundles and active work are refused. Protected/shared runs and financial/evidentiary records stay untouched. ${WORK_DATA_RETENTION.notice}`,
  inputSchema: sweepDeliveredDataInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = sweepDeliveredDataInputSchema.parse(args);
    const receipt = await sweepDeliveredData(ctx.userId, input);
    return {
      ...receipt,
      meaning:
        `The named content columns were cleared; rows and financial/evidentiary records remain. ${WORK_DATA_RETENTION.notice}`,
    };
  },
};

export const DATA_DELIVERY_TOOLS: McpTool[] = [
  previewDeliveryScopeTool,
  deliverWorkDataTool,
  sweepDeliveredWorkTool,
];
