// ═══════════════════════════════════════════════════════════════════
//  HOSTED LINK (V3 local-first, L3) — tRPC router for the LOCAL install
// ═══════════════════════════════════════════════════════════════════
// The only cloud touchpoints of a local install (spec §5): link to a
// marketplace account via the device flow, fork a listing down as a signed
// bundle, publish an own pipeline up as a bundle. Everything else about a
// pipeline lives locally.
//
// The link token (type "device", 90d) is stored in ~/.deewaanai/hosted-link.json
// (0600) — same trust model as the local auth-token file.

import { z } from "zod";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { pipelineTemplates, projects } from "@db/schema";
import { buildPipelineBundle, bundleIntegrityHash } from "../services/pipelineBundle";
import { importPipelineBundle } from "../services/pipelineDelivery";
import { localHomeDir } from "../lib/localFirst";
import { logger } from "../lib/logger";
import { buildEvidencePreview } from "../services/evidenceService";

const LINK_FILE = "hosted-link.json";

export function hostedBaseUrl(): string {
  return (process.env.DEEWAANAI_HOSTED_URL ?? "https://app.deewaanai.com").replace(/\/$/, "");
}

type StoredLink = { token: string; hostedUrl: string; linkedAt: string };

function linkPath(): string {
  return join(localHomeDir(), LINK_FILE);
}

