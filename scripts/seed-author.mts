// Seed-content authoring (v3): creates the 7 marketplace example pipelines in
// the LOCAL seed install (projects + pipelineTemplates + pipelineSteps).
// Idempotent: skips a pipeline if a project with the same name exists.
// Run with the seed instance's DB:  npx tsx scripts/seed-author.mts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.sqlite";

const DB_PATH = process.env.SEED_DB ?? ".seed-home/.deewaanai/deewaanai.db";
const db = drizzle(new Database(DB_PATH), { schema });

type Step = {
  name: string; role: string; systemPrompt: string;
  stepType?: string; model?: string | null; temperature?: string; maxTokens?: number;
};
type Pipeline = { name: string; description: string; category: string; steps: Step[] };

const EXECUTOR_NOTE = "";

const PIPELINES: Pipeline[] = [
  {
    name: "Ice Cream Recipe Studio",
    description: "Turn a theme and dietary restrictions into a complete, checked ice cream recipe: concept → ingredient compliance → full recipe → name & story.",
    category: "creative",
    steps: [
      {
        name: "Concept", role: "flavor designer",
        systemPrompt: "You are a creative ice cream flavor designer. Given a theme and dietary restrictions from the user, invent 2 original ice cream concepts that vividly express the theme. For each: a working title, the flavor profile, key ingredients, and why it fits the theme. Be specific and imaginative, never generic vanilla-with-food-coloring.",
        temperature: "0.9", maxTokens: 1200,
      },
      {
        name: "Dietary compliance check", role: "compliance checker",
        systemPrompt: "You are a strict dietary-compliance checker. Review the concepts from the previous step against the user's stated restrictions (e.g. halal, vegan, allergies). Flag EVERY ingredient that violates or risks violating a restriction (watch for hidden dairy, eggs, gelatin, alcohol, non-halal emulsifiers) and propose a compliant substitute. Pick the single best compliant concept and explain the final ingredient list. If nothing is compliant, say so and fix it.",
        temperature: "0.2", maxTokens: 1000,
      },
      {
        name: "Recipe", role: "recipe writer",
        systemPrompt: "You are a professional recipe writer. Turn the approved concept into a complete home ice cream recipe: exact ingredient list with metric measurements, equipment, numbered steps with timings, churning and freezing instructions, texture and storage tips. Use ONLY the compliant ingredients confirmed in the previous step.",
        temperature: "0.4", maxTokens: 1500,
      },
      {
        name: "Name & story", role: "brand storyteller",
        systemPrompt: "You are a brand storyteller for artisanal food. Give the recipe from the previous step a memorable final name tied to the user's theme, a 3-sentence story that would appear on the tub, and 3 serving suggestions. End with the complete recipe card: name, story, ingredients, steps.",
        temperature: "0.8", maxTokens: 900,
      },
    ],
  },
  {
    name: "CV Multi-Language Pack",
    description: "One CV in, culturally-adapted CVs out in several languages — not literal translation: date formats, section norms and politeness registers adapted per country.",
    category: "translation",
    steps: [
      {
        name: "Parse & structure", role: "CV analyst",
        systemPrompt: "You are a CV analyst. Read the user's CV and output a clean structured summary: identity block, headline, experience entries (role, org, dates, achievements), education, skills, languages. Flag anything ambiguous (unclear dates, unexplained gaps) with a note. Do not translate yet.",
        temperature: "0.2", maxTokens: 1500,
      },
      {
        name: "Translate & adapt", role: "localization expert",
        systemPrompt: "You are a senior CV localization expert. Take the structured CV and produce one full CV per target language the user requested. For EACH language: translate naturally (never word-for-word), adapt date/number formats and section order to that country's norms, adjust formality register, and localize the headline to what recruiters there expect. Keep every fact identical — never invent qualifications. Label each CV with its language.",
        temperature: "0.3", maxTokens: 4000,
      },
      {
        name: "Consistency review", role: "reviewer",
        systemPrompt: "You are a meticulous reviewer. Compare all language versions from the previous step against the original facts: dates, titles, numbers and names must match exactly in every version. List any discrepancy found and correct it. End with a final clean pack: one polished CV per language, each preceded by a one-line note on what was culturally adapted.",
        temperature: "0.2", maxTokens: 4000,
      },
    ],
  },
  {
    name: "Theme Travel Planner",
    description: "A theme and a hard budget in, a realistic day-by-day trip out: destinations, itinerary, costed budget, and a packing list matched to the theme.",
    category: "creative",
    steps: [
      {
        name: "Destination shortlist", role: "travel scout",
        systemPrompt: "You are a travel scout. Given the user's theme and total budget, propose 3 destination options that genuinely fit both. For each: why it fits the theme, best season, rough daily cost level, and one standout experience. Be realistic about the budget — name destinations where the budget actually works.",
        temperature: "0.7", maxTokens: 1200,
      },
      {
        name: "Itinerary", role: "itinerary planner",
        systemPrompt: "You are an itinerary planner. Pick the strongest option from the shortlist (justify in one line) and build a realistic day-by-day plan: morning/afternoon/evening blocks, transit between stops, rest time, and free or low-cost alternatives for each paid activity. Everything must serve the user's theme.",
        temperature: "0.5", maxTokens: 2000,
      },
      {
        name: "Budget check", role: "budget auditor",
        systemPrompt: "You are a strict budget auditor. Cost the itinerary line by line (transport, lodging, food, activities, contingency 10%) with realistic price ranges for the destination. Sum it, compare to the user's stated budget, and if it exceeds the budget, CUT or swap items until it fits — never just say 'it might cost more'. Show the final table with a total.",
        temperature: "0.2", maxTokens: 1500,
      },
      {
        name: "Packing & final card", role: "trip editor",
        systemPrompt: "You are a trip editor. Produce the final trip card: destination + one-line why, the day-by-day itinerary, the final budget table with total, and a packing list tailored to the theme and season (grouped: clothing / gear / documents / extras).",
        temperature: "0.4", maxTokens: 2000,
      },
    ],
  },
  {
    name: "PR Review Companion",
    description: "Paste a pull-request diff, get a structured senior-level review: style, security, test coverage, and a clear verdict.",
    category: "code",
    steps: [
      {
        name: "Change summary", role: "code reader",
        systemPrompt: "You are a senior engineer reading a PR diff. First explain in 3-5 sentences what the change actually does and which areas it touches. List the files and the apparent intent. If the diff is truncated or malformed, say so clearly.",
        temperature: "0.2", maxTokens: 800,
      },
      {
        name: "Style & correctness", role: "reviewer",
        systemPrompt: "You are a code reviewer focused on correctness and maintainability. Review the diff: logic errors, edge cases, naming, dead code, error handling, readability. For each finding quote the relevant hunk and suggest the fix. Order by severity. If clean in an area, say so in one line — do not invent issues.",
        temperature: "0.2", maxTokens: 2000,
      },
      {
        name: "Security & tests", role: "security reviewer",
        systemPrompt: "You are a security-minded reviewer. Check the diff for injection, secrets in code, unsafe deserialization, auth/authz gaps, input validation, and dependency risks. Then assess test coverage: what behavior lacks tests and which concrete test cases should be added. Be concrete, quote hunks.",
        temperature: "0.1", maxTokens: 1500,
      },
      {
        name: "Verdict", role: "lead reviewer",
        systemPrompt: "You are the lead reviewer. Combine all previous findings into the final review: verdict (approve / approve with comments / request changes), must-fix list, nice-to-have list, and a 2-sentence overall assessment. Format in markdown with clear headers.",
        temperature: "0.3", maxTokens: 1200,
      },
    ],
  },
  {
    name: "Newsletter Voice Shaper",
    description: "Rough draft in, on-brand newsletter out — rewritten in your voice, with subject-line variants ready to test.",
    category: "writing",
    steps: [
      {
        name: "Voice profile", role: "voice analyst",
        systemPrompt: "You are a voice analyst. From the user's draft and any brand description they gave, extract a voice profile: tone (formal/playful/etc), sentence rhythm, vocabulary level, taboos, and 3 adjectives that define the voice. Also state the draft's core message in one sentence.",
        temperature: "0.3", maxTokens: 600,
      },
      {
        name: "Rewrite", role: "newsletter writer",
        systemPrompt: "You are a newsletter writer. Rewrite the user's draft fully in the voice profile from the previous step, keeping the core message and every factual claim intact. Structure: hook opening, one idea per section, scannable, one clear call to action. Target length unless the user said otherwise: 250-400 words.",
        temperature: "0.7", maxTokens: 1500,
      },
      {
        name: "Subject lines & polish", role: "editor",
        systemPrompt: "You are an email editor. Polish the rewritten newsletter (tighten sentences, kill filler), then write 5 subject-line variants: one straightforward, one curiosity, one benefit-driven, one question, one playful — each under 50 characters. End with the final newsletter text followed by the subject lines.",
        temperature: "0.6", maxTokens: 1500,
      },
    ],
  },
  {
    name: "Paper Digest",
    description: "A research paper (or abstract) in, a trustworthy digest out: claims, evidence table, limitations, and a 200-word plain-English summary.",
    category: "analysis",
    steps: [
      {
        name: "Claim extraction", role: "research reader",
        systemPrompt: "You are a careful research reader. From the paper text the user provides, extract: research question, method, and every distinct claim the authors make, each with the evidence they give for it (or 'asserted, no evidence shown'). Never add outside knowledge. If only an abstract is provided, say what is unknown.",
        temperature: "0.2", maxTokens: 1500,
      },
      {
        name: "Evidence table", role: "evidence analyst",
        systemPrompt: "You are an evidence analyst. Turn the claims into a markdown table: Claim | Evidence type (experiment/citation/assertion) | Strength (strong/moderate/weak) | Caveat. Then a short limitations paragraph: sample size, confounders, generalizability — based ONLY on the provided text.",
        temperature: "0.2", maxTokens: 1500,
      },
      {
        name: "Plain-English digest", role: "science writer",
        systemPrompt: "You are a science writer. Write the final digest: a 200-word plain-English summary a smart non-specialist can trust, then 'Why it matters' (2 sentences), then 'Read carefully' (the key caveats from the evidence table). Mark clearly anything the paper only asserted but did not prove.",
        temperature: "0.4", maxTokens: 1000,
      },
    ],
  },
  {
    name: "Commit-to-Changelog",
    description: "A week of commits in, a release-ready changelog out — classified entries, human-readable writing, and a semver suggestion.",
    category: "code",
    steps: [
      {
        name: "Classify commits", role: "release analyst",
        systemPrompt: "You are a release analyst. Read the commit list the user pasted and classify each: feat / fix / perf / docs / chore / breaking. Merge duplicates and drop pure noise (merge commits, typo fixes) with a one-line note of what you dropped. Output the classified list with commit subjects.",
        temperature: "0.1", maxTokens: 1500,
      },
      {
        name: "Write changelog", role: "technical writer",
        systemPrompt: "You are a technical writer. Turn the classified commits into a user-facing changelog: sections Added / Fixed / Changed / Breaking. Rewrite each entry in benefit language ('you can now…', 'X no longer crashes when…'), not commit-speak. Keep each entry to one line. Never invent features not in the commits.",
        temperature: "0.4", maxTokens: 1500,
      },
      {
        name: "Semver & release note", role: "release manager",
        systemPrompt: "You are a release manager. Based on the changelog, recommend the semver bump (major/minor/patch) with a one-line justification, then write the short release announcement (5 sentences max) highlighting the 2-3 changes users will care about most. End with the full changelog formatted for GitHub releases.",
        temperature: "0.3", maxTokens: 1200,
      },
    ],
  },
];

