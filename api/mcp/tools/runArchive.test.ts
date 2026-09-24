import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunArchive } from "./runArchive";

const fixture = () => ({
  version: 1,
  exportedAt: "2026-09-24T00:00:00.000Z",
  run: { id: 42, userPrompt: "Input 雪\r\n", status: "completed", finalResponseId: 12 },
  agentRuns: [{ id: 1, name: "../../outside", systemPrompt: "Draft" }, { id: 2, name: "Review" }],
  agentResponses: [
    { id: 11, agentRunId: 1, content: "Intermediate\n" },
    { id: 12, agentRunId: 2, content: "Final 雪\r\n" + "x".repeat(18000) },
  ],
});

const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

describe("per-run local archive contract", () => {
  it("packages full input, outputs and step records under safe relative names", () => {
    const data = fixture();
    const archive = buildRunArchive(data);
    expect(archive.directoryName).toBe("run-42");
    expect(archive.localWriteRequired).toBe(true);
    expect(archive.runComplete).toBe(true);
    expect(archive.files.map((f) => f.path)).toEqual([
      "input.txt", "final-output.txt", "steps/0001.json", "steps/0002.json", "run.json", "manifest.json",
    ]);
    const files = new Map(archive.files.map((f) => [f.path, f.content]));
    expect(files.get("input.txt")).toBe(data.run.userPrompt);
    expect(files.get("final-output.txt")).toBe(data.agentResponses[1].content);
    expect(JSON.parse(files.get("steps/0001.json")!)).toEqual({ step: data.agentRuns[0], responses: [data.agentResponses[0]] });
    expect(JSON.parse(files.get("run.json")!)).toEqual(data);
    for (const file of archive.files) {
      expect(file.sha256).toBe(digest(file.content));
      expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
      expect(file.path).not.toMatch(/(^\/|\.\.|\\)/);
    }
    const manifest = JSON.parse(files.get("manifest.json")!);
    expect(manifest.files).toEqual(archive.files.filter((f) => f.path !== "manifest.json")
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
  });

  it("retains redaction and never invents a withheld intermediate output", () => {
    const data = fixture();
    const protectedData = {
      ...data, protection: "Intermediate outputs withheld",
      agentRuns: [{ id: 1 }, { id: 2 }], agentResponses: [data.agentResponses[1]],
    };
    const archive = buildRunArchive(protectedData);
    const firstStep = JSON.parse(archive.files.find((f) => f.path === "steps/0001.json")!.content);
    expect(firstStep).toEqual({ step: { id: 1 }, responses: [] });
    expect(JSON.stringify(archive)).not.toContain("Intermediate\\n");
    expect(JSON.parse(archive.files.find((f) => f.path === "manifest.json")!.content).protection).toBe(protectedData.protection);
  });

  it("marks an incomplete run without fabricating a final-output file", () => {
    const data = fixture();
    const archive = buildRunArchive({ ...data, run: { ...data.run, status: "running", finalResponseId: null } });
    expect(archive.runComplete).toBe(false);
    expect(archive.files.some((f) => f.path === "final-output.txt")).toBe(false);
  });

  it("writes exact UTF-8 bytes through client file tools and detects corruption", async () => {
    const folder = await mkdtemp(join(tmpdir(), "deewaanai-archive-test-"));
    try {
      const archive = buildRunArchive(fixture());
      for (const file of archive.files) {
        const destination = join(folder, archive.directoryName, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
        const bytes = await readFile(destination);
        expect(bytes.length).toBe(file.bytes);
        expect(digest(bytes)).toBe(file.sha256);
      }
      const input = archive.files.find((f) => f.path === "input.txt")!;
      const path = join(folder, archive.directoryName, input.path);
      await expect(writeFile(path, "replacement", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
      expect(digest(Buffer.from(input.content + "changed"))).not.toBe(input.sha256);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
