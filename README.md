# DeeWaanAI Pipeline

A local-first MCP server and visual pipeline designer. You design and run
pipelines on your own machine, with your own model keys; the only thing that ever
leaves is a file you choose to export.

```bash
npx @deewaanai/pipeline
```

Open the printed studio URL, paste the printed MCP URL into Claude, ChatGPT, Qwen
Code, Kimi or any streamable-HTTP client, and the AI can design, evaluate and
export pipelines for you. Data lives in `~/.deewaanai` (SQLite); secrets are
generated on first run and never leave the machine.

## What it does

- **Design a pipeline** for a task. The AI generates it; you edit it in the studio.
- **Design a judging panel.** Exactly three judges, from three different model
  developers, disjoint from every model that produced an output being judged, each
  under a different frozen prompt variant — the panel design from Verga et al.
  (2024) with Zheng et al.'s (2023) self-enhancement constraint. You choose the
  criteria the judges score.
- **Benchmark it.** Cases, candidates, judgments, the full judging prompts and the
  cost ledger are recorded. Private evaluations may use any panel; only a
  three-judge panel can produce evidence.
- **Share it as a file.** Export a pipeline — optionally with its benchmark archive
  bound into the same signature — and send it however you send files. The recipient
  imports it as their own editable copy, attributed to you. Nothing is hosted.
- **Set per-step model settings**: model, temperature, token limits.
- **Bring your own keys.** Every model call is billed by your own provider. The
  platform never pays for, proxies or meters a call.

## What it does not do

No marketplace, no payments, no accounts to create, no execution on our servers.
There is no human review; the published evidence record is the certification.
Signatures prove who issued a record and that it was not edited — they do **not**
prove that a benchmark ran on a particular machine.

## Verified evidence

Published evidence is signed with Ed25519. Pin these values from a source you
trust, not from the record itself:

- **Signing key:** `deewaanai-platform-2026-1`
- **Fingerprint:** `27b3:1f5d:361b:1a82:7c0d:1a32:2c21:891e`

Seven signed examples, with their rubrics, judging prompts and scores, ship in
[`examples/`](examples/) and verify offline:

```bash
node examples/verify-examples.mjs
node examples/verify-examples.mjs --pin platform-public-key.pem   # also checks the signer
```

A signature names a key; the fingerprint is what tells you the key is ours.

## Architecture

- **Server:** Hono + tRPC + Drizzle. SQLite for local installs (`DB_DRIVER=sqlite`,
  the packaged default) or MySQL (`DB_DRIVER=mysql`); Redis is optional and falls
  back to an in-memory queue.
- **MCP:** streamable HTTP and legacy SSE at `/mcp`, OAuth 2.1 with loopback
  redirects accepted on any port (RFC 8252 §7.3).
- **Client:** React 19 + Vite + i18next; the same process serves the API, the MCP
  surface and the built SPA.
- **Evidence:** canonical-JSON hashing, Ed25519 attestations, an offline verifier
  in `examples/verify-examples.mjs` and `scripts/verify-evidence.mjs`.

## Development

Node 20+ and, for the development database, Docker.

```bash
docker compose up -d        # MySQL 8 (+ Redis if configured)
cp .env.example .env        # then edit values
npm ci
npm run db:push             # push the Drizzle schema
npm run dev                 # Vite on http://localhost:3000 (API + SPA + /mcp)
```

Gates:

```bash
npm run check               # tsc -b
npm test                    # unit suite; DB-backed files run when MySQL is reachable
npm run i18n:check          # locale key parity
npm run build:local         # build the npm package payload
node scripts/pack-local.mjs # stage + pack dist-pkg/
```

## Licence

AGPL-3.0.
