// Disk-backed episodic memory + project state store for MCP memory tools.
//
// The pipeline engine keeps state.md / episodes.json in the project's Gitee
// repo (see swarmService.loadProjectState), but MCP calls carry no Gitee
// token. Per the Hybrid Architecture, local disk is the PRIMARY store
// (api/services/projectFilesDisk.ts), so MCP memory lives alongside project
// files under:  {PROJECT_FILES_DIR}/{projectId}/memory/

import { readProjectFile, saveFile } from "../../services/projectFilesDisk";
import {
  parseEpisodes, serializeEpisodes, type Episode,
} from "../../services/memoryManager";
import type { ProjectState } from "../../services/stateSummarizer";

const EPISODES_PATH = "memory/episodes.json";
const STATE_PATH = "memory/state.json";

export async function loadEpisodes(projectId: number): Promise<Episode[]> {
  const raw = await readProjectFile(projectId, EPISODES_PATH);
  if (raw === null) return [];
  return parseEpisodes(raw);
}

export async function saveEpisodes(projectId: number, episodes: Episode[]): Promise<void> {
  await saveFile(projectId, EPISODES_PATH, serializeEpisodes(episodes));
}

export async function loadState(projectId: number): Promise<ProjectState | null> {
  const raw = await readProjectFile(projectId, STATE_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as ProjectState;
    if (parsed && typeof parsed.goal === "string") return parsed;
  } catch { /* corrupt state file — treat as absent */ }
  return null;
}
