import { authRouter } from "./auth-router";
import { localAuthRouter } from "./routers/localAuth";
import { createRouter, publicQuery } from "./middleware";
import { projectRouter } from "./routers/project";
import { agentRouter } from "./routers/agent";
import { swarmRouter } from "./routers/swarm";
import { llmRouter } from "./routers/llm";
import { giteeRouter } from "./routers/gitee";
import { debugRouter } from "./routers/debug";
import { responseRouter } from "./routers/response";
import { customAgentRouter } from "./routers/customAgent";
import { pipelineRouter } from "./routers/pipeline";
import { templateRouter } from "./routers/template";
import { marketplaceRouter } from "./routers/marketplace";
import { projectFilesRouter } from "./routers/projectFiles";
import { projectImportRouter } from "./routers/projectImport";
import { teamRouter } from "./routers/team";
import { feedbackRouter } from "./routers/feedback";
import { issuesRouter } from "./routers/issues";
import { voucherRouter } from "./routers/voucher";
import { exportRouter } from "./routers/export";
import { adminRouter } from "./routers/admin";
import { notificationRouter } from "./routers/notification";
import { searchRouter } from "./routers/search";
import { testFixtureRouter } from "./routers/testFixture";
import { githubRouter } from "./routers/github";
import { billingRouter } from "./routers/billing";
import { certificationRouter } from "./routers/certification";
import { PLUGINS } from "./plugins/registry";

// Build plugin sub-routers
const pluginRouters: Record<string, any> = {};
for (const plugin of PLUGINS) {
  if (plugin.router) {
    pluginRouters[plugin.id] = plugin.router;
  }
}

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  localAuth: localAuthRouter,
  project: projectRouter,
  agent: agentRouter,
  customAgent: customAgentRouter,
  pipeline: pipelineRouter,
  template: templateRouter,
  swarm: swarmRouter,
  llm: llmRouter,
  gitee: giteeRouter,
  debug: debugRouter,
  response: responseRouter,
  marketplace: marketplaceRouter,
  projectFile: projectFilesRouter,
  projectImport: projectImportRouter,
  team: teamRouter,
  feedback: feedbackRouter,
  issues: issuesRouter,
  voucher: voucherRouter,
  export: exportRouter,
  admin: adminRouter,
  notification: notificationRouter,
  search: searchRouter,
  testFixture: testFixtureRouter,
  github: githubRouter,
  billing: billingRouter,
  certification: certificationRouter,
  // Plugin routes are namespaced under their plugin ID
  ...pluginRouters,
});

export type AppRouter = typeof appRouter;
