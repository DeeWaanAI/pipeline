#!/usr/bin/env node
// Generates db/schema.sqlite.ts from db/schema.ts (single source of truth).
// The schema file's style is uniform by convention, so this is a mechanical
// dialect mapping — if a future schema edit does not survive the transform,
// `tsc` on the generated file fails and the mapping table below is the place
// to extend it. Do NOT hand-edit db/schema.sqlite.ts; it carries a banner.
//
// Dialect mapping (mysql-core → sqlite-core):
//   int          → integer
//   bigint(n)    → integer            (only used with mode:"number" for ids)
//   mysqlEnum    → text({enum:[...]}) (arrays may span lines; comments stripped)
//   varchar(n)   → text               (SQLite ignores length; app validates)
//   mediumtext/longtext → text
//   boolean      → integer({mode:"boolean"})
//   timestamp    → integer({mode:"timestamp_ms"}) — Date round-trip preserved
//   json         → text({mode:"json"})
//   decimal      → text               (mysql2 returns decimal as string; text
//                                      preserves exactness and that behavior)
//   onUpdateNow  → $onUpdate(() => new Date())  (SQLite has no ON UPDATE)
//   autoincrement().primaryKey() → primaryKey({autoIncrement:true})

import { readFileSync, writeFileSync } from "fs";

const SRC = "db/schema.ts";
const OUT = "db/schema.sqlite.ts";

let s = readFileSync(SRC, "utf8");

// 1. Import block
const importRe = /import \{[\s\S]*?\} from "drizzle-orm\/mysql-core";/;
if (!importRe.test(s)) throw new Error("import block not found — schema.ts changed shape");
s = s.replace(importRe, `import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/sqlite-core";`);

// 2. bigint ids first (before generic int rule)
s = s.replace(/bigint\("([^"]+)", \{ mode: "number" \}\)/g, 'integer("$1")');

// 3. int → integer
s = s.replace(/\bint\(/g, "integer(");

// 4. mysqlEnum — arrays may span lines and carry // comments
const enumRe = /mysqlEnum\("([^"]+)", \[([\s\S]*?)\]\)/g;
s = s.replace(enumRe, (_m, name, arr) => {
  const clean = arr.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
  return `text("${name}", { enum: [${clean}] })`;
});

// 5. varchar → text (length dropped)
s = s.replace(/varchar\("([^"]+)", \{ length: \d+ \}\)/g, 'text("$1")');

// 6. mediumtext / longtext → text
s = s.replace(/\b(mediumtext|longtext)\(/g, "text(");

// 7. boolean → integer boolean
s = s.replace(/\bboolean\("([^"]+)"\)/g, 'integer("$1", { mode: "boolean" })');

// 8. timestamp → integer timestamp_ms
s = s.replace(/\btimestamp\("([^"]+)"\)/g, 'integer("$1", { mode: "timestamp_ms" })');

// 9. json → text json
s = s.replace(/\bjson\("([^"]+)"\)/g, 'text("$1", { mode: "json" })');

// 10. decimal → text
s = s.replace(/\bdecimal\("([^"]+)", \{ precision: \d+, scale: \d+ \}\)/g, 'text("$1")');

// 11. onUpdateNow → $onUpdate
s = s.replace(/\.onUpdateNow\(\)/g, ".$onUpdate(() => new Date())");

// 12. autoincrement primary key
s = s.replace(/\.autoincrement\(\)\.primaryKey\(\)/g, ".primaryKey({ autoIncrement: true })");

// 13. table constructor
s = s.replace(/\bmysqlTable\(/g, "sqliteTable(");

// Sanity: nothing mysql-flavoured may survive (checked on comment-stripped text)
const stripped = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
for (const leftover of ["mysqlTable", "mysqlEnum", "varchar(", "mediumtext(", "longtext(",
  "decimal(", "bigint(", "onUpdateNow", "autoincrement()", "timestamp(", "json("]) {
  if (stripped.includes(leftover)) throw new Error(`codemod incomplete: ${leftover} survived`);
}

const banner = `// GENERATED FILE — do not edit. Source of truth: db/schema.ts.
// Regenerate: node scripts/gen-sqlite-schema.mjs (the mapping rules live there).
// Parity with the MySQL schema is enforced by api/services/schemaParity.test.ts.

`;
writeFileSync(OUT, banner + s);
console.log(`wrote ${OUT} (${s.split("\n").length} lines)`);
