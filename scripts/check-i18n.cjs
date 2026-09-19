#!/usr/bin/env node
/**
 * i18n key-parity check (F0.10).
 *
 * Verifies that every locale has the same key set as every other locale,
 * for both client bundles (src/locales/<lang>/*.json) and server bundles
 * (api/locales/<lang>/*.json). Exits non-zero on any mismatch — same rule
 * client and server.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE_DIRS = [
  path.join(ROOT, "src", "locales"),
  path.join(ROOT, "api", "locales"),
];

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`FAIL: cannot parse ${file}: ${err.message}`);
    process.exit(1);
  }
}

let failures = 0;

for (const dir of BUNDLE_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const locales = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  if (locales.length < 2) continue;

  // Union of namespace files across locales
  const namespaces = new Set();
  for (const loc of locales) {
    for (const f of fs.readdirSync(path.join(dir, loc))) {
      if (f.endsWith(".json")) namespaces.add(f);
    }
  }

  // Reference: first locale alphabetically
  const reference = [...locales].sort()[0];

  for (const ns of namespaces) {
    const refFile = path.join(dir, reference, ns);
    if (!fs.existsSync(refFile)) {
      console.error(`FAIL: ${path.relative(ROOT, refFile)} missing in reference locale "${reference}"`);
      failures++;
      continue;
    }
    const refKeys = new Set(flattenKeys(loadJson(refFile)));

    for (const loc of locales) {
      if (loc === reference) continue;
      const locFile = path.join(dir, loc, ns);
      if (!fs.existsSync(locFile)) {
        console.error(`FAIL: ${path.relative(ROOT, locFile)} missing (exists in "${reference}")`);
        failures++;
        continue;
      }
      const locKeys = new Set(flattenKeys(loadJson(locFile)));
      const missing = [...refKeys].filter((k) => !locKeys.has(k));
      const extra = [...locKeys].filter((k) => !refKeys.has(k));
      if (missing.length > 0) {
        console.error(`FAIL: ${path.relative(ROOT, locFile)} missing keys: ${missing.join(", ")}`);
        failures++;
      }
      if (extra.length > 0) {
        console.error(`FAIL: ${path.relative(ROOT, locFile)} has extra keys: ${extra.join(", ")}`);
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`i18n check failed with ${failures} error(s).`);
  process.exit(1);
}
console.log("i18n check passed: all locale bundles have matching keys.");
