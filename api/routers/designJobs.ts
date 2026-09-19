// tRPC router: durable design jobs (offering redesign v2, spec §5.2/§10.1).
// Thin procedures around designJobService — authorization and business logic
// live in the shared service so HTTP and MCP enforce identically.
// Everything here is gated by the `v2DesignJobs` feature flag (spec §13 G1).

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { isFeatureEnabled } from "../plugins/featureFlags";
import {
  applyDesignJob,
  cancelDesignJob,
  getDesignJob,
  startDesignJob,
  V2DisabledError,
} from "../services/designJobService";
import { dispatchDesignJob } from "../workers/designWorker";

function requireV2() {
  // Flag check needs the caller id for rollout %; routers pass it in-proc.
  return true;
}

async function assertV2Enabled(userId: number) {
  const on = await isFeatureEnabled("v2DesignJobs", userId);
  if (!on) throw new V2DisabledError();
}

const startInput = z.object({
  projectId: z.number().int().positive(),
  task: z.string().trim().min(1).max(5000),
  providerId: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

export const designJobsRouter = createRouter({
  start: authedQuery
    .input(startInput)
    .mutation(async ({ input, ctx }) => {
      requireV2();
      await assertV2Enabled(ctx.user.id);
      const { job, reused } = await startDesignJob({ userId: ctx.user.id, ...input });
      // Best-effort immediate dispatch; the outbox reconciler guarantees
      // delivery even if this call fails (spec §5.3).
      void dispatchDesignJob(job.id, ctx.user.id).catch(() => { /* reconciler covers */ });
      return {
        jobId: job.id,
        state: job.state,
        reused,
        streamHint: "poll designJobs.get — durable job, no live callback required",
      };
    }),

  get: authedQuery
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertV2Enabled(ctx.user.id);
      return (await getDesignJob({ userId: ctx.user.id, jobId: input.jobId }));
    }),

  cancel: authedQuery
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertV2Enabled(ctx.user.id);
      const ok = await cancelDesignJob({ userId: ctx.user.id, jobId: input.jobId });
      return { success: ok };
    }),

  // `apply` is a reserved tRPC key → exposed as applyCandidate.
  applyCandidate: authedQuery
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertV2Enabled(ctx.user.id);
      return applyDesignJob({ userId: ctx.user.id, jobId: input.jobId });
    }),
});