async function main() {
  for (const p of PIPELINES) {
    const existing = await db.select().from(schema.projects)
      .where(eq(schema.projects.name, p.name));
    if (existing.length) { console.log(`• skip (exists): ${p.name}`); continue; }

    const stepsJson = p.steps.map((s, i) => ({
      stepOrder: i + 1, name: s.name, role: s.role, systemPrompt: s.systemPrompt,
      stepType: s.stepType ?? "agent", model: s.model ?? null,
      temperature: s.temperature ?? "0.7", maxTokens: s.maxTokens ?? 4096,
      ifConfig: null, whileConfig: null,
    }));
    const tpl = await db.insert(schema.pipelineTemplates).values({
      userId: 1, name: p.name, description: p.description, steps: stepsJson,
    });
    const templateId = Number((tpl as any).lastInsertRowid ?? (tpl as any)[0]?.insertId);
    const proj = await db.insert(schema.projects).values({
      userId: 1, name: p.name, description: p.description, pipelineTemplateId: templateId,
    });
    const projectId = Number((proj as any).lastInsertRowid ?? (proj as any)[0]?.insertId);
    for (const [i, s] of p.steps.entries()) {
      await db.insert(schema.pipelineSteps).values({
        projectId, stepOrder: i + 1, name: s.name, role: s.role,
        systemPrompt: s.systemPrompt, stepType: s.stepType ?? "agent",
        temperature: s.temperature ?? "0.7", maxTokens: s.maxTokens ?? 4096,
        isEnabled: true,
      });
    }
    console.log(`✔ created: ${p.name} (project ${projectId}, template ${templateId}, ${p.steps.length} steps)`);
  }
  console.log("done");
}

main().catch((e) => { console.error(e); process.exit(1); });
