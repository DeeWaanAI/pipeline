---
title: "Models & API keys"
description: "DeeWaanAI uses your own LLM provider keys — how to add a provider, how keys are stored, and how to pick models per pipeline."
order: 5
---

<!-- SYNC-WITH: helpContent.ts -->

DeeWaanAI is bring-your-own-keys. Your pipeline runs call your providers, under your keys, on your accounts. DeeWaanAI orchestrates — it never resells inference and never sees your provider bills.

## Add a provider

Ask your chat:

> Add my OpenAI API key.

or

> Which LLM providers do you suggest for low-cost or local models?

The suggestions include free-tier, low-cost, and local options. Keys are validated when added, and duplicate providers are rejected.

## How your keys are stored

Keys are encrypted at rest and used only to call your providers when your pipelines run. They are never shown in chat, never returned by any tool, and never written to logs.

## Set your default model

> Set my default model to gpt-4o-mini.

The default model is used whenever a pipeline step doesn't specify one.

## Switch models per pipeline

Different steps can use different models — a cheap model for extraction, a strong model for final reasoning. Say so when creating or updating the pipeline:

> In my research pipeline, use a fast cheap model for the search step and my default model for the writing step.
