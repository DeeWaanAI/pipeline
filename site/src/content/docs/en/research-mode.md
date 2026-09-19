---
title: "Research Mode: batch runs & chaining"
description: "Run up to 100 inputs in parallel with batch runs, and chain one pipeline's output into another — built for experiments and large-scale evaluation."
order: 3
---

<!-- SYNC-WITH: helpContent.ts -->

Research Mode adds two capabilities for serious work: batch runs and pipeline chaining. Both are available behind a feature flag — ask for early access.

## What Research Mode is

Batch runs let you execute the same pipeline against many inputs at once. Pipeline chaining lets you feed one pipeline's output straight into another. Together, they turn ad-hoc prompting into repeatable, scalable workflows.

## Batch runs

Start a batch of 1–100 inputs in a single call:

> Run a batch of my "sentiment analyzer" pipeline on these 50 customer reviews.

Your chat calls `run_batch` and returns immediately. Poll `batch_status` to watch progress:

> What's the status of my last batch?

You get queued, running, completed, and failed counts, plus per-run detail.

### Pause and resume

If a provider outage hits mid-batch, the run pauses automatically. Resume from where it stopped:

> Resume my batch.

### Export results

When the batch completes, export everything as CSV:

> Export my batch results to CSV.

Use batch runs for experiments, evaluations, dataset processing, and any job where running inputs one-by-one would waste time.

## Pipeline chaining

Chain one pipeline's output into another by passing a `chain` parameter when you run a pipeline or batch. On success, the final output is rendered into an input template and fed into the target pipeline.

Example — generation → evaluation in one submission:

> Run my "draft PR description" pipeline and chain the output into my "review quality" pipeline.

The first pipeline writes the description; the second evaluates it for clarity and completeness.

### Chaining syntax

The `chain` object takes:

- `targetProjectId` — the pipeline to receive the output
- `inputTemplate` — a template string supporting `{{finalResponse}}` (the previous pipeline's output) and `{{originalInput}}` (the input that started the chain)

## Guardrails

- Chain depth is capped at 3. Deeper chains are blocked.
- Cycles (pipeline A → B → A) are blocked.
- Cross-user targets are blocked — you can only chain into pipelines you own.
- Failed runs never chain. Only successful completions trigger the next pipeline.

These limits keep chains predictable and prevent runaway executions.
