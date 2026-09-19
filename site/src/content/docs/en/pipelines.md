---
title: "Creating & running pipelines"
description: "What a DeeWaanAI pipeline is, how to create one with natural language or explicit steps, and how to run and update it."
order: 2
---

<!-- SYNC-WITH: helpContent.ts -->

A pipeline is an ordered set of steps that run AI agents toward a goal. Steps can include agent calls, if/while control flow, and approval gates where a human must confirm before the run continues.

## Create a pipeline with natural language

Describe the outcome you want:

> Create a pipeline that reviews a pull request: summarize the diff, flag risks, then draft review comments.

DeeWaanAI designs the pipeline — steps, agents, and prompts — and saves it to your account. Review what it built before running it.

## Create a pipeline with explicit steps

When you know exactly what you want, spell out the steps:

> Create a pipeline with three steps: (1) an agent that extracts invoice fields, (2) an approval gate, (3) an agent that writes the fields to a summary table.

## Run a pipeline

> Run my "invoice extractor" pipeline.

Long runs execute in the background — you can close the chat and come back. Approval-gated steps pause the run until you approve:

> Approve the pending step in my invoice run.

## Check run status

> What's the status of my last run?

You get the current step, completed steps, and anything waiting on you.

## Update a pipeline

> In my invoice pipeline, make the first step also detect the currency.

Updates apply to future runs; completed runs keep the version they executed with.

## Chain pipelines

You can feed one pipeline's output straight into another. See [Research Mode: batch runs & chaining](/docs/research-mode) for the full guide on chaining and batch runs.

## Your data — always exportable

Everything you build is yours. You can export a single pipeline, or everything you own, at any time:

> Export my pipeline and save it in my projects folder.
> Export all my DeeWaanAI data.

Exports are portable JSON. They work with your chat client's own file tools — save locally, paste into another tool, or push to GitHub. No lock-in.
