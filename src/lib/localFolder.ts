/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOCAL FOLDER ACCESS — File System Access API Wrapper
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides access to a user-designated local folder for reading project
 * files. Uses the File System Access API with IndexedDB persistence for
 * the directory handle across sessions.
 *
 * Per-project storage: each project gets its own folder handle keyed by
 * projectId. The folder NAME is also persisted server-side so it survives
 * across browsers.
 *
 * Note: Uses `any` casts for FileSystemDirectoryHandle since TypeScript's
 * DOM types don't fully cover the File System Access API yet.
 */

const INDEXED_DB_NAME = "SwarmStudio";
const STORE_NAME = "folderHandles";

// ─── Key helpers ──────────────────────────────────────────────────
function handleKey(projectId: number | string): string {
  return `projectFolder-${projectId}`;
}

// ─── IndexedDB helpers ────────────────────────────────────────────
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(INDEXED_DB_NAME, 2); // v2 adds per-project keys
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function storeHandle(projectId: number | string, handle: any) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await new Promise<void>((resolve, reject) => {
    const req = store.put(handle, handleKey(projectId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

async function getStoredHandle(projectId: number | string): Promise<any | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const handle = await new Promise<any | undefined>((resolve, reject) => {
      const req = store.get(handleKey(projectId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle ?? null;
  } catch {
    return null;
  }
}

async function clearStoredHandle(projectId: number | string) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    await new Promise<void>((resolve, reject) => {
      const req = store.delete(handleKey(projectId));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch { /* ignore */ }
}

// ─── Public API ───────────────────────────────────────────────────

export interface LocalFolderState {
  handle: any; // FileSystemDirectoryHandle
  path: string;
}

/**
 * Request access to a local folder via the File System Access API.
 * Stores the handle in IndexedDB keyed by projectId.
 */
export async function requestFolderAccess(projectId?: number | string): Promise<LocalFolderState> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Your browser doesn't support local folder access. Please use Chrome or Edge.");
  }

  const handle = await (window as any).showDirectoryPicker();
  await storeHandle(projectId ?? "global", handle);

  return { handle, path: handle.name };
}

/**
 * Create a new folder inside a parent directory selected by the user.
 * Returns the newly created folder handle.
 */
export async function createAndLinkFolder(
  projectId: number | string,
  folderName: string,
): Promise<LocalFolderState> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Your browser doesn't support local folder access. Please use Chrome or Edge.");
  }

  if (!folderName || !folderName.trim()) {
    throw new Error("Folder name is required.");
  }

  // Select parent directory with readwrite permission
  const parentHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" });

  // Create the new folder
  const newHandle = await parentHandle.getDirectoryHandle(folderName.trim(), { create: true });

  await storeHandle(projectId, newHandle);

  return { handle: newHandle, path: `${parentHandle.name}/${folderName.trim()}` };
}

/**
 * Try to restore a previously-granted folder handle for a project.
 * Returns null if no handle was stored or permission was revoked.
 */
export async function restoreFolderAccess(projectId?: number | string): Promise<LocalFolderState | null> {
  const handle = await getStoredHandle(projectId ?? "global");
  if (!handle) return null;

  // Check if permission is still granted
  const permission = await handle.requestPermission?.({ mode: "read" });
  if (permission === "denied") {
    await clearStoredHandle(projectId ?? "global");
    return null;
  }

  return { handle, path: handle.name };
}

/**
 * Clear the stored folder handle for a project (unlink folder).
 */
export async function unlinkFolder(projectId?: number | string) {
  await clearStoredHandle(projectId ?? "global");
}

/**
 * List all ZIP files in the linked folder.
 */
export async function listZipFiles(
  handle: any // FileSystemDirectoryHandle
): Promise<Array<{ name: string; handle: any; size?: number }>> {
  const zips: Array<{ name: string; handle: any; size?: number }> = [];

  for await (const entry of handle.values()) {
    if (entry.kind === "file" && entry.name.endsWith(".zip")) {
      try {
        const file = await entry.getFile();
        zips.push({ name: entry.name, handle: entry, size: file.size });
      } catch {
        zips.push({ name: entry.name, handle: entry });
      }
    }
  }

  zips.sort((a, b) => a.name.localeCompare(b.name));
  return zips;
}

/**
 * Read a FileSystemFileHandle into a File object.
 */
export async function readFileHandle(
  fileHandle: any // FileSystemFileHandle
): Promise<File> {
  return fileHandle.getFile();
}

/**
 * Check if File System Access API is supported.
 */
export function isLocalFolderSupported(): boolean {
  return "showDirectoryPicker" in window;
}

// ─── Fallback for Firefox / Safari ──────────────────────────────────

/**
 * Fallback: request folder access via hidden file input (works in Firefox/Safari).
 * Returns an array of selected files. Does NOT provide a persistent handle.
 */
export function requestFolderAccessFallback(): Promise<{ name: string; files: File[] } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    (input as any).webkitdirectory = true;
    (input as any).mozdirectory = true;
    input.multiple = true;
    input.style.display = "none";

    input.onchange = () => {
      const files = Array.from(input.files || []);
      if (files.length === 0) {
        resolve(null);
        return;
      }
      // Extract folder name from the first file's webkitRelativePath
      const firstPath = (files[0] as any).webkitRelativePath || "";
      const folderName = firstPath.split("/")[0] || "Selected folder";
      resolve({ name: folderName, files });
    };

    input.oncancel = () => resolve(null);

    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  });
}

// ─── Fallback Folder Persistence (localStorage metadata) ────────────

const FALLBACK_FOLDER_KEY = "swarmFallbackFolder";

export function storeFallbackFolderName(name: string, fileCount: number, _files?: File[]) {
  localStorage.setItem(
    FALLBACK_FOLDER_KEY,
    JSON.stringify({ name, fileCount, timestamp: Date.now() }),
  );
}

export function getStoredFallbackFolder(): { name: string; fileCount: number; timestamp: number } | null {
  try {
    const raw = localStorage.getItem(FALLBACK_FOLDER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearFallbackFolder() {
  localStorage.removeItem(FALLBACK_FOLDER_KEY);
}
