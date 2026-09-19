// ═══════════════════════════════════════════════════════════════════
//  MCP TRANSPORTS — streamable HTTP (/mcp) + legacy SSE (/mcp/sse)
// ═══════════════════════════════════════════════════════════════════
// Streamable HTTP (MCP 2025-03-26):
//   POST   /mcp   JSON-RPC messages (JSON or SSE-streamed responses,
//                 decided by the SDK per client Accept headers)
//   GET    /mcp   standalone SSE stream for server→client messages
//   DELETE /mcp   session close
// Legacy SSE (MCP 2024-11-05), kept for older desktop clients:
//   GET    /mcp/sse                     opens SSE stream, emits endpoint event
//   POST   /mcp/messages?sessionId=…    client→server JSON-RPC messages
//
// Hono binding: with @hono/node-server the raw Node req/res live on
// c.env.incoming / c.env.outgoing. The SDK transports write the HTTP
// response themselves, so handlers return RESPONSE_ALREADY_SENT to tell
// the Hono adapter not to write a second response.
//
// Session map: process-local, keyed by the SDK-generated session id
// (exposed to clients via the mcp-session-id header, or ?sessionId= for
// legacy SSE). NOTE: multi-node deployments need sticky routing on that
// header so every request of a session hits the node holding its
// transport — acceptable for now (single-node deploy).

import type { Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { createMcpServer } from "./server";
import { logger } from "../lib/logger";
import type { McpAuthContext } from "./types";

type McpContext = Context<{ Bindings: HttpBindings }>;
type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;

interface McpSession {
  transport: AnyTransport;
  kind: "streamable" | "sse";
  userId: number;
  createdAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map<string, McpSession>();

/** Lazy sweep so dead sessions (client vanished without DELETE) don't leak. */
function sweepSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
      void s.transport.close().catch(() => { /* ignore */ });
    }
  }
}

function sessionNotFound(c: McpContext) {
  return c.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
    404,
  );
}

async function readJsonBody(c: McpContext): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// ─── Streamable HTTP ────────────────────────────────────────────────

export async function handleMcpPost(c: McpContext, auth: McpAuthContext) {
  const sessionId = c.req.header("mcp-session-id");
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && (!session || session.kind !== "streamable")) {
    return sessionNotFound(c);
  }

  if (!session) {
    // New session: one McpServer + transport per session, bound to this
    // request's auth context for its whole lifetime.
    sweepSessions();
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, kind: "streamable", userId: auth.userId, createdAt: Date.now() });
        auth.runtime = { ...(auth.runtime ?? {}), sessionId: id };
        logger.info("MCP session initialized", { sessionId: id, userId: auth.userId });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        logger.info("MCP session closed", { sessionId: id });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    try {
      const mcpServer = await createMcpServer(auth).connect(transport);
      // Phase A: session-scoped sampling bridge — lets tools reach back
      // through this live session to the desktop client's own LLM.
      auth.runtime = {
        ...(auth.runtime ?? {}),
        samplingSupported: () => !!mcpServer.server.getClientCapabilities()?.sampling,
        sample: async (params: unknown) => {
          const caps = mcpServer.server.getClientCapabilities();
          if (!caps?.sampling) throw new Error("SAMPLING_UNSUPPORTED");
          return mcpServer.server.createMessage(params as CreateMessageRequest["params"]);
        },
      };
    } catch (err) {
      logger.error("MCP: server connect failed", { error: (err as Error).message });
      return c.json({ error: "MCP server initialization failed" }, 500);
    }
    // The transport only exists in the map after initialize succeeds;
    // route this first request through the local reference.
    session = { transport, kind: "streamable", userId: auth.userId, createdAt: Date.now() };
  }

  const body = await readJsonBody(c);
  if (body === undefined) {
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON body" }, id: null }, 400);
  }

  try {
    await (session.transport as StreamableHTTPServerTransport)
      .handleRequest(c.env.incoming, c.env.outgoing, body);
  } catch (err) {
    logger.error("MCP: streamable handleRequest failed", { error: (err as Error).message });
    if (!c.env.outgoing.headersSent) {
      return c.json({ error: "MCP transport error" }, 500);
    }
  }
  return RESPONSE_ALREADY_SENT;
}

