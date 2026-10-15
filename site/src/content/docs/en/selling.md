---
title: "Sharing on the marketplace"
description: "List a pipeline, understand the evidence gate (completed recorded test, vendor-disjoint judging panel, secret scan, your consent to the exact preview), and what happens on publication or refusal."
order: 6
---

<!-- SYNC-WITH: helpContent.ts -->

Any pipeline you build can become a marketplace listing — after it earns certification. Listings are shared free of charge, as open source: nothing is sold, and nothing is listed until it passes all three layers.

## List a pipeline

> Submit my "PR review" pipeline to the marketplace.

You'll set a title and description. There is no price to set — sharing is free.

## What publication involves

1. **The evidence gate** — you run a frozen plan of approved test inputs and the results are scored by a judging panel you generate: three judges from three different model developers, under three prompt framings, with no judge sharing a developer with a model that generated the answers. Self-grading is refused by the gate itself, and so is an incomplete plan. The test runs go out under your own provider keys — the platform pays for zero model calls.
2. **A scan of what you are about to disclose** — deterministic code reads the published material (test inputs, outputs, judge rationales) for embedded secrets, API keys and personal data. Anything found refuses the publication and names the finding, so a leak is stopped rather than apologised for later.
3. **Your consent, to an exact preview** — the page you approve is hashed; if anything in the evidence changes after you looked at it, the publication is refused and you preview it again. Nothing auto-publishes when a run finishes.

Separately, a listing that goes through the legacy submission path also passes a
deterministic scan of its step prompts for injection patterns, hidden Unicode
tricks and exfiltration attempts. That scan is the legacy gate: publishing a v2
listing checks the evidence, the panel and the disclosed text, and the site does
not claim more than that.

## What the judges can and cannot see

The judges receive the published test inputs and the outputs your pipeline produced. They never see your step prompts, your identity, or your listing description, and your hidden instructions are excluded from the judging call by rule, not by convention.

Sharing, however, is open source in the literal sense: anyone who forks your listing receives the pipeline definition itself, including its prompts. Publish only work you are willing to give away.

What DOES go public is the record: the inputs, the outputs, the exact text of every judging prompt, every score with its rationale, every judgment that failed to parse, and what the run cost — including the costs that are still unknown. That is the point: a reader can check your evidence instead of trusting a badge.

## Approval and rejection

On approval, the listing is published and forkable, with the Certified badge and a public certification report. On rejection, you get the feedback that mattered and can resubmit after changes — resubmission starts certification fresh.
