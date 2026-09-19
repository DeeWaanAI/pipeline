import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { testFixtures } from "@db/schema";
import { eq, desc } from "drizzle-orm";
import { env } from "../lib/env";

// Test fixtures are development tooling — refuse all access in production.
function assertDevelopment() {
  if (env.isProduction) {
    throw new Error("Test fixtures are available in development only");
  }
}

export const testFixtureRouter = createRouter({
  // ─── List all fixtures for the current user ────────────────────
  list: authedQuery.query(async ({ ctx }) => {
    assertDevelopment();
    const db = getDb();
    const fixtures = await db.select({
      id: testFixtures.id,
      name: testFixtures.name,
      description: testFixtures.description,
      complexity: testFixtures.complexity,
      sizeBytes: testFixtures.sizeBytes,
      fileCount: testFixtures.fileCount,
      createdAt: testFixtures.createdAt,
    }).from(testFixtures)
      .where(eq(testFixtures.userId, ctx.user.id))
      .orderBy(desc(testFixtures.createdAt));

    return fixtures;
  }),

  // ─── Update fixture metadata (name, description, complexity) ──
  update: authedQuery
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      complexity: z.enum(["easy", "medium", "complex"]).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertDevelopment();
      const db = getDb();
      const [existing] = await db.select().from(testFixtures)
        .where(eq(testFixtures.id, input.id));

      if (!existing || existing.userId !== ctx.user.id) {
        throw new Error("Fixture not found");
      }

      await db.update(testFixtures).set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.complexity !== undefined && { complexity: input.complexity }),
      }).where(eq(testFixtures.id, input.id));

      return { success: true };
    }),
});
