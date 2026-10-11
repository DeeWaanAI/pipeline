// MCP tool: export_benchmark — hand one private evaluation to the user's folder.
//
// The chat-first rule (D9) means the archive is built by the same service the web
// app calls, so the two can never disagree about what left the server. The client
// writes the files; this tool does not touch the disk and does not sweep anything.

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { logger } from "../../lib/logger";
import { exportBenchmarkArchive } from "../../services/benchmark/benchmarkExport";

const inputSchema = z.object({ benchmarkId: z.number().int().positive() });

export const exportBenchmarkTool: McpTool = {
  name: "export_benchmark",
  description:
    "Export one of your private evaluations as an exact local archive: the frozen plan, the FULL TEXT of every judging prompt the panel used, every case input, every candidate output, every judgment (including the ones that failed to parse), the cost ledger rows, and a manifest with a SHA-256 per file. Ownership is enforced — another account's benchmark is refused the same way a non-existent one is. Have the client write archive.files into the user's selected folder, verify each hash, and READ OUT the manifest's `incomplete` list: those are bodies the server no longer holds and cannot recover. This tool saves nothing locally by itself and deletes nothing on the server.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  // Same gate as the rest of the evaluation surface: the name ends in
  // `_benchmark`, so leaving the flag off must hide it too.
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { benchmarkId } = inputSchema.parse(args);
    const result = await exportBenchmarkArchive({ userId: ctx.userId, benchmarkId });
    logger.info("MCP export_benchmark", { userId: ctx.userId, benchmarkId, files: result.archive.files.length });
    return {
      benchmarkId,
      planHash: result.benchmark.planHash ?? null,
      state: result.benchmark.state ?? null,
      archive: result.archive,
      message:
        `Benchmark ${benchmarkId}: ${result.archive.files.length} files ready to write into ${result.archive.directoryName}, `
        + `${result.archive.incomplete.length} body(s) the server no longer holds are listed in archive.incomplete. `
        + "Nothing has been saved locally or deleted remotely until the client acts.",
    };
  },
};
