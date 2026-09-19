/**
 * GitHub API service — mirrors giteeService.ts for GitHub integration.
 * Uses GitHub REST API v3 (api.github.com).
 */

const GITHUB_API_BASE = "https://api.github.com";

function getHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function getRepo(token: string, owner: string, repo: string) {
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    headers: getHeaders(token),
  });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function getFileTree(token: string, owner: string, repo: string, path = "", ref = "main") {
  const url = path
    ? `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`
    : `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents?ref=${ref}`;

  const response = await fetch(url, { headers: getHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

async function getFileContent(token: string, owner: string, repo: string, path: string, ref = "main") {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`,
    { headers: getHeaders(token) }
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);

  const data = (await response.json()) as { content?: string; sha?: string; type?: string };

  if (Array.isArray(data) || data.type === "dir") {
    throw new Error(`Path "${path}" is a directory, not a file`);
  }

  if (!data.content) {
    throw new Error(`File "${path}" has no content (may be too large or a symlink)`);
  }

  return { content: Buffer.from(data.content, "base64").toString("utf-8"), sha: data.sha ?? "" };
}

/**
 * Create or update a file on GitHub.
 * If the file already exists, it will be updated (PUT with sha).
 * If it doesn't exist, it will be created (PUT without sha).
 */
export async function createOrUpdateFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch = "main"
) {
  // First, try to get the file's sha (to know if it exists)
  let sha: string | undefined;
  try {
    const fileData = await getFileContent(token, owner, repo, path, branch);
    sha = fileData.sha;
  } catch {
    sha = undefined;
  }

  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  // GitHub uses PUT for both create and update
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: getHeaders(token),
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub PUT failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

export async function listRepos(token: string, page = 1, perPage = 20) {
  const response = await fetch(
    `${GITHUB_API_BASE}/user/repos?type=owner&sort=updated&page=${page}&per_page=${perPage}`,
    { headers: getHeaders(token) }
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

export async function validateToken(token: string): Promise<{ valid: boolean; user?: { login: string; name: string } }> {
  try {
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: getHeaders(token),
    });
    if (!response.ok) return { valid: false };
    const data = (await response.json()) as { login: string; name: string };
    return { valid: true, user: { login: data.login, name: data.name } };
  } catch {
    return { valid: false };
  }
}
