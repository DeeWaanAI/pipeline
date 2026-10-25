# DeeWaanAI Pipeline

Local-first MCP server and visual pipeline designer. Everything runs on your
machine: your pipelines, your keys, your models, your data. Nothing is executed
on our servers, and there is no account to create.

## Run it

```bash
npx @deewaanai/pipeline
```

Then open **http://localhost:3000** for the studio.

- Data lives in `~/.deewaanai` (SQLite). Override the database location with `SQLITE_PATH`.
- On first start the launcher generates its own secrets and keeps them in
  `~/.deewaanai/env`. They encrypt your stored provider keys and sign local
  sessions; they never leave the machine.
- You bring your own model keys: add them in Settings and calls are billed by
  the provider directly. The platform never pays for, or proxies, a model call.

## Connect your AI app

The MCP endpoint is:

```
http://localhost:3000/mcp
```

Add it as a remote MCP server in Claude, ChatGPT, Qwen Code, Kimi or any client
that speaks streamable HTTP. OAuth completes in your browser on first connect;
the loopback redirect is accepted on any port.

## What the AI can do with it

- **Design a pipeline** for a task and open the studio to edit it.
- **Design a judging panel** — three judges from three different model
  developers, disjoint from everything that generated an output, each under a
  different frozen prompt variant. That is the panel your evidence is graded on.
- **Benchmark** a pipeline: cases, candidates, judgments and the full judging
  prompts, all recorded locally.
- **Export a pipeline as one file** — optionally with its benchmark archive bound
  into the same signature — and **import** a file someone sent you. Sharing is a
  file, not a service.
- **Set per-step model settings** for the pipeline you are working on.

## What it does not do

- No marketplace, no payments, no subscription.
- No hidden server: nothing is uploaded unless you export a file yourself.
- Signatures on exported evidence prove who issued the record and that it was
  not edited. They do not prove that a benchmark ran on your machine.

## Licence

AGPL-3.0. Source: https://github.com/DeeWaanAI/pipeline
