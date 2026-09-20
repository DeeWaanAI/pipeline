// Unit tests for the pure deewaanai_help content builder.
// No DB/network — buildHelp() takes everything as input.

import { describe, expect, it } from "vitest";
import { buildHelp, HELP_CATALOG } from "./helpContent";

const ALL_SCOPES = ["mcp:read", "mcp:run", "mcp:write", "team:read", "team:write"];

function base(overrides: Partial<Parameters<typeof buildHelp>[0]> = {}) {
  return {
    tier: "standard",
    capabilities: [] as string[],
    scopes: ALL_SCOPES,
    flags: { teamsync: false, mcp_sampling: false, batch_mode: false },
    hasProvider: true,
    samplingSupported: null,
    ...overrides,
  };
}

function toolNames(help: ReturnType<typeof buildHelp>): string[] {
  return help.sections.flatMap((s) => s.tools.map((t) => t.name));
}

describe("buildHelp", () => {
  it("shows core tools to a standard user and hides gated ones", () => {
    const help = buildHelp(base());
    const names = toolNames(help);
    expect(names).toContain("list_pipelines");
    expect(names).toContain("run_pipeline");
    expect(names).toContain("create_pipeline");
    expect(names).toContain("deewaanai_help");
    expect(names).toContain("get_settings");
    expect(names).not.toContain("design_pipeline"); // needs pipeline:autodesign
    expect(names).not.toContain("team_handoff");    // needs teamsync flag
    expect(names).not.toContain("sample_ping");     // needs mcp_sampling flag
    expect(names).not.toContain("run_batch");       // needs batch_mode flag
  });

  it("includes design_pipeline only with the autodesign capability", () => {
    const without = buildHelp(base());
    expect(toolNames(without)).not.toContain("design_pipeline");

    const withCap = buildHelp(base({ capabilities: ["pipeline:autodesign"] }));
    expect(toolNames(withCap)).toContain("design_pipeline");
  });

  it("includes team tools only when the teamsync flag is on", () => {
    const off = buildHelp(base({ flags: { teamsync: false, mcp_sampling: false, batch_mode: false } }));
    expect(toolNames(off).some((n) => n.startsWith("team_"))).toBe(false);

    const on = buildHelp(base({ flags: { teamsync: true, mcp_sampling: false, batch_mode: false } }));
    const names = toolNames(on);
    expect(names).toContain("team_handoff");
    expect(names).toContain("team_context_get");
  });

  it("includes research tools only when the batch_mode flag is on", () => {
    const off = buildHelp(base({ flags: { teamsync: false, mcp_sampling: false, batch_mode: false } }));
    expect(toolNames(off)).not.toContain("run_batch");

    const on = buildHelp(base({ flags: { teamsync: false, mcp_sampling: false, batch_mode: true } }));
    expect(toolNames(on)).toContain("run_batch");
    expect(toolNames(on)).toContain("batch_status");
    expect(toolNames(on)).toContain("resume_batch");
    expect(toolNames(on)).toContain("export_batch_results");
  });

  it("hides tools whose required scopes the caller lacks", () => {
    const readOnly = buildHelp(base({ scopes: ["mcp:read"] }));
    const names = toolNames(readOnly);
    expect(names).toContain("list_pipelines");
    expect(names).toContain("suggest_llm_providers"); // mcp:read
    expect(names).not.toContain("run_pipeline");     // mcp:run
    expect(names).not.toContain("create_pipeline");  // mcp:write
    expect(names).not.toContain("add_provider");     // mcp:write
    expect(names).not.toContain("set_default_model");
  });

  it("tips for no-provider mention suggest_llm_providers and add_provider", () => {
    const without = buildHelp(base({ hasProvider: false }));
    const tips = without.tips.join(" ");
    expect(tips).toContain("suggest_llm_providers");
    expect(tips).toContain("add_provider");
  });

  it("includes suggest_llm_providers and add_provider for standard users", () => {
    const help = buildHelp(base());
    const names = toolNames(help);
    expect(names).toContain("suggest_llm_providers");
    expect(names).toContain("add_provider");
  });

  it("tips mention the no-provider next step only when no provider is configured", () => {
    const withProvider = buildHelp(base({ hasProvider: true }));
    expect(withProvider.tips.join(" ")).not.toContain("No LLM provider is configured");

    const without = buildHelp(base({ hasProvider: false }));
    expect(without.tips.join(" ")).toContain("No LLM provider is configured");
  });

  it("tips celebrate sampling only when flag on AND client supports it", () => {
    const flagOff = buildHelp(base({
      flags: { teamsync: false, mcp_sampling: false, batch_mode: false },
      samplingSupported: true,
    }));
    expect(flagOff.tips.join(" ")).not.toContain("supports MCP sampling");

    const unsupported = buildHelp(base({
      flags: { teamsync: false, mcp_sampling: true, batch_mode: false },
      samplingSupported: false,
    }));
    expect(unsupported.tips.join(" ")).not.toContain("supports MCP sampling");

    const supported = buildHelp(base({
      flags: { teamsync: false, mcp_sampling: true, batch_mode: false },
      samplingSupported: true,
    }));
    expect(supported.tips.join(" ")).toContain("supports MCP sampling");
  });

  it("explains manual creation when autodesign is not entitled", () => {
    const help = buildHelp(base());
    expect(help.tips.join(" ")).toContain("create_pipeline");

    const entitled = buildHelp(base({ capabilities: ["pipeline:autodesign", "pipeline:custom"] }));
    expect(entitled.tips.join(" ")).not.toContain("top tier");
  });

  it("keeps section order stable and never emits empty sections", () => {
    const help = buildHelp(base({
      capabilities: ["pipeline:autodesign"],
      flags: { teamsync: true, mcp_sampling: true, batch_mode: true },
    }));
    const groups = help.sections.map((s) => s.group);
    // "Publish" appears even with v2Publication off because reading already
    // published evidence is available to anyone — see the next test for the
    // gated half of that section.
    expect(groups).toEqual(["Discover", "Run", "Research", "Author", "Marketplace", "Publish", "Account", "Your data", "Team", "Diagnostics"]);
    for (const s of help.sections) expect(s.tools.length).toBeGreaterThan(0);
  });

  it("shows the v2 publisher tools only when v2Publication is enabled", () => {
    const off = buildHelp(base({ flags: { v2Publication: false } }));
    const publishTools = (help: typeof off) =>
      help.sections.find((s) => s.group === "Publish")?.tools.map((t) => t.name) ?? [];
    expect(publishTools(off)).toEqual(["get_public_evidence"]);

    const on = buildHelp(base({ flags: { v2Publication: true } }));
    expect(publishTools(on)).toContain("publish_evidence_version");
    expect(publishTools(on)).toContain("preview_evidence");
  });

  it("shows locked tools in a separate section for upsell", () => {
    const help = buildHelp(base());
    expect(help.locked.length).toBeGreaterThan(0);
    const lockedNames = help.locked.flatMap((s) => s.tools.map((t) => t.name));
    expect(lockedNames).toContain("design_pipeline"); // needs pipeline:autodesign
    expect(help.upgradeCTA).toContain("upgrade_tier");
  });

  it("shows no locked section when user has all capabilities", () => {
    const help = buildHelp(base({
      tier: "pro_auto",
      capabilities: ["pipeline:fixed", "llm:1", "pipeline:custom", "llm:3", "marketplace:publish", "pipeline:autodesign"],
    }));
    expect(help.locked.length).toBe(0);
    expect(help.upgradeCTA).toContain("top tier");
  });

  it("catalog entries are valid", () => {
    for (const e of HELP_CATALOG) {
      expect(e.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(e.summary.length).toBeGreaterThan(10);
      expect(e.scopes.length).toBeGreaterThan(0);
    }
  });

  it("includes portability tools in the Your data group", () => {
    const help = buildHelp(base());
    const names = toolNames(help);
    expect(names).toContain("export_pipeline");
    expect(names).toContain("export_my_data");
    expect(names).toContain("sync_to_github");

    const yourDataGroup = help.sections.find((s) => s.group === "Your data");
    expect(yourDataGroup).toBeDefined();
    expect(yourDataGroup?.tools.map((t) => t.name)).toEqual([
      "export_pipeline",
      "export_my_data",
      "sync_to_github",
    ]);
  });

  it("submit_for_review describes the three-layer certification model", () => {
    const entry = HELP_CATALOG.find((e) => e.name === "submit_for_review");
    expect(entry).toBeDefined();
    expect(entry!.summary).toContain("can never approve");
    expect(entry!.summary).toContain("human consensus");
    expect(entry!.summary).not.toContain("≥3.5");
    expect(entry!.summary).not.toContain("published immediately");
  });

  it("get_listing_status uses current stage names not old grade framing", () => {
    const entry = HELP_CATALOG.find((e) => e.name === "get_listing_status");
    expect(entry).toBeDefined();
    expect(entry!.summary).toContain("generating");
    expect(entry!.summary).toContain("pending review");
    expect(entry!.summary).not.toContain("grade");
  });
});


describe("TeamSync catalog gating", () => {
  const teamTools = HELP_CATALOG.filter((e) => e.flag === "teamsync");

  it("exactly 8 entries carry flag: teamsync", () => {
    expect(teamTools).toHaveLength(8);
  });

  it("all team tools are in group Team", () => {
    for (const t of teamTools) {
      expect(t.group).toBe("Team");
    }
  });

  it("read tools carry team:read, write tools carry team:write", () => {
    const readTools = teamTools.filter((t) => t.scopes.includes("team:read"));
    const writeTools = teamTools.filter((t) => t.scopes.includes("team:write"));

    for (const t of teamTools) {
      const hasRead = t.scopes.includes("team:read");
      const hasWrite = t.scopes.includes("team:write");
      expect(hasRead || hasWrite).toBe(true);
    }

    const readNames = readTools.map((t) => t.name).sort();
    const writeNames = writeTools.map((t) => t.name).sort();

    expect(readNames).toEqual([
      "team_context_get",
      "team_runs_list",
      "team_skills_list",
    ]);
    expect(writeNames).toEqual([
      "team_feedback_submit",
      "team_handoff",
      "team_memory_append",
      "team_run_resume",
      "team_skill_use",
    ]);
  });
});
