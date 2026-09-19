content = open('api/services/batchService.ts').read()

# Add 'or' to drizzle-orm imports
content = content.replace(
    'import { eq, and, desc, sql } from "drizzle-orm";',
    'import { eq, and, or, desc, sql } from "drizzle-orm";'
)

# Fix cancelBatch to cancel both pending and running runs
content = content.replace(
    '''  // Cancel all non-terminal runs
  await db
    .update(swarmRuns)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(swarmRuns.batchId, batchId),
        eq(swarmRuns.status, "pending"),
      ),
    );''',
    '''  // Cancel all non-terminal runs
  await db
    .update(swarmRuns)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(swarmRuns.batchId, batchId),
        or(eq(swarmRuns.status, "pending"), eq(swarmRuns.status, "running")),
      ),
    );'''
)

open('api/services/batchService.ts', 'w').write(content)
print('Fixed cancelBatch')
