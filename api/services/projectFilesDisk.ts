/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROJECT FILES DISK STORAGE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Stores project file contents on local disk instead of MySQL.
 * Each project gets its own directory: PROJECT_FILES_DIR/{projectId}/
 *
 * This is the PRIMARY storage for file contents in the Hybrid Architecture.
 * Gitee serves as sync/backup for cross-device and team sharing.
 */

import fs from "fs/promises";
import path from "path";
import { logger } from "../lib/logger";

// Store outside Vite's watch scope to prevent page reloads on file write
const PROJECT_FILES_DIR = process.env.PROJECT_FILES_DIR || "../data/project-files";

function getProjectDir(projectId: number): string {
  return path.join(PROJECT_FILES_DIR, String(projectId));
}

function sanitizePath(filePath: string): string {
  // Prevent directory traversal attacks
  const normalized = path.normalize(filePath).replace(/^(\.\.\/)+/g, "");
  return normalized;
}

/**
 * Ensure the project files directory exists.
 */
async function ensureProjectDir(projectId: number): Promise<string> {
  const dir = getProjectDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Save a single file to disk.
 */
export async function saveFile(
  projectId: number,
  filePath: string,
  content: string
): Promise<void> {
  const dir = await ensureProjectDir(projectId);
  const safePath = sanitizePath(filePath);
  const fullPath = path.join(dir, safePath);

  // Create subdirectories if needed
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

/**
 * Save multiple files to disk (batch).
 */
export async function saveProjectFiles(
  projectId: number,
  files: Array<{ path: string; content: string }>
): Promise<{ saved: number; failed: number }> {
  const dir = await ensureProjectDir(projectId);
  let saved = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const safePath = sanitizePath(file.path);
      const fullPath = path.join(dir, safePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, file.content, "utf-8");
      saved++;
    } catch (err) {
      logger.error("DiskStorage failed to save file", { path: file.path, error: (err as Error).message });
      failed++;
    }
  }

  return { saved, failed };
}

/**
 * Read a single file from disk.
 * Returns null if file doesn't exist.
 */
export async function readProjectFile(
  projectId: number,
  filePath: string
): Promise<string | null> {
  try {
    const dir = getProjectDir(projectId);
    const safePath = sanitizePath(filePath);
    const fullPath = path.join(dir, safePath);
    return await fs.readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List all files stored on disk for a project.
 * Returns relative paths.
 */
export async function listProjectFiles(projectId: number): Promise<string[]> {
  const dir = getProjectDir(projectId);
  try {
    const files = await walkDir(dir, "");
    return files;
  } catch {
    return [];
  }
}

async function walkDir(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const subFiles = await walkDir(root, relativePath);
      files.push(...subFiles);
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Delete all files for a project from disk.
 */
export async function deleteProjectFiles(projectId: number): Promise<void> {
  const dir = getProjectDir(projectId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }
}
