---
title: "Quickstart"
description: "Connect DeeWaanAI to your chat client and run your first pipeline in about five minutes."
order: 1
---

<!-- SYNC-WITH: helpContent.ts -->

Get from zero to your first completed pipeline run in about five minutes. Everything happens inside your existing chat client — there is no separate app to learn.

## 1. Connect your chat client

DeeWaanAI runs as an MCP server. Add this URL to your client once:

```
https://{{APP_DOMAIN}}/mcp
```

Step-by-step guides for Claude Desktop, Claude.ai, ChatGPT, Cursor, and generic MCP clients: **[Connect guide](/connect)**.

## 2. Sign in once

The first time your client talks to DeeWaanAI, a browser window opens for OAuth consent. Approve it once — tokens refresh automatically after that. If Safari shows a localhost error during approval, copy the URL into Chrome instead.

## 3. Create your first pipeline

Ask your chat, in plain language:

> Create a pipeline that takes a topic, researches it, and writes a 5-bullet summary.

DeeWaanAI designs the steps, creates the agents, and saves the pipeline to your account.

## 4. Run it

> Run my new pipeline with the topic "urban vertical farming".

Watch the steps execute in sequence. You can ask for the run status at any time.

## 5. See your results

Ask to see the run output, or open the web dashboard for the full step-by-step trace. That's it — you created and ran a pipeline without leaving your chat.
