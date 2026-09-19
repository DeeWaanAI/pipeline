#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  ON-PREM RELAY CONNECTOR (Phase 3) — outbound-only
// ═══════════════════════════════════════════════════════════════════
// Runs on the customer's side of the firewall. It long-polls the cloud for
// relay requests over OUTBOUND HTTPS, executes each one against a local
// service (LOCAL_URL), and posts the result back. It never opens an inbound
// port, so it works behind NAT / strict egress-only networks and satisfies
// data-residency requirements (the data never leaves the premises; only
// request/response payloads the operator chooses to relay cross the wire).
//
// Zero npm dependencies — uses the Node 18+ global `fetch`. Run directly:
//   CLOUD_URL=https://app.example.com RELAY_TOKEN=<token> \
//     LOCAL_URL=http://localhost:3000 node relay/connector.mjs
// or via docker-compose.relay.yml (no published ports).
//
// Env:
//   CLOUD_URL    (required) cloud app origin, e.g. https://app.example.com
//   RELAY_TOKEN  (required) raw token returned by POST /api/relay/register
//   LOCAL_URL    (optional) local service base URL. Default http://localhost:3000
//   POLL_WAIT    (optional) long-poll seconds per cycle. Default 25
//   MAX_BACKOFF  (optional) max error backoff ms. Default 30000

const CLOUD_URL = (process.env.CLOUD_URL || "").replace(/\/+$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const LOCAL_URL = (process.env.LOCAL_URL || "http://localhost:3000").replace(/\/+$/, "");
const POLL_WAIT = clampInt(process.env.POLL_WAIT, 25, 0, 60);
const MAX_BACKOFF = clampInt(process.env.MAX_BACKOFF, 30000, 1000, 120000);

if (!CLOUD_URL) fail("CLOUD_URL is required (cloud app origin, e.g. https://app.example.com)");
if (!RELAY_TOKEN) fail("RELAY_TOKEN is required (from POST /api/relay/register)");

function fail(msg) {
  console.error(`[relay] ${msg}`);
  process.exit(1);
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, data) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...(data || {}) }));
}

const authHeaders = { authorization: `Bearer ${RELAY_TOKEN}` };

// Long-poll the cloud for the next request. Returns null on a 204 (no work).
async function poll() {
  const res = await fetch(`${CLOUD_URL}/api/relay/poll?wait=${POLL_WAIT}`, {
    headers: authHeaders,
    signal: AbortSignal.timeout((POLL_WAIT + 15) * 1000),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`poll failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return await res.json();
}

// kind "http_proxy": execute { method, path, body } against LOCAL_URL and
// return { status, json } or { status, text }.
async function executeHttpProxy(payload) {
  const method = String(payload.method || "GET").toUpperCase();
  const path = String(payload.path || "/");
  const url = `${LOCAL_URL}${path.startsWith("/") ? path : `/${path}`}`;

  const init = { method, headers: { "content-type": "application/json" } };
  if (method !== "GET" && method !== "HEAD" && payload.body != null) {
    init.body = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed;
  let isJson = false;
  try {
    parsed = JSON.parse(text);
    isJson = true;
  } catch {
    /* not JSON — return as text */
  }
  const result = { status: res.status };
  if (isJson) result.json = parsed;
  else result.text = text;
  return result;
}

async function postResult(requestId, outcome) {
  const res = await fetch(`${CLOUD_URL}/api/relay/result`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ requestId, ...outcome }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`result post failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

let backoffMs = 1000;

async function main() {
  log("relay connector starting", { cloudUrl: CLOUD_URL, localUrl: LOCAL_URL, pollWait: POLL_WAIT });

  for (;;) {
    try {
      const job = await poll();
      if (!job) {
        // Idle cycle (204) — healthy; reset backoff and poll again.
        backoffMs = 1000;
        continue;
      }

      log("job received", { requestId: job.requestId, kind: job.kind });

      let outcome;
      try {
        if (job.kind === "http_proxy") {
          const result = await executeHttpProxy(job.payload || {});
          outcome = { result };
        } else {
          outcome = { error: `unsupported kind: ${job.kind}` };
        }
      } catch (err) {
        outcome = { error: (err && err.message) || String(err) };
      }

      await postResult(job.requestId, outcome);
      log("job completed", { requestId: job.requestId, failed: Boolean(outcome.error) });
      backoffMs = 1000; // success — reset
    } catch (err) {
      log("error", { error: (err && err.message) || String(err), backoffMs });
      await sleep(backoffMs);
      backoffMs = Math.min(MAX_BACKOFF, backoffMs * 2);
    }
  }
}

main().catch((err) => {
  console.error("[relay] fatal", err);
  process.exit(1);
});
