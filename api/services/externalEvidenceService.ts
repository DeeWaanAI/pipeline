import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import {
  externalEvidenceReports, evidencePublications, marketplaceListings, marketplaceListingV2,
  pipelineVersions, type ExternalEvidenceReport,
} from "@db/schema";
import { getDb } from "../queries/connection";
import { assertPublicationEnabled, scanForSecrets } from "./evidenceService";
import { stableStringify } from "./benchmark/benchmarkCallPlan";
import { lockForUpdate } from "../queries/connection";

export const EXTERNAL_CONSENT_VERSION = "external-report-v1";
export const EXTERNAL_VERIFICATION_NOTICE = "User-reported; not independently verified. The declared date is supplied by the author, not a platform test time.";

const idSchema = z.number().int().positive().max(2_147_483_647);
const boundedText = (max: number) => z.string().max(max)
  .transform((text) => text.replace(/\r\n?/g, "\n").normalize("NFC").trim())
  .pipe(z.string().min(1).max(max).refine((text) => Array.from(text).every((character) => {
    const code = character.codePointAt(0)!;
    return (code >= 32 || code === 9 || code === 10) && code !== 127 && !(code >= 0xd800 && code <= 0xdfff);
  }), "Unsupported control character or invalid Unicode"));

export const previewExternalInputSchema = z.object({
  listingId: idSchema,
  workflowVersionId: idSchema.nullish(),
  declaredInputs: boundedText(32_000),
  declaredOutputs: boundedText(32_000),
  declaredModel: boundedText(200).nullish(),
  declaredDate: boundedText(40).nullish().describe("Author-declared date text; never interpreted as a platform test timestamp"),
  declaredRubric: boundedText(8_000).nullish(),
  notes: boundedText(8_000).nullish(),
  consentVersion: z.literal(EXTERNAL_CONSENT_VERSION),
}).strict();

export const reportExternalInputSchema = previewExternalInputSchema.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  publishConsent: z.literal(true).describe("Explicit user consent to publish the exact previewed content publicly"),
}).strict();

export const getExternalInputSchema = z.object({ reportId: idSchema }).strict();
export const withdrawExternalInputSchema = z.object({ reportId: idSchema }).strict();
export const listExternalInputSchema = z.object({
  listingId: idSchema,
  limit: z.number().int().min(1).max(50).default(20),
  beforeId: idSchema.optional(),
}).strict();

type PreviewInput = z.output<typeof previewExternalInputSchema>;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReportContent = Pick<ExternalEvidenceReport,
  "authorId" | "listingId" | "workflowVersionId" | "declaredInputs" | "declaredOutputs" |
  "declaredModel" | "declaredDate" | "declaredRubric" | "notes"
> & { provenance: "user_reported"; verificationNotice: typeof EXTERNAL_VERIFICATION_NOTICE };

export type ExternalReportDto = ReportContent & Pick<ExternalEvidenceReport,
  "publicationState" | "consentVersion" | "previewHash"
> & {
  reportId: number;
  reportedAt: string;
  // Platform publication lifecycle timestamps, never evidence of a platform test.
  publishedAt: string | null;
  withdrawnAt: string | null;
};
export interface ExternalReportPreview {
  report: ReportContent;
  consentVersion: typeof EXTERNAL_CONSENT_VERSION;
  previewHash: string;
  secretFindings: string[];
}

function publicListings(db: Db | Tx) {
  return db.select({ listingId: marketplaceListings.id }).from(marketplaceListings)
    .innerJoin(marketplaceListingV2, and(
      eq(marketplaceListingV2.listingId, marketplaceListings.id),
      eq(marketplaceListingV2.publicationMode, "v2"),
    ))
    .innerJoin(pipelineVersions, and(
      eq(pipelineVersions.id, marketplaceListingV2.currentWorkflowVersionId),
      eq(pipelineVersions.ownerId, marketplaceListings.creatorId),
    ))
    .innerJoin(evidencePublications, and(
      eq(evidencePublications.id, marketplaceListingV2.currentEvidencePublicationId),
      eq(evidencePublications.listingId, marketplaceListings.id),
      eq(evidencePublications.listingWorkflowVersionId, pipelineVersions.id),
      eq(evidencePublications.authorId, marketplaceListings.creatorId),
      eq(evidencePublications.publicationKind, "seller"),
      eq(evidencePublications.state, "published"),
    ));
}

async function assertPublicTarget(db: Db | Tx, input: PreviewInput, lock = false) {
  const query = publicListings(db).where(and(
    eq(marketplaceListings.id, input.listingId),
    eq(marketplaceListings.status, "published"),
    input.workflowVersionId == null ? undefined : eq(marketplaceListingV2.currentWorkflowVersionId, input.workflowVersionId),
  )).limit(1);
  const [listing] = await (lock ? lockForUpdate(query) : query);
  if (!listing) throw new Error("not_found_or_not_authorized");
}

function buildPreview(authorId: number, input: PreviewInput): ExternalReportPreview {
  const report: ReportContent = {
    authorId,
    listingId: input.listingId,
    workflowVersionId: input.workflowVersionId ?? null,
    declaredInputs: input.declaredInputs,
    declaredOutputs: input.declaredOutputs,
    declaredModel: input.declaredModel ?? null,
    declaredDate: input.declaredDate ?? null,
    declaredRubric: input.declaredRubric ?? null,
    notes: input.notes ?? null,
    provenance: "user_reported",
    verificationNotice: EXTERNAL_VERIFICATION_NOTICE,
  };
  const serialized = stableStringify({ report, consentVersion: input.consentVersion });
  // Scan field text too: JSON escaping must not conceal quoted secret assignments.
  const secretFindings = [...new Set([
    ...scanForSecrets(serialized),
    ...Object.values(report).flatMap((value) => typeof value === "string" ? scanForSecrets(value) : []),
  ])];
  return {
    report, consentVersion: input.consentVersion,
    previewHash: createHash("sha256").update(serialized).digest("hex"),
    secretFindings,
  };
}

