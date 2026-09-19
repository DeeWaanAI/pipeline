---
title: "Teams (TeamSync)"
description: "Create a team, invite members, and collaborate on shared pipelines, context, and skills — with each member working in their own LLM desktop app."
order: 4
---

<!-- SYNC-WITH: helpContent.ts -->

TeamSync is a shared workspace for pipelines, agents, context, and skills. It is available behind the `teamsync` feature flag — ask for early access.

## Your team, any app, any provider

DeeWaanAI is an MCP server, so each teammate connects their **own** chat client — Kimi desktop, Claude desktop, Cursor, or any MCP-compatible app — and everyone works on the **same** shared pipelines and context. Each member uses their own configured LLM providers (bring-your-own-keys); DeeWaanAI keeps the team's shared state and runs in sync.

This is the key difference from team features that force everyone into the same app. With DeeWaanAI, the team collaborates on shared work while each person stays in the interface they already prefer.

## Create and join a team

Create a team and become the owner:

> Create a team called "Acme Research".

Share the invite code with teammates. They join by code:

> Join team with code ABC-123.

Teams have roles: owner, admin, and member. Admins and the owner manage membership; members collaborate on shared resources.

## Collaborate on shared context

Read the team's shared context:

> Get the team context for "Acme Research".

Append to shared memory so context survives across individual chats:

> Append to team memory: "The Q3 report deadline is now September 15."

List and resume team runs:

> List team runs.
> Resume the run Alice handed off to me.

Submit feedback on a teammate's run:

> Submit feedback on team run 42: the summary missed the pricing section.

## Share skills

List skills shared by your team:

> List team skills.

Use a shared skill in your own pipeline:

> Use the team skill "competitive-analysis-framework" in my current project.

## Share pipelines

Share a project you own to the team. Teammates can view and import its pipelines and agents into their own workspaces. Shared pipelines stay under your ownership — teammates get a working copy they can adapt.

> Share my "customer-segmentation" project with the team.

TeamSync makes DeeWaanAI useful for research groups, ops teams, and any group that needs shared AI workflows without forcing everyone into the same chat app.
