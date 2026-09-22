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
import { designJobStatus, cancelDesignJobTool } from "./designJobStatus";
import { BENCHMARK_TOOLS } from "./benchmarkTools";
import { deewaanaiHelp } from "./help";
import { suggestLlmProviders } from "./suggestProviders";
import { addProvider } from "./addProvider";
import { getSettings, setDefaultModel } from "./settings";
import { samplePing } from "./samplePing";
import { runStatus } from "./getRunStatus";
import { approveStep } from "./approveStep";
import { projectContext } from "./projectContext";
import { memoryGet, memoryAppend } from "./memory";
import { searchMarketplace } from "./searchMarketplace";
import { upgradeTier } from "./upgradeTier";
import { enrollReviewer } from "./enrollReviewer";
import { getNextReviewTask } from "./getNextReviewTask";
import { submitReviewTask } from "./submitReviewTask";
import {
  publishToMarketplace,
  submitForReview,
  getListingStatus,
  myMarketplaceListings,
  myPurchases,
} from "./marketplaceTools";
import { teamContextGet, teamMemoryAppend } from "./team/teamContext";
import { teamRunsList, teamRunResume } from "./team/teamRuns";
import { teamHandoff } from "./team/teamHandoff";
import { teamFeedbackSubmit } from "./team/teamFeedback";
import { teamSkillsList, teamSkillUse } from "./team/teamSkills";
import { exportPipeline, exportMyData, syncToGithub } from "./portability";
import { exportRun } from "./exportRun";
import { runBatch } from "./runBatch";
import { batchStatus } from "./batchStatus";
import { PUBLICATION_TOOLS } from "./publicationTools";
import { EXTERNAL_EVIDENCE_TOOLS } from "./externalEvidenceTools";
import { PROTECTED_EXECUTION_TOOLS } from "./protectedExecutionTools";
import { MODEL_CATALOG_TOOLS } from "./modelCatalogTools";
import { resumeBatchTool } from "./resumeBatch";
import { exportBatchResultsTool } from "./exportBatchResults";

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
  // Offering redesign v2 — protected buyer execution (hidden unless
  // v2ProtectedExecution). Buyer-side half of §8.
  ...PROTECTED_EXECUTION_TOOLS,
  // Offering redesign v2 — model release awareness (§12.1). Suggestions only:
  // no public tool can record a model or fan out notices.
  ...MODEL_CATALOG_TOOLS,
  deewaanaiHelp,
  suggestLlmProviders,
  addProvider,
  getSettings,
  setDefaultModel,
  samplePing,
  runStatus,
  approveStep,
  projectContext,
  memoryGet,
  memoryAppend,
  searchMarketplace,
  upgradeTier,
  enrollReviewer,
  getNextReviewTask,
  submitReviewTask,
  publishToMarketplace,
  submitForReview,
  getListingStatus,
  myMarketplaceListings,
  myPurchases,
  // Batch B — data portability (no lock-in, from chat)
  exportPipeline,
  exportMyData,
  syncToGithub,
  // Research Mode — granular run export (full step/response history)
  exportRun,
  // Research Mode — batch runs
  runBatch,
  batchStatus,
  resumeBatchTool,
  exportBatchResultsTool,
  // Phase 2 — TeamSync (all featureFlag: "teamsync"; the server hides
  // them from tools/list and rejects calls unless the flag is enabled).
  teamContextGet,
  teamMemoryAppend,
  teamRunsList,
  teamRunResume,
  teamHandoff,
  teamFeedbackSubmit,
  teamSkillsList,
  teamSkillUse,
];
