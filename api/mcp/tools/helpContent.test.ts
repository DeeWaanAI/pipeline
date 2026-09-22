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
  it("shows every ungated tool to any account, and still hides the flag-gated ones", () => {
    const help = buildHelp(base());
    const names = toolNames(help);
    expect(names).toContain("list_pipelines");
    expect(names).toContain("run_pipeline");
    expect(names).toContain("create_pipeline");
    expect(names).toContain("deewaanai_help");
    expect(names).toContain("get_settings");
    // No plan ladder (owner decision 2026-09-22): auto-design is open to
    // every account, so the guide must not hide it behind an entitlement.
    expect(names).toContain("design_pipeline");
    expect(names).not.toContain("sample_ping");     // needs mcp_sampling flag
    expect(names).not.toContain("run_batch");       // needs batch_mode flag
  });

  it("does not gate a tool on a capability any more", () => {
    const plain = toolNames(buildHelp(base()));
    const withCaps = toolNames(buildHelp(base({ capabilities: ["pipeline:autodesign", "pipeline:custom"] })));
    expect(plain).toContain("design_pipeline");
    expect(withCaps).toEqual(plain);
  });

  it("has no team surface under any flag", () => {
    const off = toolNames(buildHelp(base({ flags: { teamsync: false, mcp_sampling: false, batch_mode: false } })));
    const on = toolNames(buildHelp(base({ flags: { teamsync: true, mcp_sampling: false, batch_mode: false } })));
    expect(off.filter((n) => n.startsWith("team_"))).toEqual([]);
    expect(on.filter((n) => n.startsWith("team_"))).toEqual([]);
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

  it("states the commercial model in the tips, and never sells a tier", () => {
    const help = buildHelp(base());
    const tips = help.tips.join(" ");
    expect(tips).toMatch(/subscription/i);
    expect(tips).not.toMatch(/tier|upgrade_tier|top plan|pro_designer|pro_auto/i);
  });

  it("keeps section order stable and never emits empty sections", () => {
    const help = buildHelp(base({
      capabilities: ["pipeline:autodesign"],
      flags: { mcp_sampling: true, batch_mode: true },
    }));
    const groups = help.sections.map((s) => s.group);
    // "Publish" appears even with v2Publication off because reading already
    // published evidence is available to anyone — see the next test for the
    // gated half of that section. "Team" is gone with the team features.
    expect(groups).toEqual(["Discover", "Run", "Research", "Author", "Marketplace", "Publish", "Account", "Your data", "Diagnostics"]);
    for (const s of help.sections) expect(s.tools.length).toBeGreaterThan(0);
  });

  it("shows the v2 publisher tools only when v2Publication is enabled", () => {
    const off = buildHelp(base({ flags: { v2Publication: false } }));
    const publishTools = (help: typeof off) =>
      help.sections.find((s) => s.group === "Publish")?.tools.map((t) => t.name) ?? [];
    // Reads of already-published reports, and the author's own withdrawal
    // route, stay visible even while publication is disabled.
    expect(publishTools(off)).toEqual([
      "get_public_evidence", "get_external_evidence", "list_external_evidence", "withdraw_external_evidence",
    ]);

    const on = buildHelp(base({ flags: { v2Publication: true } }));
    expect(publishTools(on)).toContain("publish_evidence_version");
    expect(publishTools(on)).toContain("preview_evidence");
    expect(publishTools(on)).toContain("preview_external_evidence");
    expect(publishTools(on)).toContain("report_external_evidence");
    expect(publishTools(on)).toContain("withdraw_external_evidence");
  });

  it("renders no locked-for-upsell section at all — there is no plan ladder", () => {
    const help = buildHelp(base());
    expect("locked" in help).toBe(false);
    expect("upgradeCTA" in help).toBe(false);
    expect(JSON.stringify(help)).not.toContain("upgrade_tier");
    // Capability-gated copy is gone too: every tool the caller can scope into
    // is a tool they can use, and nothing sells a higher plan.
    for (const section of help.sections) {
      for (const tool of section.tools) expect("lockedReason" in tool).toBe(false);
    }
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


describe("the retired team surface stays retired", () => {
  it("no catalogue entry is a team tool or carries the teamsync flag", () => {
    expect(HELP_CATALOG.filter((e) => e.flag === "teamsync")).toEqual([]);
    expect(HELP_CATALOG.filter((e) => e.name.startsWith("team_"))).toEqual([]);
    expect(HELP_CATALOG.filter((e) => e.scopes.some((s) => s.startsWith("team:")))).toEqual([]);
  });
});
