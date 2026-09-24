import { createHash } from "node:crypto";

type AuthorizedRunExport = {
  run: { id: number; userPrompt: string; status: string; finalResponseId: number | null };
  agentRuns: Record<string, unknown>[];
  agentResponses: { id: number; agentRunId: number; content: string }[];
  protection?: string;
};

type ArchiveFile = { path: string; content: string; bytes: number; sha256: string };

// Accept only the authorized export projection; never reload withheld steps here.
export function buildRunArchive(data: AuthorizedRunExport) {
  const files: ArchiveFile[] = [];
  const add = (path: string, content: string) => {
    files.push({ path, content, bytes: Buffer.byteLength(content, "utf8"), sha256: createHash("sha256").update(content, "utf8").digest("hex") });
  };
  const final = data.agentResponses.find((r) => r.id === data.run.finalResponseId);
  const runComplete = data.run.status === "completed" && final !== undefined;
  add("input.txt", data.run.userPrompt);
  if (runComplete) add("final-output.txt", final.content);
  data.agentRuns.forEach((step, index) => {
    add(`steps/${String(index + 1).padStart(4, "0")}.json`, JSON.stringify({
      step, responses: data.agentResponses.filter((r) => r.agentRunId === step.id),
    }, null, 2));
  });
  add("run.json", JSON.stringify(data, null, 2));
  add("manifest.json", JSON.stringify({
    version: 1, runId: data.run.id, runStatus: data.run.status, runComplete,
    encoding: "utf8", protection: data.protection ?? null,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  }, null, 2));
  return {
    directoryName: `run-${data.run.id}`,
    encoding: "utf8" as const,
    localWriteRequired: true,
    runComplete,
    files,
    instructions: "Use the client's filesystem tools to create this directory inside the user's selected folder. Write each decoded content string exactly as UTF-8, without an added newline. Never overwrite existing files silently. Read back and verify each file's byte count and SHA-256 before reporting it saved. If the client cannot write files, say so. This archive does not authorize or perform a server-side sweep.",
  };
}
