/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST FIXTURE ROUTE (Raw HTTP — ZIP upload/download/delete)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles binary ZIP files that tRPC can't serialize.
 * POST   /api/test-fixtures/upload     — upload a ZIP fixture
 * GET    /api/test-fixtures/:id.zip    — download a fixture ZIP
 * DELETE /api/test-fixtures/:id        — delete a fixture
 */

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { verifyLocalToken } from "./routers/localAuth";
import { getDb } from "./queries/connection";
import { testFixtures, users } from "@db/schema";
import { eq, and } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { env } from "./lib/env";
import { logger } from "./lib/logger";

const MAX_ZIP_SIZE = 100 * 1024 * 1024; // 100MB
const FIXTURES_DIR = process.env.TEST_FIXTURES_DIR || path.resolve(process.cwd(), "../data/test-fixtures");

// Ensure storage directory exists
function ensureDir() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }
}

async function getAuthUser(req: Request) {
  const localToken = req.headers.get("x-local-auth-token");
  if (localToken) {
    const claim = await verifyLocalToken(localToken);
    if (claim) {
      const [user] = await getDb()
        .select()
        .from(users)
        .where(eq(users.id, claim.userId))
        .limit(1);
      if (user) return user;
    }
  }
  return null;
}

/** Count files inside a ZIP buffer (non-directory entries) */
function countZipEntries(zipBuffer: Buffer): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(zipBuffer);
    return zip.getEntries().filter((e: { isDirectory: boolean }) => !e.isDirectory).length;
  } catch {
    return 0;
  }
}

export function registerTestFixtureRoute(app: Hono<{ Bindings: HttpBindings }>) {
  // ─── Upload ─────────────────────────────────────────────────────
  app.post("/api/test-fixtures/upload", async (c) => {
    // Development tooling only — 404 in production
    if (env.isProduction) return c.json({ error: "Not found" }, 404);

    const user = await getAuthUser(c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    let zipFile: File | undefined;
    let name: string | undefined;
    let description: string | undefined;
    let complexity: "easy" | "medium" | "complex" = "medium";

    try {
      const body = await c.req.parseBody({ all: false });
      const uploaded = body.zipFile;
      if (!uploaded) return c.json({ error: "No zipFile provided" }, 400);
      zipFile = uploaded as File;

      name = (body.name as string) || zipFile.name || "Untitled Fixture";
      description = (body.description as string) || undefined;
      const comp = body.complexity as string;
      if (comp === "easy" || comp === "medium" || comp === "complex") {
        complexity = comp;
      }
    } catch (err) {
      return c.json({ error: `Parse failed: ${(err as Error).message}` }, 400);
    }

    if (!zipFile || zipFile.size === 0) return c.json({ error: "Empty file" }, 400);
    if (zipFile.size > MAX_ZIP_SIZE) {
      return c.json({ error: `ZIP too large. Max: ${MAX_ZIP_SIZE / 1024 / 1024}MB` }, 413);
    }

    try {
      ensureDir();

      // Read ZIP buffer
      const arrayBuffer = await zipFile.arrayBuffer();
      const zipBuffer = Buffer.from(arrayBuffer);
      const fileCount = countZipEntries(zipBuffer);

      // Insert DB record first to get the ID
      const db = getDb();
      const [result] = await db.insert(testFixtures).values({
        userId: user.id,
        name,
        description,
        complexity,
        storagePath: "", // Updated below with actual path
        sizeBytes: zipBuffer.length,
        fileCount,
      });

      const fixtureId = Number(result.insertId);
      const storagePath = path.join(FIXTURES_DIR, `${fixtureId}.zip`);

      // Write ZIP to disk
      fs.writeFileSync(storagePath, zipBuffer);

      // Update storage path in DB
      await db.update(testFixtures)
        .set({ storagePath })
        .where(eq(testFixtures.id, fixtureId));

      logger.info("TestFixture uploaded fixture", { userId: user.id, fixtureId, name, sizeKB: (zipBuffer.length / 1024).toFixed(1), fileCount });

      return c.json({
        id: fixtureId,
        name,
        description,
        complexity,
        sizeBytes: zipBuffer.length,
        fileCount,
      });
    } catch (err) {
      logger.error("TestFixture upload failed", { error: (err as Error).message });
      return c.json({ error: `Upload failed: ${(err as Error).message}` }, 500);
    }
  });

  // ─── Download ───────────────────────────────────────────────────
  app.get("/api/test-fixtures/:id.zip", async (c) => {
    // Development tooling only — 404 in production
    if (env.isProduction) return c.json({ error: "Not found" }, 404);

    const user = await getAuthUser(c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const id = parseInt(c.req.param("id") ?? "", 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

    const db = getDb();
    const [fixture] = await db.select().from(testFixtures)
      .where(and(eq(testFixtures.id, id), eq(testFixtures.userId, user.id)));

    if (!fixture) return c.json({ error: "Not found" }, 404);
    if (!fixture.storagePath || !fs.existsSync(fixture.storagePath)) {
      return c.json({ error: "File missing from disk" }, 404);
    }

    const zipBuffer = fs.readFileSync(fixture.storagePath);
    return c.body(zipBuffer, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fixture.name)}.zip"`,
    });
  });

  // ─── Delete ─────────────────────────────────────────────────────
  app.delete("/api/test-fixtures/:id", async (c) => {
    // Development tooling only — 404 in production
    if (env.isProduction) return c.json({ error: "Not found" }, 404);

    const user = await getAuthUser(c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const id = parseInt(c.req.param("id") ?? "", 10);
    if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

    const db = getDb();
    const [fixture] = await db.select().from(testFixtures)
      .where(and(eq(testFixtures.id, id), eq(testFixtures.userId, user.id)));

    if (!fixture) return c.json({ error: "Not found" }, 404);

    // Delete from disk
    if (fixture.storagePath && fs.existsSync(fixture.storagePath)) {
      fs.unlinkSync(fixture.storagePath);
    }

    // Delete from DB
    await db.delete(testFixtures).where(eq(testFixtures.id, id));

    logger.info("TestFixture deleted fixture", { userId: user.id, fixtureId: id, name: fixture.name });
    return c.json({ success: true });
  });
}
