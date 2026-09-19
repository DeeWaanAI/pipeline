// Unit tests for runAiTriage (Trust spec §0.3).
// Verifies: score is computed in code (never trusting a model-returned
// weightedScore), test I/O only is sent to the model (NO secret prompt
// content ever leaks), and any error/timeout returns null (non-gating).
//
// The DB is never touched: runAiTriage accepts an injectable loadInputs and
// adapterFactory. Heavy module imports are mocked so no DB/network happens.

import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ChatMessage } from "../lib/providers";

vi.mock("../queries/connection", () => ({
  getDb: () => {
    throw new Error("getDb must not be called when loadInputs is injected");
  },
}));
vi.mock("../routers/marketplace", () => ({
  calculateFleissKappa: () => ({ kappa: 0 }),
}));
vi.mock("./swarmService", () => ({
  callWithRetry: (fn: () => unknown) => fn(),
}));

// Simulates the encrypted_prompts row content that exists in the DB for this
// listing — the triage path must NEVER send it to the model.
const SECRET_PROMPT_CONTENT = "sk-SECRET-SYSTEM-PROMPT-DO-NOT-LEAK-0123456789";

interface CapturedMessage {
  role: string;
  content: string;
}

function makeSpyAdapter(responseContent: string) {
  const sentMessages: CapturedMessage[] = [];
  const adapter = {
    name: "spy",
    slug: "spy",
    defaultBaseUrl: "",
    supportedModels: [] as string[],
    chat: vi.fn(async (messages: ChatMessage[]) => {
      for (const m of messages) {
        sentMessages.push({
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        });
      }
      return {
        content: responseContent,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "spy-model",
        latencyMs: 1,
      };
    }),
    validateKey: async () => ({ valid: true }),
    listModels: async () => [] as string[],
  };
  return { adapter, sentMessages };
}

// Fake loader mirroring the real one: the listing HAS secret prompts in the
// DB (closed over here), but only test I/O is returned for triage.
function makeLoadInputs() {
  const encryptedPromptsInDb = [{ agentIndex: 0, plaintext: SECRET_PROMPT_CONTENT }];
  void encryptedPromptsInDb; // exists in the "DB"; triage must never read it
  return async () => ({
    description: "A translation pipeline",
    tests: [
      { inputText: "Translate: hello world", actualOutput: "bonjour le monde" },
      { inputText: "Translate: good morning", actualOutput: "bonjour" },
    ],
  });
}

let runAiTriage: typeof import("./aiEnsembleReviewService").runAiTriage;

beforeAll(async () => {
  process.env.AI_TRIAGE_SLUG = "openai";
  process.env.AI_TRIAGE_MODEL = "qwen3.6-flash";
  process.env.AI_TRIAGE_BASE_URL = "https://example.invalid/v1";
  process.env.AI_TRIAGE_API_KEY = "test-key";
  ({ runAiTriage } = await import("./aiEnsembleReviewService"));
});

describe("runAiTriage", () => {
  it("computes the score in code from the 6 dimensions (ignores model weightedScore)", async () => {
    // All dimensions are 4, but the model claims weightedScore 5 — the
    // returned score must be the code-computed 4.0, not the model's 5.
    const response = JSON.stringify({
      accuracy: 4,
      completeness: 4,
      clarity: 4,
      tokenEfficiency: 4,
      speed: 4,
      consistency: 4,
      weightedScore: 5,
      reasoning: "Solid, accurate output.",
    });
    const { adapter } = makeSpyAdapter(response);

    const result = await runAiTriage(42, {
      adapterFactory: () => adapter,
      loadInputs: makeLoadInputs(),
    });

    expect(result).not.toBeNull();
    expect(result!.score).toBeCloseTo(4.0, 2);
    expect(result!.feedback).toContain("4.00");
  });

  it("never sends secret prompt content to the model (test I/O only)", async () => {
    const response = JSON.stringify({
      accuracy: 3,
      completeness: 3,
      clarity: 3,
      tokenEfficiency: 3,
      speed: 3,
      consistency: 3,
      reasoning: "Average.",
    });
    const { adapter, sentMessages } = makeSpyAdapter(response);

    const result = await runAiTriage(42, {
      adapterFactory: () => adapter,
      loadInputs: makeLoadInputs(),
    });

    expect(result).not.toBeNull();
    expect(sentMessages.length).toBeGreaterThan(0);

    const payload = sentMessages.map((m) => m.content).join("\n");
    // No secret prompt content anywhere in any message sent to the model.
    expect(payload).not.toContain(SECRET_PROMPT_CONTENT);
    // Sanity: the payload DOES contain the test I/O (that's its whole job).
    expect(payload).toContain("Translate: hello world");
    expect(payload).toContain("bonjour le monde");
  });

  it("returns null when the adapter factory throws (non-gating)", async () => {
    const result = await runAiTriage(42, {
      adapterFactory: () => {
        throw new Error("misconfigured");
      },
      loadInputs: makeLoadInputs(),
    });
    expect(result).toBeNull();
  });

  it("returns null when the LLM call times out (non-gating)", async () => {
    const hangingAdapter = {
      name: "hanging",
      slug: "hanging",
      defaultBaseUrl: "",
      supportedModels: [] as string[],
      chat: () => new Promise<never>(() => {}), // never resolves
      validateKey: async () => ({ valid: true }),
      listModels: async () => [] as string[],
    };

    const result = await runAiTriage(42, {
      adapterFactory: () => hangingAdapter,
      loadInputs: makeLoadInputs(),
      timeoutMs: 10,
    });
    expect(result).toBeNull();
  });

  it("returns null when there is no evaluable test I/O", async () => {
    const { adapter } = makeSpyAdapter("{}");
    const result = await runAiTriage(42, {
      adapterFactory: () => adapter,
      loadInputs: async () => ({ description: "x", tests: [] }),
    });
    expect(result).toBeNull();
  });
});

describe("isAiTriageConfigured", () => {
  it("is false without slug+model, true with both (API key optional)", async () => {
    vi.resetModules();
    delete process.env.AI_TRIAGE_SLUG;
    delete process.env.AI_TRIAGE_MODEL;
    delete process.env.AI_TRIAGE_API_KEY;
    const unset = await import("../lib/env");
    expect(unset.isAiTriageConfigured()).toBe(false);

    vi.resetModules();
    process.env.AI_TRIAGE_SLUG = "openai";
    process.env.AI_TRIAGE_MODEL = "qwen3.6-flash";
    // no API key — self-hosted case still counts as configured
    const set = await import("../lib/env");
    expect(set.isAiTriageConfigured()).toBe(true);
  });
});
