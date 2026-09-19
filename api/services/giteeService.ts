const GITEE_API_BASE = "https://gitee.com/api/v5";

function getHeaders(token: string) {
  return {
    Authorization: `token ${token}`,
    "Content-Type": "application/json",
  };
}

export async function getRepo(token: string, owner: string, repo: string) {
  const response = await fetch(`${GITEE_API_BASE}/repos/${owner}/${repo}`, {
    headers: getHeaders(token),
  });
  if (!response.ok) throw new Error(`Gitee API error: ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function getFileTree(token: string, owner: string, repo: string, path = "", ref = "master") {
  const url = path
    ? `${GITEE_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`
    : `${GITEE_API_BASE}/repos/${owner}/${repo}/contents?ref=${ref}`;

  const response = await fetch(url, { headers: getHeaders(token) });
  if (!response.ok) throw new Error(`Gitee API error: ${response.status}`);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

export async function getFileContent(token: string, owner: string, repo: string, path: string, ref = "master") {
  const response = await fetch(
    `${GITEE_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`,
    { headers: getHeaders(token) }
  );
  if (!response.ok) throw new Error(`Gitee API error: ${response.status}`);

  const data = (await response.json()) as { content?: string; sha?: string; type?: string; message?: string };

  // Handle directory (Gitee returns array for dirs, or object with type "dir")
  if (Array.isArray(data) || data.type === "dir") {
    throw new Error(`Path "${path}" is a directory, not a file`);
  }

  // Handle missing content
  if (!data.content) {
    throw new Error(`File "${path}" has no content (may be too large or a symlink)`);
  }

  return { content: Buffer.from(data.content, "base64").toString("utf-8"), sha: data.sha ?? "" };
}

/**
 * Create or update a file on Gitee.
 * If the file already exists, it will be updated (PUT with sha).
 * If it doesn't exist, it will be created (POST).
 */
export async function createOrUpdateFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch = "master"
) {
  // First, try to get the file's sha (to know if it exists)
  let sha: string | undefined;
  try {
    const fileData = await getFileContent(token, owner, repo, path, branch);
    sha = fileData.sha;
  } catch {
    // File doesn't exist — we'll create it
    sha = undefined;
  }

  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"), // UTF-8 safe base64
    branch,
  };
  if (sha) body.sha = sha;

  const method = sha ? "PUT" : "POST";

  const response = await fetch(
    `${GITEE_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method,
      headers: getHeaders(token),
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gitee ${method} failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

async function deleteFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  message: string,
  sha: string,
  branch = "master"
) {
  const response = await fetch(
    `${GITEE_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: "DELETE",
      headers: getHeaders(token),
      body: JSON.stringify({ message, sha, branch }),
    }
  );
  if (!response.ok) throw new Error(`Gitee API error: ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function createRepo(token: string, name: string, description = "") {
  const response = await fetch(`${GITEE_API_BASE}/user/repos`, {
    method: "POST",
    headers: getHeaders(token),
    body: JSON.stringify({
      name,
      description: description || `Auto-created repo for ${name}`,
      private: false,
      auto_init: true, // Initialize with README so the repo has a default branch
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gitee create repo failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<{ full_name: string; name: string; owner: { login: string } }>;
}

export async function listRepos(token: string, page = 1, perPage = 20) {
  const response = await fetch(
    `${GITEE_API_BASE}/user/repos?type=personal&page=${page}&per_page=${perPage}`,
    { headers: getHeaders(token) }
  );
  if (!response.ok) throw new Error(`Gitee API error: ${response.status}`);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

export async function deleteFolder(
  token: string,
  owner: string,
  repo: string,
  folderPath: string,
  branch = "master"
) {
  try {
    const treeResponse = await fetch(
      `${GITEE_API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers: getHeaders(token) }
    );
    if (!treeResponse.ok) return;
    const treeData = (await treeResponse.json()) as { tree: Array<{ path: string; type: string; sha: string }> };
    const files = treeData.tree?.filter((item) =>
      item.path.startsWith(folderPath + "/") && item.type === "blob"
    ) ?? [];
    for (const file of files) {
      try {
        await deleteFile(token, owner, repo, file.path, `chore: delete ${file.path}`, file.sha, branch);
      } catch { /* skip files that fail */ }
    }
  } catch { /* folder may not exist */ }
}

export async function validateToken(token: string): Promise<{ valid: boolean; user?: { login: string; name: string } }> {
  try {
    const response = await fetch(`${GITEE_API_BASE}/user`, {
      headers: getHeaders(token),
    });
    if (!response.ok) return { valid: false };
    const data = (await response.json()) as { login: string; name: string };
    return { valid: true, user: { login: data.login, name: data.name } };
  } catch {
    return { valid: false };
  }
}
