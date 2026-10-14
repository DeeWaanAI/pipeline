// MCP tool registry (Phase 0 — Companion MCP Server).
// Each tool is an McpTool consumed by api/mcp/server.ts. Tools are registered
// here in a single flat list; the server filters/authorizes per McpAuthContext.

import type { McpTool } from "../types";
import { runPipeline } from "./runPipeline";
import { listPipelines } from "./listPipelines";
import { getPipeline } from "./getPipeline";
import { createPipeline } from "./createPipeline";
import { updatePipeline } from "./updatePipeline";
import { designPipeline } from "./designPipeline";
import { startDesignJobTool } from "./startDesignJob";
import { designJobStatus, applyDesignJobTool, cancelDesignJobTool } from "./designJobStatus";
import { BENCHMARK_TOOLS } from "./benchmarkTools";
import { deewaanaiHelp } from "./help";
import { suggestLlmProviders } from "./suggestProviders";
import { addProvider } from "./addProvider";
import { getSettings, setDefaultModel } from "./settings";
import { samplePing } from "./samplePing";
import { runStatus } from "./getRunStatus";
import { approveStep } from "./approveStep";
import { projectContext } from "./projectContext";
import { searchMarketplace } from "./searchMarketplace";
import { enrollReviewer } from "./enrollReviewer";
import { getNextReviewTask } from "./getNextReviewTask";
import { submitReviewTask } from "./submitReviewTask";
import {
  publishToMarketplace,
  submitForReview,
  getListingStatus,
  myMarketplaceListings,
  myPurchases,
  deliverPurchasedCopyTool,
} from "./marketplaceTools";
import { exportMyData } from "./portability";
import { exportRun } from "./exportRun";
import { PUBLICATION_TOOLS } from "./publicationTools";
import { EXTERNAL_EVIDENCE_TOOLS } from "./externalEvidenceTools";
import { MODEL_CATALOG_TOOLS } from "./modelCatalogTools";

export const TOOLS: McpTool[] = [
  runPipeline,
  listPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  designPipeline,
  // Offering redesign v2 — durable design jobs (hidden unless v2DesignJobs flag)
  startDesignJobTool,
  designJobStatus,
  applyDesignJobTool,
  cancelDesignJobTool,
  // Offering redesign v2 — private evaluation (hidden unless v2Benchmarks
  // flag). Owner decision D9: this is the evaluation workbench.
  ...BENCHMARK_TOOLS,
  // Offering redesign v2 — evidence publication (hidden unless v2Publication
  // flag). The seller half of the D9 workbench: preview, consent, publish.
  ...PUBLICATION_TOOLS,
  // Offering redesign v2 — user-declared community reports (A09). Writes are
  // flag-gated; the public reads are not, like every other published record.
  ...EXTERNAL_EVIDENCE_TOOLS,
  // Pipeline sharing between two individual accounts + the lineage rule that
  // keeps publishing with the original creator (owner decisions 2026-09-22).
  // Not flag-gated: it is gated on ownership and on the grant row, and no new
  // OAuth scope exists to gate it with.
  // D14 deliver-then-sweep, so the desktop chat client that owns the folder can
  // actually honour the storage promise from the workbench.
  // Offering redesign v2 — protected buyer execution (hidden unless
  // v2ProtectedExecution). Buyer-side half of §8.
  // Offering redesign v2 — model release awareness (§12.1). Suggestions only:
  // no public tool can record a model or fan out notices.
  ...MODEL_CATALOG_TOOLS,
  // D11 (ticket #22): feedback with the object it is about attached, per item,
  // under an explicit consent. Not flag-gated — it is an account-scoped write
  // gated by ownership alone, and the snapshot can never carry more than the
  // consenting account can already read.
  deewaanaiHelp,
  suggestLlmProviders,
  addProvider,
  getSettings,
  setDefaultModel,
  samplePing,
  runStatus,
  approveStep,
  projectContext,
  searchMarketplace,
  enrollReviewer,
  getNextReviewTask,
  submitReviewTask,
  publishToMarketplace,
  submitForReview,
  getListingStatus,
  myMarketplaceListings,
  myPurchases,
  // v3 Class A (2026-10-13): buying a listing hands over a copy. Entitlement is
  // the purchase/grant row, so this needs no flag and no payment configuration
  // to exist — and a refund closes it at the same moment it closes the run door.
  deliverPurchasedCopyTool,
  // Batch B — data portability (no lock-in, from chat)
  exportMyData,
  // Research Mode — granular run export (full step/response history)
  exportRun,
  // Research Mode — batch runs
];
