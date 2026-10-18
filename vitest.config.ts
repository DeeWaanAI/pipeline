import { defineConfig, configDefaults } from "vitest/config";
import path from "path";
import net from "net";

const templateRoot = path.resolve(import.meta.dirname);

// The *.integration.test.ts suites drive a dedicated MySQL docker harness on
// localhost:3307 (docker-compose.yml). When it isn't running they die at
// setup with ECONNREFUSED — red that means nothing. Probe once here and
// exclude them cleanly instead; with the harness up they run as usual.
function harnessUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(3307, "127.0.0.1");
    const done = (up: boolean) => { sock.destroy(); resolve(up); };
    sock.setTimeout(800);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

export default defineConfig(async () => ({
  root: templateRoot,
  resolve: {
    alias: {
      // See vite.config.ts — dialect swap for "@db/schema" under
      // DB_DRIVER=sqlite (the sqlite suite must exercise sqlite SQL).
      "@db/schema": path.resolve(
        templateRoot,
        process.env.DB_DRIVER === "sqlite" ? "db/schema.sqlite.ts" : "db/schema.ts",
      ),
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
    ...((await harnessUp())
      ? {}
      : { exclude: [...configDefaults.exclude, "api/**/*.integration.test.ts"] }),
  },
}));
