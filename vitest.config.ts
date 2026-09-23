import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
      "@db": path.resolve(templateRoot, "db"),
    },
  },
  test: {
    environment: "node",
    include: ["api/**/*.test.ts", "api/**/*.spec.ts"],
    /**
     * One file at a time. Each DB-backed suite creates its own throwaway
     * schema and runs `drizzle-kit push --force` against the same local
     * MySQL; run concurrently they exhaust the server and several suites die
     * at start-up — reported as "failed to run" with no assertion failure at
     * all, which is the worst kind of red because it looks like the code
     * broke. A suite whose green is intermittent cannot be used as a gate, so
     * the run costs a couple more minutes and becomes trustworthy instead.
     */
    fileParallelism: false,
  },
});
