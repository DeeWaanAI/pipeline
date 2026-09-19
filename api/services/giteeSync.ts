/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GITEE SYNC SERVICE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles pushing extracted project files to a private Gitee repository.
 * Creates repos automatically, pushes files in batches, and stores
 * the commit reference for later retrieval.
 */

import { createRepo, createOrUpdateFile, getFileContent, getRepo } from "./giteeService";
import { logger } from "../lib/logger";

export interface GiteeSyncResult {
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  filesPushed: number;
  repoUrl: string;
}

/**
 * Create a private Gitee repo and push all project files to it.
 */
export async function syncProjectToGitee(
  token: string,
  projectName: string,
  files: Array<{ path: string; content: string }>,
  description = "",
): Promise<GiteeSyncResult> {
  // 1. Sanitize repo name (Gitee: letters, numbers, hyphens, underscores)
  const repoName = `swarm-${projectName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;

  // 2. Create the repo
  const repo = await createRepo(token, repoName, description || `Project files for ${projectName}`);
  const owner = repo.owner.login;
  const repoSlug = repo.name;
  const branch = "master";

  logger.info("GiteeSync created repo", { owner, repo: repoSlug });

  // 3. Push files in batches (Gitee API rate limit consideration)
  let pushed = 0;
  const batchSize = 10; // Push 10 files at a time with small delay

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);

    for (const file of batch) {
      try {
        await createOrUpdateFile(
          token,
          owner,
          repoSlug,
          file.path,
          file.content,
          `chore: add ${file.path}`,
          branch,
        );
        pushed++;
      } catch (err) {
        logger.error("GiteeSync failed to push file", { path: file.path, error: (err as Error).message });
        // Continue with other files
      }
    }

    // Small delay between batches to respect rate limits
    if (i + batchSize < files.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  logger.info("GiteeSync pushed files", { pushed, total: files.length, owner, repo: repoSlug });

  // 4. Get the latest commit SHA
  let commitSha = "";
  try {
    const repoData = await getRepo(token, owner, repoSlug);
    commitSha = (repoData as Record<string, unknown>).pushed_at as string || "";
  } catch {
    // OK if we can't get commit info
  }

  return {
    owner,
    repo: repoSlug,
    branch,
    commitSha,
    filesPushed: pushed,
    repoUrl: `https://gitee.com/${owner}/${repoSlug}`,
  };
}

/**
 * Fetch a single file's content from Gitee on demand.
 */
async function fetchFileFromGitee(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch = "master",
): Promise<string> {
  const result = await getFileContent(token, owner, repo, path, branch);
  return result.content;
}

/**
 * Fetch multiple files from Gitee in parallel.
 */
export async function fetchFilesFromGitee(
  token: string,
  owner: string,
  repo: string,
  paths: string[],
  branch = "master",
): Promise<Array<{ path: string; content: string }>> {
  const results = await Promise.allSettled(
    paths.map(async (path) => ({
      path,
      content: await fetchFileFromGitee(token, owner, repo, path, branch),
    })),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === "fulfilled")
    .map((r) => r.value);
}
