// Design generation (offering redesign v2, spec §5.1 responsibility 1):
// the ONLY place the designer LLM call happens for durable jobs. Kept in its
// own module so (a) generation/validation/persistence stay separately
// importable responsibilities, and (b) the durable orchestration in
// designJobService can be integration-tested against a real DB with this
// call deterministically faked (no provider traffic, no keys).

import { eq } from "drizzle-orm";
import { llmProviders } from "@db/schema";
import { extractJsonOrThrow } from "../lib/extractJson";
import { createProviderAdapter } from "../lib/providers";
import { getDb } from "../queries/connection";
import { decryptApiKey } from "./swarmService";
import {
  buildDesignMessages,
  normalizeDesignOutput,
  type GenerationAttemptRecord,
  type NormalizedDesign,
} from "./designJobMeta";

/** One designer generation round (incl. the single JSON-retry reminder the
 *  legacy service performs). Throws on hard failure; a timeout/network loss
 *  after dispatch is recorded as `uncertain` — the provider may still have
 *  accepted and charged the call (spec §5.3). */
export async function generateDesignCandidate(opts: {
  userId: number;
  providerId: number;
  task: string;
  attemptIndex?: number;
}): Promise<{ design: NormalizedDesign; attempt: GenerationAttemptRecord; model: string }> {
  const db = getDb();
  const [provider] = await db.select().from(llmProviders).where(eq(llmProviders.id, opts.providerId));
  if (!provider || provider.userId !== opts.userId) throw new Error("Provider not found or not owned by user");
  const apiKey = decryptApiKey(provider.apiKeyRef);
  const adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);
  const messages = buildDesignMessages(opts.task);

  const attempt: GenerationAttemptRecord = {
    attemptIndex: opts.attemptIndex ?? 1,
    outcome: "uncertain",
    model: provider.defaultModel,
    startedAt: new Date().toISOString(),
  };

  try {
    const result = await adapter.chat(messages, { temperature: 0.3, maxTokens: 4096 });
    attempt.finishedAt = new Date().toISOString();
    attempt.promptTokens = result.usage?.promptTokens;
    attempt.completionTokens = result.usage?.completionTokens;
    if (result.model) attempt.model = result.model;

    let design: NormalizedDesign;
    try {
      design = normalizeDesignOutput(extractJsonOrThrow<unknown>(result.content, "auto-design pipeline"));
    } catch (parseErr) {
      // One bounded re-ask for unparseable output (charged, recorded).
      const retryMessages = [
        ...messages,
        { role: "assistant" as const, content: result.content },
        { role: "user" as const, content: "That was not valid JSON. Output ONLY valid JSON matching the exact format requested. No markdown code blocks, no prose, no explanation — just raw JSON." },
      ];
      const retry = await adapter.chat(retryMessages, { temperature: 0.2, maxTokens: 4096 });
      attempt.promptTokens = (attempt.promptTokens ?? 0) + (retry.usage?.promptTokens ?? 0);
      attempt.completionTokens = (attempt.completionTokens ?? 0) + (retry.usage?.completionTokens ?? 0);
      design = normalizeDesignOutput(extractJsonOrThrow<unknown>(retry.content, "auto-design pipeline retry"));
      void parseErr;
    }

    attempt.outcome = "success";
    return { design, attempt, model: attempt.model };
  } catch (err) {
    const msg = (err as Error).message || "";
    if (attempt.outcome !== "success") {
      attempt.outcome = /timeout|timed out|network|socket hang|ECONN/i.test(msg) ? "uncertain" : "failed";
    }
    attempt.errorSummary = msg.slice(0, 300);
    attempt.finishedAt = new Date().toISOString();
    throw Object.assign(err as Error, { designAttempt: attempt });
  }
}
