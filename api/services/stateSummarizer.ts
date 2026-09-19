/**
 * Smart Compression Layer — Structured State Manager (Standard Tier)
 *
 * Three-tier memory architecture:
 * 1. Working Memory: current query + last response (ephemeral, per-turn)
 * 2. Compressed Memory: structured state.md (Goal + Key Decisions + Recent Activity)
 * 3. Episodic Memory: keyword-retrieved past episodes (stored in memory/episodes.json)
 */

import { encode } from "gpt-tokenizer";

export interface ProjectState {
  goal: string;
  keyDecisions: string[];
  recentActivity: string[];
  openReferences: string[];
  longTermSummaries: string[];
}

function estimateTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    // Fallback: ~4 chars per token (rough heuristic)
    return Math.ceil(text.length / 4);
  }
}

function createEmptyState(
  _projectName: string,
  description: string | null,
  initialPrompt: string
): ProjectState {
  return {
    goal: description || initialPrompt,
    keyDecisions: [],
    recentActivity: [],
    openReferences: [],
    longTermSummaries: [],
  };
}

/**
 * Extract a key decision from the critic/refiner outputs.
 * Simple heuristic: look for PASS/NEEDS_WORK assessment and improvement notes.
 */
function extractDecision(
  criticContent?: string,
  refinerContent?: string
): string | null {
  if (criticContent) {
    const passMatch = criticContent.match(/## Overall Assessment\s*\n\s*(PASS)/i);
    if (passMatch) return "Output approved by critic review";
    const failMatch = criticContent.match(/## Overall Assessment\s*\n\s*(NEEDS_WORK|MAJOR_REVISIONS)/i);
    if (failMatch) return "Output required revision based on critic feedback";
  }
  if (refinerContent) {
    const hasImprovement = /improved|refined|enhanced|better|stronger|clearer/i.test(
      refinerContent.substring(0, 200)
    );
    if (hasImprovement) return "Content refined for quality improvement";
  }
  return null;
}

/**
 * Update the structured state after a pipeline run.
 * Handles rotation of Recent Activity (max 3) and Key Decisions (max 10).
 */
export function updateStateWithSession(
  previousState: ProjectState | null,
  _projectName: string,
  description: string | null,
  userPrompt: string,
  agentOutputs: Array<{ role: string; name: string; content: string }>,
  finalOutput: string
): ProjectState {
  const state = previousState ?? createEmptyState(_projectName, description, userPrompt);

  // Extract decision from critic + refiner
  const criticOut = agentOutputs.find((a) => a.role === "critic");
  const refinerOut = agentOutputs.find((a) => a.role === "refiner");
  const decision = extractDecision(criticOut?.content, refinerOut?.content);

  if (decision && !state.keyDecisions.includes(decision)) {
    state.keyDecisions = [...state.keyDecisions, decision].slice(-10);
  }

  // Rotate recent activity (max 3) — newest first
  const dateStr = new Date().toISOString().split("T")[0];
  const newActivity = `[${dateStr}] "${userPrompt.substring(0, 200)}${userPrompt.length > 200 ? "..." : ""}" → ${finalOutput.substring(0, 400)}${finalOutput.length > 400 ? "..." : ""}`;
  state.recentActivity = [newActivity, ...state.recentActivity].slice(0, 3);

  // Update open references
  state.openReferences = [`Latest output: ${finalOutput.substring(0, 800)}${finalOutput.length > 800 ? "..." : ""}`];

  return state;
}

export type MemoryMode = "conservative" | "balanced" | "aggressive";

interface CompressionConfig {
  recentActivityMax: number;
  keyDecisionsMax: number;
  longTermMax: number;
  softThreshold: number;
  hardThreshold: number;
  preserveAllDecisions: boolean;
  enableEpisodic: boolean;
}

function getCompressionConfig(mode: MemoryMode): CompressionConfig {
  switch (mode) {
    case "conservative":
      return {
        recentActivityMax: 10,
        keyDecisionsMax: 100,
        longTermMax: 50,
        softThreshold: 15000,
        hardThreshold: 50000,
        preserveAllDecisions: true,
        enableEpisodic: true,
      };
    case "balanced":
      return {
        recentActivityMax: 5,
        keyDecisionsMax: 20,
        longTermMax: 20,
        softThreshold: 5000,
        hardThreshold: 20000,
        preserveAllDecisions: false,
        enableEpisodic: true,
      };
    case "aggressive":
      return {
        recentActivityMax: 3,
        keyDecisionsMax: 3,
        longTermMax: 5,
        softThreshold: 3000,
        hardThreshold: 10000,
        preserveAllDecisions: false,
        enableEpisodic: false,
      };
  }
}

/**
 * Trigger compression based on memory mode and token thresholds.
 */
export function triggerCompressionIfNeeded(
  state: ProjectState,
  mode: MemoryMode = "balanced"
): ProjectState {
  const config = getCompressionConfig(mode);
  const stateText = serializeStateToMarkdown(state);
  const tokenCount = estimateTokens(stateText);

  // Rotate recent activity to max
  if (state.recentActivity.length > config.recentActivityMax) {
    const excess = state.recentActivity.slice(config.recentActivityMax);
    state.recentActivity = state.recentActivity.slice(0, config.recentActivityMax);
    for (const old of excess) {
      state.longTermSummaries = [
        ...state.longTermSummaries,
        `[Compressed] ${old.substring(0, 200)}`,
      ];
    }
  }

  // Soft threshold
  if (tokenCount > config.softThreshold && state.recentActivity.length > 1) {
    const oldest = state.recentActivity[state.recentActivity.length - 1];
    state.longTermSummaries = [
      ...state.longTermSummaries,
      `[Compressed] ${oldest.substring(0, 200)}`,
    ].slice(-config.longTermMax);
    state.recentActivity = state.recentActivity.slice(0, -1);
  }

  // Compress key decisions if not preserving all
  if (!config.preserveAllDecisions && state.keyDecisions.length > config.keyDecisionsMax) {
    state.keyDecisions = state.keyDecisions.slice(-config.keyDecisionsMax);
  }

  // Hard threshold
  const newTokenCount = estimateTokens(serializeStateToMarkdown(state));
  if (newTokenCount > config.hardThreshold && state.longTermSummaries.length > 5) {
    state.longTermSummaries = state.longTermSummaries.slice(-5);
  }

  return state;
}

/**
 * Build the structured builder prompt from state + episodes + last output.
 * Target: <7,000 tokens for balanced mode, adjustable for conservative/aggressive.
 */
export function buildBuilderPrompt(
  state: ProjectState,
  relevantEpisodes: Array<{ summary: string }>,
  lastPolisherOutput: string | null,
  currentPrompt: string,
  mode: MemoryMode = "balanced"
): { prompt: string; estimatedTokens: number } {
  const config = getCompressionConfig(mode);
  const parts: string[] = [];

  // Section 1: Goal (always included)
  parts.push(`## Project Goal\n${state.goal}`);

  // Section 2: Key Decisions (if any)
  if (state.keyDecisions.length > 0) {
    const decisions = config.preserveAllDecisions
      ? state.keyDecisions
      : state.keyDecisions.slice(-config.keyDecisionsMax);
    parts.push(`\n## Key Decisions\n${decisions.map((d) => `- ${d}`).join("\n")}`);
  }

  // Section 3: Recent Activity (if any)
  if (state.recentActivity.length > 0) {
    const activity = state.recentActivity.slice(0, config.recentActivityMax);
    parts.push(`\n## Recent Activity\n${activity.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  }

  // Section 4: Relevant Past Context (episodic memory) — disabled in aggressive mode
  if (config.enableEpisodic !== false && relevantEpisodes.length > 0) {
    parts.push(`\n## Relevant Past Context\n${relevantEpisodes.map((ep) => `- ${ep.summary}`).join("\n")}`);
  }

  // Section 5: Previous Work (full last polisher output)
  if (lastPolisherOutput) {
    parts.push(`\n## Previous Work (Continue from here)\n${lastPolisherOutput}`);
  }

  // Section 6: Current Task
  parts.push(`\n## Your Task\n${currentPrompt}\n\nProvide a complete, high-quality response. Build on the Previous Work if provided.`);

  const prompt = parts.join("\n");
  const estimatedTokens = estimateTokens(prompt);

  return { prompt, estimatedTokens };
}

/**
 * Serialize state to markdown for Gitee storage.
 */
export function serializeStateToMarkdown(state: ProjectState): string {
  const parts = [
    `# Project State`,
    ``,
    `## Goal`,
    state.goal,
    ``,
    `## Key Decisions`,
    ...state.keyDecisions.map((d) => `- ${d}`),
    ``,
    `## Recent Activity`,
    ...state.recentActivity.map((a, i) => `${i + 1}. ${a}`),
    ``,
    `## Open References`,
    ...state.openReferences,
    ``,
  ];

  if (state.longTermSummaries.length > 0) {
    parts.push(`## Long-term Summaries`, ...state.longTermSummaries.map((s) => `- ${s}`), ``);
  }

  return parts.join("\n");
}

/**
 * Parse state from markdown (fetched from Gitee).
 */
export function parseStateFromMarkdown(markdown: string): ProjectState | null {
  try {
    const lines = markdown.split("\n");
    const state: ProjectState = {
      goal: "",
      keyDecisions: [],
      recentActivity: [],
      openReferences: [],
      longTermSummaries: [],
    };
    let section = "";

    for (const line of lines) {
      if (line.startsWith("## Goal")) { section = "goal"; continue; }
      if (line.startsWith("## Key Decisions")) { section = "decisions"; continue; }
      if (line.startsWith("## Recent Activity")) { section = "activity"; continue; }
      if (line.startsWith("## Open References")) { section = "refs"; continue; }
      if (line.startsWith("## Long-term")) { section = "longterm"; continue; }
      if (line.startsWith("# ")) continue;

      const trimmed = line.trim();
      if (!trimmed) continue;

      switch (section) {
        case "goal": state.goal = trimmed; break;
        case "decisions": if (trimmed.startsWith("- ")) state.keyDecisions.push(trimmed.slice(2)); break;
        case "activity": if (/^\d+\./.test(trimmed)) state.recentActivity.push(trimmed.replace(/^\d+\.\s*/, "")); break;
        case "refs": state.openReferences.push(trimmed); break;
        case "longterm": if (trimmed.startsWith("- ")) state.longTermSummaries.push(trimmed.slice(2)); break;
      }
    }

    return state.goal ? state : null;
  } catch {
    return null;
  }
}
