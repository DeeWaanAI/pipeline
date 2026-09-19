/**
 * Project Files Panel
 * Shows the imported project file tree with the Intelligence Card.
 * Allows users to toggle project files inclusion in chat context.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import {
  Folder, FileCode, FileText, Database, Settings,
  Upload, X, ChevronRight, ChevronDown, Loader2,
  FolderOpen, Eye, EyeOff, Search, Trash2, AlertCircle,
  HardDrive, Unlink, FolderSync,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  isLocalFolderSupported,
  requestFolderAccess,
  restoreFolderAccess,
  unlinkFolder,
  listZipFiles,
  readFileHandle,
} from "@/lib/localFolder";

interface FileNode {
  path: string;
  name: string;
  size: number;
  language: string;
  category: string;
  exports: string[];
  description: string;
  isEntryPoint: boolean;
}

interface Props {
  projectId: number;
  includeInContext: boolean;
  onToggleInclude: (v: boolean) => void;
}

function getFileIcon(_language: string, category: string) {
  if (category === "code") return <FileCode className="w-3.5 h-3.5 text-blue-400" />;
  if (category === "document") return <FileText className="w-3.5 h-3.5 text-amber-400" />;
  if (category === "data") return <Database className="w-3.5 h-3.5 text-emerald-400" />;
  if (category === "config") return <Settings className="w-3.5 h-3.5 text-neutral-400" />;
  return <FileText className="w-3.5 h-3.5 text-neutral-500" />;
}

function buildTreeNodes(files: FileNode[]) {
  const root: Array<{ name: string; path: string; isDir: boolean; children: typeof root; file?: FileNode }> = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const pathSoFar = parts.slice(0, i + 1).join("/");
      const isLast = i === parts.length - 1;

      let existing = current.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          path: pathSoFar,
          isDir: !isLast,
          children: [],
          ...(isLast ? { file } : {}),
        };
        current.push(existing);
      }

      if (!isLast) {
        current = existing.children;
      }
    }
  }

  // Sort: dirs first, then files, alphabetically
  function sortNodes(nodes: typeof root) {
    nodes.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children);
    }
  }
  sortNodes(root);

  return root;
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  searchQuery,
}: {
  node: ReturnType<typeof buildTreeNodes>[number];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  searchQuery: string;
}) {
  const isExpanded = expanded.has(node.path);
  const hasChildren = node.children.length > 0;

  // Highlight search matches
  const matchesSearch = searchQuery && (
    node.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (node.file?.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (searchQuery && !matchesSearch && !hasChildren) return null;

  return (
    <div>
      <button
        onClick={() => hasChildren ? onToggle(node.path) : undefined}
        className={`flex items-center gap-1.5 w-full px-2 py-0.5 text-xs hover:bg-neutral-800/50 rounded transition-colors ${
          matchesSearch ? "bg-amber-500/10" : ""
        } ${node.file?.isEntryPoint ? "text-blue-300" : "text-neutral-300"}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {hasChildren ? (
          isExpanded ? (
            <ChevronDown className="w-3 h-3 text-neutral-500 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-neutral-500 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {hasChildren ? (
          isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          )
        ) : (
          <span className="shrink-0">{getFileIcon(node.file?.language || "", node.file?.category || "")}</span>
        )}

        <span className="truncate" title={node.file?.description || node.path}>
          {node.name}
          {node.file?.isEntryPoint && (
            <span className="ml-1 text-[9px] text-blue-400 bg-blue-500/10 px-1 rounded">ENTRY</span>
          )}
        </span>

        {node.file && (
          <span className="ml-auto text-[10px] text-neutral-600 shrink-0">
            {(node.file.size / 1024).toFixed(1)}KB
          </span>
        )}
      </button>

      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              searchQuery={searchQuery}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProjectFilesPanel({ projectId, includeInContext, onToggleInclude }: Props) {
  const { t } = useTranslation("pages");
  const [showImport, setShowImport] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Local folder state ───
  const [localFolder, setLocalFolder] = useState<{ path: string } | null>(null);
  const [localZips, setLocalZips] = useState<Array<{ name: string; size?: number }>>([]);
  const [linking, setLinking] = useState(false);

  const utils = trpc.useUtils();

  const { data: card, isLoading, error: cardError } = trpc.projectImport.getIntelligenceCard.useQuery(
    { projectId },
    { enabled: projectId > 0 }
  );

  // Restore local folder on mount
  useEffect(() => {
    restoreFolderAccess(projectId).then((state) => {
      if (state) {
        setLocalFolder({ path: state.path });
        // List ZIPs
        listZipFiles(state.handle).then((zips) => {
          setLocalZips(zips.map((z) => ({ name: z.name, size: z.size })));
        });
      }
    }).catch(() => { /* ignore */ });
  }, [projectId]);

  const clearMutation = trpc.projectImport.clearIntelligenceCard.useMutation({
    onSuccess: () => {
      toast.success(t("pages:workspace.files.cleared"));
      utils.projectImport.getIntelligenceCard.invalidate({ projectId });
    },
  });

  const handleLinkFolder = async () => {
    setLinking(true);
    try {
      const state = await requestFolderAccess(projectId);
      setLocalFolder({ path: state.path });
      const zips = await listZipFiles(state.handle);
      setLocalZips(zips.map((z) => ({ name: z.name, size: z.size })));
      toast.success(t("pages:workspace.files.linkedFolder", { path: state.path }));
    } catch (err) {
      toast.error(`${t("pages:workspace.files.linkFailed")}: ${(err as Error).message}`);
    } finally {
      setLinking(false);
    }
  };

  const handleUnlinkFolder = async () => {
    await unlinkFolder(projectId);
    setLocalFolder(null);
    setLocalZips([]);
    toast.success(t("pages:workspace.files.folderUnlinked"));
  };

  const handleImportLocalZip = useCallback(async (fileHandle: FileSystemFileHandle) => {
    setUploading(true);
    try {
      const file = await readFileHandle(fileHandle);
      const token = localStorage.getItem("local_auth_token") || "";
      const giteeToken = localStorage.getItem("gitee_token") || "";
      const formData = new FormData();
      formData.append("zipFile", file);
      formData.append("projectId", String(projectId));
      if (giteeToken) formData.append("giteeToken", giteeToken);

      const res = await fetch("/api/import-project", {
        method: "POST",
        headers: { "x-local-auth-token": token },
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("pages:workspace.files.importFailed"));

      toast.success(t("pages:workspace.files.importedFiles", { count: data.filesImported }));
      utils.projectImport.getIntelligenceCard.invalidate({ projectId });
      setShowImport(false);
    } catch (err) {
      toast.error(`${t("pages:workspace.files.importFailed")}: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, [projectId, utils, t]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".zip")) {
      toast.error(t("pages:workspace.files.selectZip"));
      return;
    }

    setUploading(true);
    try {
      const token = localStorage.getItem("local_auth_token") || "";
      const giteeToken = localStorage.getItem("gitee_token") || "";
      const formData = new FormData();
      formData.append("zipFile", file);
      formData.append("projectId", String(projectId));
      if (giteeToken) formData.append("giteeToken", giteeToken);

      const res = await fetch("/api/import-project", {
        method: "POST",
        headers: { "x-local-auth-token": token },
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("pages:workspace.files.uploadFailed"));

      toast.success(t("pages:workspace.files.importedFiles", { count: data.filesImported }));
      utils.projectImport.getIntelligenceCard.invalidate({ projectId });
      setShowImport(false);
    } catch (err) {
      toast.error(`${t("pages:workspace.files.uploadFailed")}: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
    e.target.value = "";
  }, [projectId, utils, t]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (!card) return;
    const all = new Set<string>();
    for (const f of card.fileTree) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        all.add(parts.slice(0, i).join("/"));
      }
    }
    setExpanded(all);
  }, [card]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
      </div>
    );
  }

  if (cardError) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-red-400 px-4">
        <AlertCircle className="w-8 h-8" />
        <p className="text-xs text-center">
          {cardError.message?.includes("Project not found")
            ? t("pages:workspace.files.noAccess")
            : cardError.message || t("pages:workspace.files.loadFailed")}
        </p>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-neutral-500 px-4">
        <Folder className="w-10 h-10" />
        <p className="text-xs text-center">
          {t("pages:workspace.files.noFiles")}<br />
          {t("pages:workspace.files.noFilesDesc")}
        </p>

        {/* Local folder link */}
        {isLocalFolderSupported() ? (
          localFolder ? (
            <div className="w-full space-y-2">
              <div className="flex items-center gap-2 text-[11px] text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">
                <FolderSync className="w-3 h-3" />
                <span className="truncate">{localFolder.path}</span>
                <button onClick={handleUnlinkFolder} className="ml-auto hover:text-red-400" title={t("pages:workspace.files.unlink")}>
                  <Unlink className="w-3 h-3" />
                </button>
              </div>
              {localZips.length > 0 ? (
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  <p className="text-[10px] text-neutral-600">{t("pages:workspace.files.zipsInFolder")}:</p>
                  {localZips.map((zip) => (
                    <button
                      key={zip.name}
                      onClick={async () => {
                        const state = await restoreFolderAccess(projectId);
                        if (!state) { toast.error(t("pages:workspace.files.folderAccessLost")); return; }
                        const zips = await listZipFiles(state.handle);
                        const zh = zips.find((z) => z.name === zip.name);
                        if (zh) handleImportLocalZip(zh.handle);
                      }}
                      disabled={uploading}
                      className="w-full flex items-center gap-2 px-2 py-1 text-[11px] text-left
                        bg-neutral-800/50 hover:bg-neutral-800 rounded text-neutral-300
                        disabled:opacity-50 transition-colors"
                    >
                      <Upload className="w-3 h-3" />
                      <span className="truncate">{zip.name}</span>
                      {zip.size && <span className="ml-auto text-neutral-600">{(zip.size / 1024).toFixed(0)}KB</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-neutral-600">{t("pages:workspace.files.noZipsFound")}</p>
              )}
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="text-xs border-emerald-700/50 text-emerald-400 hover:bg-emerald-500/10"
              onClick={handleLinkFolder}
              disabled={linking}
            >
              {linking ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <HardDrive className="w-3 h-3 mr-1" />}
              {t("pages:workspace.files.linkProjectFolder")}
            </Button>
          )
        ) : null}

        <div className="text-[10px] text-neutral-600">{t("pages:workspace.files.or")}</div>

        <Button
          variant="outline"
          size="sm"
          className="text-xs border-neutral-700 hover:bg-neutral-800"
          onClick={() => setShowImport(true)}
        >
          <Upload className="w-3 h-3 mr-1" /> {t("pages:workspace.files.uploadZip")}
        </Button>

        {/* Import dialog */}
        {showImport && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowImport(false)}>
            <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-96" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-neutral-200">{t("pages:workspace.files.uploadProjectZip")}</h3>
                <button onClick={() => setShowImport(false)} className="text-neutral-500 hover:text-neutral-300">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-neutral-500 mb-4">
                {t("pages:workspace.files.uploadProjectZipDesc")}
              </p>
              <input ref={fileInputRef} type="file" accept=".zip" onChange={handleFileSelect} className="hidden" />
              <Button
                variant="outline" className="w-full border-dashed border-neutral-600 hover:border-neutral-400 hover:bg-neutral-800"
                onClick={() => fileInputRef.current?.click()} disabled={uploading}
              >
                {uploading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t("pages:workspace.files.processing")}</> : <><Upload className="w-4 h-4 mr-2" /> {t("pages:workspace.files.selectZipFile")}</>}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const tree = buildTreeNodes(card.fileTree);
  const hasGitee = !!card.giteeOwner && !!card.giteeRepo;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-neutral-800">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <FolderOpen className="w-4 h-4 text-amber-500" />
            <span className="text-xs font-medium text-neutral-300">
              {card.totalFiles} {t("pages:workspace.files.filesLabel")}
            </span>
            <span className="text-[10px] text-neutral-600 bg-neutral-800 px-1.5 py-0.5 rounded">
              {card.primaryLanguage}
            </span>
            {card.framework !== "custom" && (
              <span className="text-[10px] text-neutral-600 bg-neutral-800 px-1.5 py-0.5 rounded">
                {card.framework}
              </span>
            )}
            {localFolder && (
              <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-1" title={`${t("pages:workspace.files.localPrefix")}: ${localFolder.path}`}>
                <HardDrive className="w-2.5 h-2.5" /> {t("pages:workspace.files.local")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="w-5 h-5 text-neutral-500 hover:text-neutral-300"
              onClick={expandAll}
              title={t("pages:workspace.files.expandAll")}
            >
              <FolderOpen className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="w-5 h-5 text-neutral-500 hover:text-red-400"
              onClick={() => {
                if (confirm(t("pages:workspace.files.clearConfirm"))) {
                  clearMutation.mutate({ projectId });
                }
              }}
              title={t("pages:workspace.files.clear")}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* Include in context toggle */}
        <button
          onClick={() => onToggleInclude(!includeInContext)}
          className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded transition-colors w-full ${
            includeInContext
              ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
              : "bg-neutral-800 text-neutral-500 hover:bg-neutral-700"
          }`}
        >
          {includeInContext ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          {includeInContext ? t("pages:workspace.files.includedInChat") : t("pages:workspace.files.excludedFromChat")}
        </button>

        {/* Search */}
        <div className="relative mt-1.5">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-neutral-600" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("pages:workspace.files.searchFiles")}
            className="h-6 pl-6 text-[11px] bg-neutral-800/50 border-neutral-700 placeholder:text-neutral-600"
          />
        </div>
      </div>

      {/* File Tree */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggleExpanded}
              searchQuery={searchQuery}
            />
          ))}
        </div>
      </ScrollArea>

      {/* Summary footer */}
      <div className="px-3 py-2 border-t border-neutral-800 text-[10px] text-neutral-600 space-y-1">
        {card.entryPoints.length > 0 && (
          <div>{t("pages:workspace.files.entryPrefix")}: {card.entryPoints.map((ep) => ep.split("/").pop()).join(", ")}</div>
        )}
        {card.architecture !== "flat" && <div>{t("pages:workspace.files.archPrefix")}: {card.architecture}</div>}
        {hasGitee && <div className="text-emerald-600">{t("pages:workspace.files.syncedToGitee")}</div>}
        {card.todos.length > 0 && (
          <div className="text-amber-600">{card.todos.length} {t("pages:workspace.files.todos")}</div>
        )}
      </div>
    </div>
  );
}
