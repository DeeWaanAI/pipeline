// Poetry-themed tier names for DeeWaanAI (诗斋)
// Internal keys: standard / pro_designer / pro_auto
export const TIERS = {
  standard:     { label: "Artist",  short: "Artist",  color: "neutral" as const, desc: "Fixed pipeline, 1 LLM" },
  pro_designer: { label: "Master",  short: "Master",  color: "blue"    as const, desc: "Custom pipelines, 3 LLMs" },
  pro_auto:     { label: "Sage",    short: "Sage",    color: "amber"   as const, desc: "AI-designed pipelines" },
};
