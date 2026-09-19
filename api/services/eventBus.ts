// Event bus for SSE streaming with replay buffer and persistent terminal events.
//
// Local delivery (in-process clients + 5-min replay buffer + terminal events)
// is preserved exactly. On top of that, every emitted event is published to
// the shared pub/sub (`swarm:<runId>` channel) so other app nodes can fan it
// out to their own SSE clients. Pub/sub is best-effort: setup is async and
// internal, failures are logged never thrown, and the public API stays fully
// synchronous.

import { publish, subscribe, INSTANCE_ID, type PubSubEnvelope, type Unsubscribe } from "../infra/pubsub";
import { logger } from "../lib/logger";

type Client = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
};

type BufferedEvent = {
  data: Uint8Array;
  ts: number;
};

const clients = new Map<number, Client[]>();
const buffers = new Map<number, BufferedEvent[]>();
const BUFFER_MS = 300_000; // 5-minute replay buffer (up from 60s)

// Persistent terminal events — survive beyond the buffer window
// When a pipeline completes or errors, we store the final event here permanently
const terminalEvents = new Map<number, Uint8Array>();

// Process-level pub/sub subscriptions per run channel (lazily created)
const channelSubs = new Map<number, Unsubscribe>();
const channelSubPending = new Map<number, Promise<void>>();

function channelFor(swarmRunId: number): string {
  return `swarm:${swarmRunId}`;
}

function replayBuffer(swarmRunId: number, controller: ReadableStreamDefaultController<Uint8Array>): void {
  const now = Date.now();
  const buf = buffers.get(swarmRunId) ?? [];
  const cutoff = now - BUFFER_MS;
  for (const ev of buf) {
    if (ev.ts > cutoff) {
      try { controller.enqueue(ev.data); } catch { /* ignore */ }
    }
  }
  // Clean old events
  const fresh = buf.filter((e) => e.ts > cutoff);
  if (fresh.length === 0) buffers.delete(swarmRunId);
  else buffers.set(swarmRunId, fresh);
}

/**
 * Lazily ensure a process-level pub/sub subscription exists for this run's
 * channel. Incoming envelopes from OTHER instances are fanned out to local
 * clients (and buffered locally for replay). Own-instance echoes are dropped
 * because emitEvent already delivered them locally.
 */
function ensureChannelSubscription(swarmRunId: number): void {
  if (channelSubs.has(swarmRunId) || channelSubPending.has(swarmRunId)) return;

  const pending = subscribe<unknown>(channelFor(swarmRunId), (envelope: PubSubEnvelope<unknown>) => {
    if (envelope.origin === INSTANCE_ID) return; // own echo — already delivered locally
    deliverLocal(swarmRunId, envelope.message);
  }).then((unsub) => {
    channelSubPending.delete(swarmRunId);
    // Only keep the subscription if clients are still around; otherwise drop it
    if ((clients.get(swarmRunId)?.length ?? 0) > 0) {
      channelSubs.set(swarmRunId, unsub);
    } else {
      unsub();
    }
  }).catch((err) => {
    channelSubPending.delete(swarmRunId);
    logger.warn("eventBus: channel subscription failed (continuing local-only)", {
      swarmRunId,
      error: (err as Error).message,
    });
  });

  channelSubPending.set(swarmRunId, pending);
}

function maybeReleaseChannelSubscription(swarmRunId: number): void {
  if ((clients.get(swarmRunId)?.length ?? 0) > 0) return;
  const unsub = channelSubs.get(swarmRunId);
  if (unsub) {
    channelSubs.delete(swarmRunId);
    try { unsub(); } catch { /* ignore */ }
  }
}

/** Encode + buffer + store terminal + deliver to local clients. Never publishes. */
function deliverLocal(swarmRunId: number, event: unknown): void {
  const encoder = new TextEncoder();
  const dataStr = `data: ${JSON.stringify(event)}\n\n`;
  const bytes = encoder.encode(dataStr);

  // Buffer for replay
  const buf = buffers.get(swarmRunId) ?? [];
  buf.push({ data: bytes, ts: Date.now() });
  const cutoff = Date.now() - BUFFER_MS;
  const fresh = buf.filter((e) => e.ts > cutoff);
  if (fresh.length === 0) buffers.delete(swarmRunId);
  else buffers.set(swarmRunId, fresh);

  // Store terminal events permanently
  const eventObj = event as { type?: string };
  if (eventObj.type === "pipeline_complete" || eventObj.type === "pipeline_error") {
    terminalEvents.set(swarmRunId, bytes);
  }

  // Send to connected clients
  const list = clients.get(swarmRunId) ?? [];
  for (const client of list) {
    if (!client.closed) {
      try { client.controller.enqueue(bytes); }
      catch { client.closed = true; }
    }
  }

  // Clean up closed clients
  const active = list.filter((c) => !c.closed);
  if (active.length === 0) clients.delete(swarmRunId);
  else clients.set(swarmRunId, active);
}

export function subscribeClient(swarmRunId: number, controller: ReadableStreamDefaultController<Uint8Array>): () => void {
  // Replay buffered events so late subscribers see recent progress
  replayBuffer(swarmRunId, controller);

  // If the run already terminated, send the terminal event immediately
  const terminal = terminalEvents.get(swarmRunId);
  if (terminal) {
    try { controller.enqueue(terminal); } catch { /* ignore */ }
  }

  const list = clients.get(swarmRunId) ?? [];
  const client: Client = { controller, closed: false };
  list.push(client);
  clients.set(swarmRunId, list);

  // Make sure this process receives cross-node events for the run (best-effort)
  ensureChannelSubscription(swarmRunId);

  return () => {
    client.closed = true;
    const updated = (clients.get(swarmRunId) ?? []).filter((c) => !c.closed);
    if (updated.length === 0) clients.delete(swarmRunId);
    else clients.set(swarmRunId, updated);
    maybeReleaseChannelSubscription(swarmRunId);
  };
}

export function emitEvent(swarmRunId: number, event: unknown): void {
  // Local delivery (buffer + terminal store + connected clients)
  deliverLocal(swarmRunId, event);

  // Cross-node fan-out (fire-and-forget; failures logged inside pub/sub)
  void publish(channelFor(swarmRunId), event).catch((err) => {
    logger.debug("eventBus: publish failed (local delivery unaffected)", {
      swarmRunId,
      error: (err as Error).message,
    });
  });
}

/** Clear terminal event when run is no longer relevant (e.g., after DB cleanup) */
export function clearTerminalEvent(swarmRunId: number): void {
  terminalEvents.delete(swarmRunId);
}

export interface PipelineEvent {
  type: "step_start" | "step_complete" | "step_error" | "step_stream" | "pipeline_complete" | "pipeline_error" | "awaiting_approval";
  swarmRunId: number;
  step?: number;
  agentRole?: string;
  agentName?: string;
  iteration?: number;
  responseType?: string;
  tokensUsed?: number;
  latencyMs?: number;
  totalTokens?: number;
  totalLatencyMs?: number;
  finalResponse?: string;
  awaitingApproval?: boolean;
  chain?: Array<{ id: number; content: string; agentRole: string; agentName: string }>;
  error?: string;
  delta?: string;  // For step_stream token deltas
  timestamp: string;
}
