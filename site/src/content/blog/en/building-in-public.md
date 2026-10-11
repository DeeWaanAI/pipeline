---
title: "Building DeeWaanAI in public — why we publish our trust system"
description: "Most marketplaces ask you to trust them. We'd rather show you the machinery — here's why our certification process is public."
date: 2026-07-29
---

> [!NOTE]
> **Written 2026-07-29; the trust model has changed since.** Certification no
> longer ends with a blind human review pool. A seller now runs a frozen test
> plan and a judging panel of three models from three different developers —
> none of them a model that generated the answers — and the whole record is
> published for anyone to read: the inputs, the outputs, the exact text of every
> judging prompt, every score, every failure, and what it cost. The principle
> below is unchanged, and it is the reason for the change: show the machinery
> instead of asking for trust. See
> [how the evidence works](/trust).

Every marketplace eventually says "trust us." We think that's backwards.

DeeWaanAI is a marketplace for AI pipelines — multi-step LLM workflows you can run from inside the chat client you already use. The thing that makes a marketplace worth using isn't the listings; it's knowing which listings deserve your money. So we built a certification system with three layers — a deterministic security scan, a non-gating AI triage, and blind human review — and then we did the unusual part: we wrote down exactly how it works and put it on the public website.

Why publish it? Two reasons.

First, verifiable beats asserted. If buyers can read the process, they can judge the badge. A "certified" label that hides its criteria is marketing; one that publishes them is a claim you can hold us to.

Second, sunlight keeps us honest. A public process is much harder to quietly weaken when a tempting listing comes along.

This blog is where we'll document the build — certification decisions, marketplace mechanics, mistakes included. The trust system deep-dive lives at [/trust](/trust).
