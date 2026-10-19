// Probe: run the benchmark worker handler path directly against the seed DB
// to surface whatever the in-memory queue is swallowing.
process.env.DB_DRIVER = "sqlite";
process.env.SQLITE_PATH = ".seed-home/.deewaanai/deewaanai.db";
process.env.NODE_ENV = "test";
const envFile = Object.fromEntries(
  (await import("node:fs")).readFileSync(".seed-home/env", "utf8").split("\n")
    .filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
Object.assign(process.env, envFile);

const { acquireBenchmark } = await import("../api/services/benchmark/benchmarkService");
const { executeBenchmark } = await import("../api/services/benchmark/benchmarkService");
const benchmarkId = Number(process.argv[2] ?? 5);
const lease = await acquireBenchmark(benchmarkId);
console.log("lease:", lease ? "acquired" : "DENIED");
if (lease) {
  try {
    await executeBenchmark({ benchmarkId, leaseToken: lease });
    console.log("executeBenchmark returned normally");
  } catch (e) {
    console.error("EXECUTE THREW:", e);
  }
}
