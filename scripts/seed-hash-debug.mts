// Debug: compare canonical hashes on both sides for Ice Cream (listing 15,
// benchmark 48).
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { bundleIntegrityHash } from "../api/services/pipelineBundle";

const canon = (def: any) => {
  const pc = { ...(def.pipelineConfig ?? {}) };
  delete pc._importedBundle;
  return bundleIntegrityHash({
    steps: def.steps.map((s: any) => ({
      stepOrder: s.stepOrder, name: s.name, role: s.role, systemPrompt: s.systemPrompt,
      stepType: s.stepType ?? "agent", model: s.model ?? null,
      temperature: s.temperature ?? null, maxTokens: s.maxTokens ?? null,
      ifConfig: s.ifConfig ?? null, whileConfig: s.whileConfig ?? null,
    })),
    schemaVersion: Number(def.schemaVersion ?? 1),
    pipelineConfig: Object.keys(pc).length ? pc : null,
  });
};

// local benchmark version
const ldb = new Database(".seed-home/.deewaanai/deewaanai.db", { readonly: true });
const b = ldb.prepare("SELECT pipeline_version_id FROM benchmarks WHERE id=48").get() as any;
const lv = ldb.prepare("SELECT definition FROM pipeline_versions WHERE id=?").get(b.pipeline_version_id) as any;
const ldef = JSON.parse(lv.definition);
console.log("local canonical:", canon(ldef));
console.log("local step0:", JSON.stringify(ldef.steps[0]));

// hosted version for listing 15
const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const conn = await mysql.createConnection(env.DATABASE_URL!);
const [rows] = await conn.query(
  "SELECT v.definition FROM marketplace_listing_v2 m JOIN pipeline_versions v ON v.id=m.current_workflow_version_id WHERE m.listing_id=15",
);
const hdef = JSON.parse((rows as any[])[0].definition);
console.log("hosted canonical:", canon(hdef));
console.log("hosted step0:", JSON.stringify(hdef.steps[0]));
await conn.end();
