// V3 L4 — hosted strip-down guard. When HOSTED_MARKETPLACE_ONLY=true the
// deployment stores listings and evidence but never executes: every entry
// point that would start model work refuses with a 410-style pointer to the
// local install. Enforced at the enqueue chokepoints (so tRPC, MCP and
// internal paths are all covered) — see workers/swarmWorker.ts,
// designWorker.ts, benchmarkWorker.ts.
import { env } from "./env";

export const EXECUTION_MOVED_MESSAGE =
  "This server no longer runs pipelines. DeeWaanAI is local-first: " +
  "install it on your own computer (npx deewaanai) and run there with " +
  "your own provider keys. This marketplace only stores listings and evidence.";

export class ExecutionMovedError extends Error {
  readonly code = "EXECUTION_MOVED_LOCAL";
  readonly httpStatus = 410;
  constructor() {
    super(EXECUTION_MOVED_MESSAGE);
  }
}

export function assertExecutionAllowed(): void {
  if (env.marketplaceOnly) throw new ExecutionMovedError();
}
