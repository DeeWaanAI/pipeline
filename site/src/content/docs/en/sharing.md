---
title: "Sharing pipelines"
description: "Lend one pipeline to one named account from your chat client — run-only or full, revocable at any time, and always staying yours."
order: 4
---

<!-- SYNC-WITH: helpContent.ts -->

You can hand a pipeline to one other person without handing them your prompts. A share is
a **loan between two accounts**, not a transfer: you stay the owner, and publishing stays
reserved to whoever originally created the work.

DeeWaanAI does not have team workspaces. They were retired: a shared workspace made one
person's API keys, provider bindings and unpublished prompts visible to a group, and the
product is built around your account owing its own spend. One-to-one shares are the
replacement, and they are what you ask for in chat.

## Lend a pipeline

Say who should get it — their account email, or their account id:

> Share my "contract-review" pipeline with partner@example.com so they can run it but not read the prompts.

Two levels, and the default is the stricter one:

- **`run_only`** (default) — they run it and keep the answer. When they read the pipeline
  they get step order, names, roles and states only: never the step prompts, system prompts,
  model bindings or provider references. Their run is redacted **at the write**, so no copy of
  your prompts is stored for it later.
- **`full`** — they can also read the definition, including every system prompt. Add
  `canModify` and they can edit that pipeline; the edit lands on **your** project, and your
  ownership does not move.

Re-sending the same share updates the existing grant instead of stacking a second, possibly
different, one.

## Running what you were given

> Run the pipeline Ali shared with me on this contract.

Their run executes on **their own** provider and keys. The owner's stored provider is never
the route, and the definition never lands in the recipient's records: an immutable snapshot
owned by the sharer executes inside a container project of the runner's. Status, step
progress, token counts and the final output are all visible; on a `run_only` share even the
provider's own error text is reported as a category, because it can quote the workflow.

If the work is useful enough to adapt, a `full` share can be cloned:

> Clone the pipeline Ali shared with me so I can adapt it for the Arabic market.

The copy runs and reads like theirs, and it stays **attributed** — the original creator is
carried forward as data, so publishing stays refused to anyone but that creator. A `run_only`
share cannot be cloned, because you cannot copy what you were never allowed to read.

## Take it back

> Revoke the share of my contract-review pipeline with partner@example.com.

Owner-only, and idempotent. Access is re-read at dispatch, so a run that was already queued
stops before its first provider call. Runs the recipient already completed stay with them,
and the grant row is flipped to "revoked" rather than deleted — the record that access
existed is kept.

## What a share never grants

No share, at any privilege, grants the right to publish. Listing work on the marketplace is
reserved to the account that originally created it, checked against the recorded lineage —
so improving borrowed work cannot turn it into work you may publish as your own.

See also: [Creating and running pipelines](/docs/pipelines),
[Sharing on the marketplace](/docs/selling).
