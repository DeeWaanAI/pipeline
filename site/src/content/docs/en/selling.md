---
title: "Selling on the marketplace"
description: "List a pipeline, understand certification (security scan, AI triage, blind human review), and what happens on approval or rejection."
order: 6
---

<!-- SYNC-WITH: helpContent.ts -->

Any pipeline you build can become a marketplace listing — after it earns certification. Nothing is buyable until it passes all three layers.

## List a pipeline

> Submit my "PR review" pipeline to the marketplace.

You'll set a title and description. During beta, listings are in free preview.

## What certification involves

1. **Security scan** — deterministic code checks your prompts for injection patterns, hidden Unicode tricks, exfiltration attempts, embedded secrets, and PII. Failures come back with specific findings so you can fix and resubmit.
2. **AI triage** — a platform-controlled model runs your pipeline on generated test inputs and scores quality. It advises you with concrete feedback; it can only stop listings whose quality is too low to waste reviewers' time. It can never approve a listing.
3. **Blind human review** — independent reviewers score your pipeline's real outputs without knowing who built it. Human consensus — a minimum average score plus a minimum pass ratio — makes the listing buyable.

## What reviewers can and cannot see

Reviewers see test inputs and the outputs your pipeline produced. They never see your prompts, your identity, your listing description, or other reviewers' scores. Your secret prompts stay encrypted and are never disclosed — buyers get usage rights, not your source.

## Approval and rejection

On approval, the listing becomes buyable and displays the Certified badge with a public certification report. On rejection, you get the feedback that mattered and can resubmit after changes — resubmission starts certification fresh.
