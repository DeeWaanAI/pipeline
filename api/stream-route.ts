import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { subscribeClient, type PipelineEvent } from "./services/eventBus";
import { getDb } from "./queries/connection";
import { swarmRuns } from "@db/schema";
import { eq } from "drizzle-orm";

export function registerStreamRoute(app: Hono<{ Bindings: HttpBindings }>) {
  app.get("/api/stream/:swarmRunId", async (c) => {
    const swarmRunId = parseInt(c.req.param("swarmRunId"));
    if (isNaN(swarmRunId)) {
      return c.json({ error: "Invalid swarmRunId" }, 400);
    }

    // Verify the swarm run exists
    const [run] = await getDb()
      .select()
      .from(swarmRuns)
      .where(eq(swarmRuns.id, swarmRunId));
    if (!run) {
      return c.json({ error: "Swarm run not found" }, 404);
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Send initial connected event
        const connected: PipelineEvent = {
          type: "step_start",
          swarmRunId,
          agentRole: "system",
          agentName: "System",
          step: 0,
          timestamp: new Date().toISOString(),
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(connected)}\n\n`));

        // If the run is already in a terminal state, send that immediately
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          const terminal: PipelineEvent = {
            type: run.status === "completed" ? "pipeline_complete" : "pipeline_error",
            swarmRunId,
            ...(run.status !== "completed" ? { error: `Pipeline ${run.status}` } : {}),
            timestamp: new Date().toISOString(),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminal)}\n\n`));
        }

        // Subscribe to events
        const unsubscribe = subscribeClient(swarmRunId, controller);

        // Clean up on client disconnect
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          try { controller.close(); } catch { /* ignore */ }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  // Prevent Nginx from buffering SSE
      },
    });
  });
}