function reportDto(row: ExternalEvidenceReport): ExternalReportDto {
  return {
    reportId: row.id,
    authorId: row.authorId,
    listingId: row.listingId,
    workflowVersionId: row.workflowVersionId,
    declaredInputs: row.declaredInputs,
    declaredOutputs: row.declaredOutputs,
    declaredModel: row.declaredModel,
    declaredDate: row.declaredDate,
    declaredRubric: row.declaredRubric,
    notes: row.notes,
    provenance: "user_reported",
    verificationNotice: EXTERNAL_VERIFICATION_NOTICE,
    reportedAt: row.createdAt.toISOString(),
    publicationState: row.publicationState,
    consentVersion: row.consentVersion,
    previewHash: row.previewHash,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
  };
}

export async function previewExternal(userId: number, raw: unknown): Promise<ExternalReportPreview> {
  const authorId = idSchema.parse(userId);
  const input = previewExternalInputSchema.parse(raw);
  await assertPublicTarget(getDb(), input);
  return buildPreview(authorId, input);
}

export async function reportExternal(userId: number, raw: unknown) {
  const authorId = idSchema.parse(userId);
  const input = reportExternalInputSchema.parse(raw);
  await assertPublicationEnabled(authorId);
  return getDb().transaction(async (tx) => {
    await assertPublicTarget(tx, input, true);
    const preview = buildPreview(authorId, input);
    if (preview.secretFindings.length) {
      throw new Error(`publication_refused: redact ${preview.secretFindings.join(", ")} before publishing`);
    }
    if (preview.previewHash !== input.previewHash) throw new Error("preview_changed: preview again and confirm the exact disclosure");
    // The listing lock serializes publishes. Include withdrawn rows so a delayed
    // retry cannot undo withdrawal; lock the row to coordinate with withdrawal.
    const [existing] = await lockForUpdate(tx.select().from(externalEvidenceReports).where(and(
      eq(externalEvidenceReports.authorId, authorId),
      eq(externalEvidenceReports.listingId, input.listingId),
      eq(externalEvidenceReports.previewHash, preview.previewHash),
    )).limit(1));
    if (existing) return { report: reportDto(existing), previewHash: existing.previewHash, consentVersion: existing.consentVersion };
    const [inserted] = await tx.insert(externalEvidenceReports).values({
      publicationState: "published",
      consentVersion: preview.consentVersion,
      previewHash: preview.previewHash,
      publishedAt: new Date(),
      authorId,
      listingId: preview.report.listingId,
      workflowVersionId: preview.report.workflowVersionId,
      declaredInputs: preview.report.declaredInputs,
      declaredOutputs: preview.report.declaredOutputs,
      declaredModel: preview.report.declaredModel,
      declaredDate: preview.report.declaredDate,
      declaredRubric: preview.report.declaredRubric,
      notes: preview.report.notes,
    });
    const reportId = Number(inserted.insertId);
    const [row] = await tx.select().from(externalEvidenceReports)
      .where(eq(externalEvidenceReports.id, reportId)).limit(1);
    return { report: reportDto(row), previewHash: preview.previewHash, consentVersion: preview.consentVersion };
  });
}

export async function withdrawExternal(userId: number, raw: unknown): Promise<ExternalReportDto> {
  const authorId = idSchema.parse(userId);
  const { reportId } = withdrawExternalInputSchema.parse(raw);
  // Withdrawal must remain available even when publication is disabled or the
  // target listing is no longer public. Never remove content or consent proof.
  return getDb().transaction(async (tx) => {
    const ownedReport = and(eq(externalEvidenceReports.id, reportId), eq(externalEvidenceReports.authorId, authorId));
    const [row] = await lockForUpdate(tx.select().from(externalEvidenceReports).where(ownedReport).limit(1));
    if (!row) throw new Error("not_found_or_not_authorized");
    if (row.publicationState === "withdrawn") return reportDto(row);
    await tx.update(externalEvidenceReports).set({ publicationState: "withdrawn", withdrawnAt: new Date() }).where(ownedReport);
    const [withdrawn] = await tx.select().from(externalEvidenceReports).where(ownedReport).limit(1);
    return reportDto(withdrawn);
  });
}

export async function getExternal(raw: unknown): Promise<ExternalReportDto | null> {
  const { reportId } = getExternalInputSchema.parse(raw);
  const db = getDb();
  const [row] = await db.select().from(externalEvidenceReports).where(and(
    eq(externalEvidenceReports.id, reportId),
    eq(externalEvidenceReports.publicationState, "published"),
    inArray(externalEvidenceReports.listingId, publicListings(db).where(eq(marketplaceListings.status, "published"))),
  )).limit(1);
  return row ? reportDto(row) : null;
}

export async function listExternal(raw: unknown): Promise<ExternalReportDto[]> {
  const input = listExternalInputSchema.parse(raw);
  const db = getDb();
  const rows = await db.select().from(externalEvidenceReports).where(and(
    eq(externalEvidenceReports.listingId, input.listingId),
    eq(externalEvidenceReports.publicationState, "published"),
    inArray(externalEvidenceReports.listingId, publicListings(db).where(eq(marketplaceListings.status, "published"))),
    input.beforeId ? lt(externalEvidenceReports.id, input.beforeId) : undefined,
  )).orderBy(desc(externalEvidenceReports.id)).limit(input.limit);
  return rows.map(reportDto);
}
