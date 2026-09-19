# DeeWaanAI (诗斋) — Product Features Report

*A user-facing overview generated from the application source code (React 19 + tRPC/Hono + MySQL), July 2026.*

---

## What is DeeWaanAI?

DeeWaanAI is an **AI agent swarm orchestration platform**. Instead of asking one chatbot to do everything, you build a **pipeline of specialized AI agents** — a builder, a critic, a refiner, a polisher — that work on your task in sequence, each improving on the last, while you watch live and stay in control. Projects connect to your real codebases (Gitee/GitHub) or uploaded files, so agents work with deep, structured knowledge of your project. A built-in **marketplace** lets creators publish and sell their pipelines, backed by a rigorous human + AI quality-review system. Teams get collaboration, beta-testing, and feedback tools on top.

The interface is fully bilingual (**English / 中文**).

---

## Core Features

### 1. Projects & Intelligent Workspace
- **Project dashboard** — create and manage unlimited "AI swarm workspaces," each with its own agents, pipeline, files, and settings.
- **Git-connected projects** — link a project to a **Gitee or GitHub repository** (browse repos, connect, sync, disconnect). The platform pulls your file tree and file contents so agents can read your actual code.
- **Project Intelligence Card** — an automatically generated, structured understanding of your codebase: project type, primary language, framework, full annotated file tree, entry points, architecture summary, key entities, **database tables**, **API endpoints**, and even open TODOs. Agents use this card to navigate your project and fetch only the files they need.
- **ZIP import** — upload a project ZIP (up to 100 MB) instead of connecting a repo.
- **Smart file retrieval** — agents request specific files by path; contents are served from fast local storage (no slow round-trips to Git hosts), with cross-file dependency awareness.

### 2. Chat with Your Agent Swarm
- **Live streaming execution** — watch every agent work in real time via server-sent events: step starts, outputs, completions, and errors stream into the workspace as they happen.
- **Multimodal attachments** — attach images (sent as vision input), PDFs, Word documents, and text files to your prompts; text is extracted automatically so agents can work with your documents.
- **Human-in-the-loop control** — insert **approval steps** anywhere in a pipeline. When reached, you can **Approve**, **Reject**, or **Modify with instructions**, and the run resumes from exactly that point.
- **Cancel any run** mid-flight.
- **Full execution audit** — every run, every agent step, every intermediate output is saved with model, provider, token counts, and latency. The "My Data → Execution Audit" view lets you inspect the complete response chain of any past run, flag responses, and add human notes.
- **Long-term project memory** — the swarm maintains a persistent project state file (`.ai-swarm/project-state.md`) plus an episodic memory system with automatic compression, so context survives across sessions without blowing up token costs.
- **Message reactions & feedback** — react to individual agent messages and submit structured feedback (bug / suggestion / praise / confusion, with severity).

### 3. AI Agents — Your Reusable Agent Library
- **Custom agents** with name, role (builder, critic, reviewer, refiner, translator, summarizer, or custom), system prompt, model, temperature, and max tokens.
- **Per-agent LLM choice** — assign different models/providers to different agents (e.g., a cheap fast model for drafting, a powerful one for critique).
- **Pre-built templates** you can clone and customize.
- **Import/export** agents as portable files.

### 4. Visual Pipeline Builder
- **Drag-and-drop pipeline editor** — order agent steps, edit prompts per step, override the model/provider per step.
- **Advanced control flow**, not just linear chains:
  - **IF steps** — conditional branching ("if the critic says *revise*, loop back to the refiner; otherwise continue").
  - **WHILE steps** — iterative refinement loops with a max-iteration cap.
  - **Approval steps** — human checkpoints before expensive or final steps.
- **Iteration controls** — max iterations, stop-on-no-improvement, per-agent iteration limits.
- **Reusable pipeline templates** — save any pipeline as a template, duplicate it, or apply it to new projects/chats.
- **Share with your team** — share pipelines and agents inside a team; teammates can import them into their own projects.

### 5. Bring Your Own AI (LLM Provider Management)
- **Plug in any compatible LLM provider** — add providers with base URL + API key, fetch the available model list live, and test the connection before saving.
- **Bank-grade key protection** — API keys are stored encrypted (PBKDF2, 480,000 iterations) in a dedicated key store; keys are decrypted only at call time.
- **Flexible defaults** — set a personal default provider/model, override per project, and override again per pipeline step.
- **Token accounting everywhere** — prompt/completion/total tokens and latency recorded for every agent response (uses real GPT tokenization).

### 6. Marketplace — Buy & Sell AI Pipelines
- **Browse & discover** pipelines by category: translation, writing, code, analysis, creative, and more.
- **One-time purchase or subscription** pricing, set by the creator; purchases split automatically into platform fee and creator earnings.
- **Intellectual-property protection** — creators' agent prompts are stored **encrypted**; buyers can *use* a pipeline without seeing its secret sauce.
- **Creator dashboard** — manage listings (draft → review → published), track sales, review progress, deposits, and refunds.

