---
title: "Troubleshooting"
description: "Fix common DeeWaanAI connection, sign-in, and pipeline issues, and where to get help."
order: 9
---

<!-- SYNC-WITH: helpContent.ts -->

Most issues are connection or sign-in hiccups. Work through the relevant section, then reach out if you're still stuck.

## Connection issues per client

**The client can't reach the MCP server.** Re-check the URL — it must be exactly:

```
https://{{APP_DOMAIN}}/mcp
```

Remove and re-add the connector, then restart the client. For Claude Desktop, a full quit (not just closing the window) is required to reload connector configuration.

**The connector shows as failed or disconnected.** Tokens occasionally expire badly. Remove the connector, add it again, and approve the OAuth consent fresh.

## Auth popup problems

**Safari shows "can't connect to localhost" during approval.** The OAuth callback listens on IPv4 while Safari resolves localhost to IPv6. Copy the approval URL into Chrome and approve there — the flow completes normally.

**The consent screen loops back to login.** Sign in to the web dashboard first in the same browser, then retry the approval.

## Common errors in chat

**"No LLM provider configured."** Add a provider key first — see [Models & API keys](/docs/providers).

**"Unknown provider slug."** The provider name wasn't recognized. Ask for the supported provider list and retry with the exact slug.

**A pipeline run seems stuck.** Ask for the run status. If it's waiting at an approval gate, approve the step. Background runs survive chat restarts — nothing is lost by closing the client.

## Where to get help

- In chat: ask **"what can you do?"** — the built-in guide adapts to your account.
- Community: Discord (link in the footer).
- Bugs and feedback: the in-app feedback tool, or a marketplace listing issue report from the web dashboard.
