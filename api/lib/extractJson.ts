/**
 * Robust JSON Extraction from LLM Responses
 *
 * LLMs often return JSON wrapped in markdown, with extra text,
 * or with nested braces that break naive regex matching.
 *
 * This utility tries multiple strategies in order of reliability:
 *   1. Markdown code blocks (```json ... ```)
 *   2. Balanced brace matching (counts { and })
 *   3. Greedy regex (last resort)
 *   4. Multiple candidates → picks largest valid JSON
 */

import { logger } from "./logger";

/**
 * Extract a JSON object or array from an LLM response.
 * Returns the parsed JSON, or null if nothing valid found.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Strategy 1: Already valid JSON (no wrapping)
  try {
    return JSON.parse(trimmed) as T;
  } catch { /* not standalone JSON */ }

  // Strategy 2: Markdown code blocks
  const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1]) as T;
    } catch { /* not valid JSON inside block */ }
  }

  // Strategy 3: Balanced brace matching (handles nested braces)
  const candidates = findBalancedJson(trimmed);
  if (candidates.length > 0) {
    // Sort by length descending — largest valid JSON wins
    candidates.sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T;
      } catch { /* skip invalid */ }
    }
  }

  // Strategy 4: Greedy fallback (original behavior, last resort)
  const isArray = trimmed.includes("[") && trimmed.indexOf("[") < (trimmed.indexOf("{") === -1 ? Infinity : trimmed.indexOf("{"));
  const greedyPattern = isArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const greedyMatch = trimmed.match(greedyPattern);
  if (greedyMatch) {
    try {
      return JSON.parse(greedyMatch[0]) as T;
    } catch { /* greedy also failed */ }
  }

  return null;
}

/**
 * Extract JSON and throw a detailed error on failure.
 * Use this when JSON is mandatory.
 */
export function extractJsonOrThrow<T = unknown>(raw: string, context?: string): T {
  const result = extractJson<T>(raw);
  if (result === null) {
    // Truncate raw for logging (avoid flooding)
    const preview = raw.length > 500 ? raw.substring(0, 500) + "... [truncated]" : raw;
    logger.error("[extractJson] FAILED", { context: context || undefined, preview });
    throw new Error(`Failed to parse JSON response${context ? ` (${context})` : ""}. The AI returned invalid JSON. Please try again.`);
  }
  return result;
}

// ─── Internal: balanced brace matching ──────────────────────────────

function findBalancedJson(text: string): string[] {
  const candidates: string[] = [];

  // Find all JSON objects: track { depth
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      const obj = extractBalanced(text, i, "{", "}");
      if (obj) candidates.push(obj);
    } else if (text[i] === "[") {
      const arr = extractBalanced(text, i, "[", "]");
      if (arr) candidates.push(arr);
    }
  }

  // Deduplicate: if one candidate is a substring of another, keep the larger
  const unique: string[] = [];
  for (const c of candidates) {
    const isSubstring = unique.some((u) => u.includes(c) && u.length > c.length);
    if (!isSubstring) unique.push(c);
  }

  return unique;
}

function extractBalanced(text: string, start: number, open: string, close: string): string | null {
  let depth = 1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.substring(start, i + 1);
      }
    }
  }

  return null; // Unbalanced
}