export function readStoredLink(): StoredLink | null {
  try {
    const parsed = JSON.parse(readFileSync(linkPath(), "utf8")) as StoredLink;
    return parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

function storeLink(link: StoredLink): void {
  mkdirSync(localHomeDir(), { recursive: true });
  writeFileSync(linkPath(), JSON.stringify(link, null, 2), { mode: 0o600 });
  try { chmodSync(linkPath(), 0o600); } catch { /* best-effort */ }
}

/** In-flight device flow (single-user install: one at a time is correct). */
let pending: { deviceCode: string; expiresAt: number } | null = null;

/** Call the hosted tRPC API with the stored device token. */
async function hostedTrpc<T>(procedure: string, input: unknown): Promise<T> {
  const link = readStoredLink();
  if (!link) throw new Error("Not linked to a marketplace account. Link first.");
  const res = await fetch(`${link.hostedUrl}/api/trpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-auth-token": link.token },
    body: JSON.stringify({ json: input }),
  });
  const body = await res.json().catch(() => null) as {
    result?: { data?: { json?: T } };
    error?: { message?: string; json?: { message?: string } };
  } | null;
  if (!res.ok || body?.error) {
    const msg = body?.error?.json?.message ?? body?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("The marketplace link expired — link again.");
    throw new Error(`Marketplace ${procedure} failed: ${msg}`);
  }
  if (!body?.result) throw new Error(`Marketplace ${procedure} returned no result`);
  return body.result.data?.json as T;
}

export const hostedLinkRouter = createRouter({
  /** Start the device flow: returns the code the user must approve on the
   *  hosted site. */
  begin: authedQuery.mutation(async () => {
    const base = hostedBaseUrl();
    const res = await fetch(`${base}/api/device/code`, { method: "POST" });
    if (!res.ok) throw new Error(`Marketplace unreachable (HTTP ${res.status})`);
    const data = await res.json() as {
      deviceCode: string; userCode: string; verificationUrl: string;
      expiresIn: number; interval: number;
    };
    pending = { deviceCode: data.deviceCode, expiresAt: Date.now() + data.expiresIn * 1000 };
    return {
      userCode: data.userCode,
      verificationUrl: data.verificationUrl,
      expiresIn: data.expiresIn,
      interval: data.interval,
    };
  }),

  /** Poll once. The UI calls this every `interval` seconds until "linked". */
  status: authedQuery.query(async () => {
    const stored = readStoredLink();
    if (stored) return { state: "linked" as const, hostedUrl: stored.hostedUrl, linkedAt: stored.linkedAt };
    if (!pending || pending.expiresAt < Date.now()) {
      pending = null;
      return { state: "idle" as const };
    }
    const base = hostedBaseUrl();
    const res = await fetch(`${base}/api/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: pending.deviceCode }),
    });
    if (res.status === 428) return { state: "waiting" as const };
    if (!res.ok) {
      pending = null;
      return { state: "idle" as const, error: `link failed (HTTP ${res.status})` };
    }
    const data = await res.json() as { token: string };
    const link: StoredLink = { token: data.token, hostedUrl: base, linkedAt: new Date().toISOString() };
    storeLink(link);
    pending = null;
    logger.info("linked to marketplace account", { hostedUrl: base });
    return { state: "linked" as const, hostedUrl: base, linkedAt: link.linkedAt };
  }),

  unlink: authedQuery.mutation(async () => {
    try { unlinkSync(linkPath()); } catch { /* not linked */ }
    pending = null;
    return { ok: true };
  }),

  /** Fork a published hosted listing into this local install. The bundle is
   *  verified offline during import (platform signature + integrity hash). */
  forkFromHosted: authedQuery
    .input(z.object({ listingId: z.number(), name: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const { bundle } = await hostedTrpc<{ bundle: unknown }>("marketplace.downloadBundle", {
        listingId: input.listingId,
      });
      const imported = await importPipelineBundle(ctx.user.id, {
        bundle, name: input.name,
      });
      return imported;
    }),

  /** Publish one of this install's own pipelines to the marketplace as a
   *  draft listing owned by the linked account. */
  publishToHosted: authedQuery
    .input(z.object({
      projectId: z.number(),
      title: z.string().min(3).max(200),
      description: z.string().max(2000).optional(),
      category: z.enum(["translation", "writing", "code", "analysis", "creative", "other"]).default("other"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)))
        .limit(1);
      if (!project) throw new Error("Project not found");
      if (!project.pipelineTemplateId) {
        throw new Error("Save the project as a pipeline template first (Project Settings).");
      }
      const [template] = await db.select().from(pipelineTemplates)
        .where(eq(pipelineTemplates.id, project.pipelineTemplateId)).limit(1);
      if (!template) throw new Error("Template not found");

      const steps = (template.steps as Array<Record<string, unknown>>).map((s, i) => ({
        stepOrder: (s.stepOrder as number) ?? i + 1,
        name: s.name as string,
        role: s.role as string,
        systemPrompt: s.systemPrompt as string,
        stepType: (s.stepType as string) ?? "agent",
        model: (s.model as string) ?? null,
        temperature: (s.temperature as string) ?? null,
        maxTokens: (s.maxTokens as number) ?? null,
        ifConfig: s.ifConfig ?? null,
        whileConfig: s.whileConfig ?? null,
      }));
      const schemaVersion = 1;
      const pipelineConfig = project.pipelineConfig ?? null;
      const hash = bundleIntegrityHash({ steps, schemaVersion, pipelineConfig });
      const bundle = buildPipelineBundle({
        pipelineName: input.title,
        pipelineDescription: input.description ?? template.description ?? null,
        steps,
        listingId: null,
        workflowVersionId: null,
        originCreatorId: ctx.user.id,
        originAccountName: ctx.user.name ?? null,
        workflowVersionNumber: null,
        definitionHash: hash,
        bundleHash: hash,
        schemaVersion,
        pipelineConfig,
        manifestHash: null,
        manifestJson: null,
        attestation: null,
        bundleAttestation: null,
      });

      return hostedTrpc<{ id: number; message: string }>("marketplace.publishBundle", {
        bundle, title: input.title, description: input.description, category: input.category,
      });
    }),

  /** Publish a LOCALLY-run benchmark as the listing's evidence. The local
   *  preview gates apply first (evidence-grade panel, no eligibility or
   *  secret findings); the hosted side re-checks the definition hash, signs
   *  with the platform key, and flips the draft listing to published. */
  publishEvidenceToHosted: authedQuery
    .input(z.object({ listingId: z.number(), benchmarkId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const preview = await buildEvidencePreview({
        userId: ctx.user.id,
        benchmarkId: input.benchmarkId,
        publicationKind: "seller",
        listingId: null, // the listing lives on hosted; identity re-anchored there
        consentVersion: "consent-v1",
      });
      if (!preview.evidenceGradePanel) {
        throw new Error(`panel not evidence-grade: ${preview.panelIssues.join("; ")}`);
      }
      if (preview.eligibilityIssues.length || preview.secretFindings.length) {
        throw new Error(`not publishable: ${[...preview.eligibilityIssues, ...preview.secretFindings].join("; ")}`);
      }
      return hostedTrpc<{ publicationId: number; manifestHash: string }>(
        "marketplace.publishLocalEvidence",
        { listingId: input.listingId, manifest: preview.manifest },
      );
    }),
});