async function handleStreamableSessionRequest(c: McpContext, label: string) {
  const sessionId = c.req.header("mcp-session-id");
  if (!sessionId) {
    return c.json({ error: "mcp-session-id header required" }, 400);
  }
  const session = sessions.get(sessionId);
  if (!session || session.kind !== "streamable") {
    return sessionNotFound(c);
  }
  try {
    await (session.transport as StreamableHTTPServerTransport)
      .handleRequest(c.env.incoming, c.env.outgoing);
  } catch (err) {
    logger.error(`MCP: ${label} failed`, { sessionId, error: (err as Error).message });
    if (!c.env.outgoing.headersSent) {
      return c.json({ error: "MCP transport error" }, 500);
    }
  }
  return RESPONSE_ALREADY_SENT;
}

export function handleMcpGet(c: McpContext, _auth: McpAuthContext) {
  return handleStreamableSessionRequest(c, "GET /mcp");
}

export function handleMcpDelete(c: McpContext, _auth: McpAuthContext) {
  return handleStreamableSessionRequest(c, "DELETE /mcp");
}

// ─── Legacy SSE transport ───────────────────────────────────────────

export async function handleLegacySse(c: McpContext, auth: McpAuthContext) {
  sweepSessions();
  const transport = new SSEServerTransport("/mcp/messages", c.env.outgoing);
  sessions.set(transport.sessionId, {
    transport,
    kind: "sse",
    userId: auth.userId,
    createdAt: Date.now(),
  });
  transport.onclose = () => {
    sessions.delete(transport.sessionId);
    logger.info("MCP legacy SSE session closed", { sessionId: transport.sessionId });
  };
  try {
    // connect() starts the transport, which writes the SSE headers and
    // the endpoint event to c.env.outgoing.
    const mcpServer = await createMcpServer(auth).connect(transport);
    auth.runtime = {
      ...(auth.runtime ?? {}),
      sessionId: transport.sessionId,
      samplingSupported: () => !!mcpServer.server.getClientCapabilities()?.sampling,
      sample: async (params: unknown) => {
        const caps = mcpServer.server.getClientCapabilities();
        if (!caps?.sampling) throw new Error("SAMPLING_UNSUPPORTED");
        return mcpServer.server.createMessage(params as CreateMessageRequest["params"]);
      },
    };
  } catch (err) {
    sessions.delete(transport.sessionId);
    logger.error("MCP: legacy SSE connect failed", { error: (err as Error).message });
    if (!c.env.outgoing.headersSent) {
      return c.json({ error: "MCP server initialization failed" }, 500);
    }
  }
  logger.info("MCP legacy SSE session opened", { sessionId: transport.sessionId, userId: auth.userId });
  return RESPONSE_ALREADY_SENT;
}

export async function handleLegacyMessage(c: McpContext, _auth: McpAuthContext) {
  const sessionId = c.req.query("sessionId");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || session.kind !== "sse") {
    return sessionNotFound(c);
  }
  const body = await readJsonBody(c);
  if (body === undefined) {
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON body" }, id: null }, 400);
  }
  try {
    // handlePostMessage writes the 202 Accepted response itself.
    await (session.transport as SSEServerTransport)
      .handlePostMessage(c.env.incoming, c.env.outgoing, body);
  } catch (err) {
    logger.error("MCP: legacy message handling failed", { sessionId, error: (err as Error).message });
    if (!c.env.outgoing.headersSent) {
      return c.json({ error: "MCP transport error" }, 500);
    }
  }
  return RESPONSE_ALREADY_SENT;
}