#### The quality gauntlet (what makes the marketplace trustworthy)
- **Auto-generated test suite** — for every listing, the platform generates test prompts across five difficulty classes: *simple, medium, complex, edge, and adversarial* — then actually runs the pipeline against them, capturing every intermediate agent output.
- **Human reviewer portal** — independent reviewers score each test output on **six dimensions**: accuracy, completeness, clarity, token efficiency, speed, and consistency.
- **AI ensemble review** — small, medium, and large AI models (plus rule-based checks) score the same outputs, and the platform measures **AI–human correlation**.
- **Statistical rigor** — inter-rater agreement is measured with **Fleiss' Kappa**; a listing is auto-approved only when the average score is ≥ 3.5/5 **and** reviewer agreement (Kappa) exceeds 0.60.
- **Reviewer incentives & trust** — reviewers earn points (10 per prompt + completion bonuses) redeemable for subscription days, and carry a **trust score** affected by flagged reviews and arbiter rulings.
- **Creator cost transparency** — deposits track AI-testing and human-review costs, with a refund ledger that returns deposits from sales commissions.

### 7. Teams & Beta Testing
- **Teams** with invite codes (and QR invite links), roles (owner, admin, tester, viewer), shared projects, and shared pipelines/agents.
- **Structured feedback pipeline** — feedback items (with automatic context: URL, browser, OS, console logs, active pipeline/step, model, tokens, latency) flow into triage, can be **converted into tracked issues** (P0–P3 priorities), assigned, resolved, and **verified by testers** before closing.
- **Screenshot feedback** — one-click annotated screenshots (html2canvas) uploaded with the report.
- **Changelog publishing** — ship release notes to your team linked to the issues they fix.
- **Engagement tracking** — activity log (messages, feedback, pipeline runs, imports, fix verifications) feeds member engagement scores — perfect for running a beta program.
- **Test fixtures** — upload reusable project ZIPs tagged by complexity (easy/medium/complex) to validate pipelines in **test mode** before listing them or shipping changes.

### 8. Data Ownership & Privacy
- **Full data export** — download *all* your data (agents, pipelines, templates, runs, projects) as a portable backup, and restore it later.
- **Project-level backups** — back up or restore a single project.
- **Granular privacy consent** — separate opt-ins for prompt storage, feedback storage, screenshots, and conversation history.
- **"My Data" hub** — browse your execution audit trail, testing data, and stored files in one place.

### 9. Notifications & Search
- **In-app notifications** for pipeline completions, pipeline errors, team invites, and review events — with unread badges and mark-all-read.
- **Global search** across your content.
- **Recent projects** quick access and persisted UI preferences (theme, sidebar, locale) that survive deployments.

### 10. Accounts & Access
- **Two sign-in methods**: Kimi OAuth (one-click) or classic username/password with secure bcrypt hashing and JWT sessions.
- **Voucher codes** — redeem codes for time-limited tier upgrades (e.g., beta-tester access).
- **Admin console** — user management, role/tier assignment, feedback triage, system stats, and **feature flags** with gradual rollout (percentage-based or beta-user allowlists) and a plugin architecture with circuit breakers for reliability.

---

## Membership Tiers

| | **Artist** (Standard) | **Master** (Pro Designer) | **Sage** (Pro Auto) |
|---|---|---|---|
| Pipeline | Fixed, pre-configured pipeline | **Fully custom pipelines** (IF/WHILE/approval steps) | Custom pipelines **+ AI-designed pipelines** |
| LLM providers | 1 | Up to **3** per pipeline | Up to 3 per pipeline |
| Custom agent library | — | ✅ | ✅ |
| Pipeline templates & marketplace publishing | — | ✅ | ✅ |
| **AI Auto-Design** | — | — | ✅ Describe your task in plain language and an expert **AI Pipeline Designer** builds the optimal multi-agent pipeline for you (choosing roles, quality gates, loops, and approval checkpoints automatically) |

Upgrades are available via subscription or time-limited **voucher codes**.

---

## Technical Highlights (for the curious)

- **Real-time streaming** pipeline execution over SSE, resilient through Nginx proxies.
- **Resumable execution state** — runs can pause at human-approval gates and resume exactly where they stopped.
- **Every run is fully auditable**: per-step model, provider, tokens, latency, temperature, and quality scores are persisted.
- **Encrypted secrets at rest** (API keys and marketplace prompts), JWT session security, bcrypt password hashing.
- **Modular, flag-gated architecture** — features roll out gradually; a circuit-breaker plugin protects against failing providers.
- **Automatic memory compression** keeps long-running projects fast and cheap.
- **Inter-rater statistics (Fleiss' Kappa)** and AI–human correlation scoring bring scientific rigor to marketplace quality control.
- **Bilingual by design** (English + 中文) with a one-file process to add more languages.

---

## Who is it for?

- **Power users & creators** who want more than single-shot chat — repeatable, inspectable, multi-agent workflows.
- **Developers** who want AI agents that genuinely understand their codebase (via the Intelligence Card and Git sync).
- **Teams & beta communities** that need structured feedback → issue → fix-verification loops.
- **Prompt engineers & pipeline creators** who want to **monetize** their AI workflows in a quality-controlled marketplace.
