import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  FlaskConical, Upload, Download, Trash2, Package,
  Loader2, FileArchive, Plus, X,
} from "lucide-react";

type Complexity = "easy" | "medium" | "complex";

const COMPLEXITY_COLORS: Record<Complexity, string> = {
  easy: "bg-green-500/10 text-green-400 border-green-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  complex: "bg-red-500/10 text-red-400 border-red-500/20",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function TestFixturesPage() {
  const { t } = useTranslation("pages");
  const utils = trpc.useUtils();
  const { data: fixtures, isLoading } = trpc.testFixture.list.useQuery();

  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Upload form state
  const [fixtureName, setFixtureName] = useState("");
  const [fixtureDesc, setFixtureDesc] = useState("");
  const [fixtureComplexity, setFixtureComplexity] = useState<Complexity>("medium");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setFixtureName("");
    setFixtureDesc("");
    setFixtureComplexity("medium");
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith(".zip") && file.type !== "application/zip" && file.type !== "application/x-zip-compressed") {
      toast.error(t("pages:testFixtures.onlyZip"));
      return;
    }
    setSelectedFile(file);
    if (!fixtureName) {
      setFixtureName(file.name.replace(/\.zip$/i, ""));
    }
  }, [fixtureName, t]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleUpload = async () => {
    if (!selectedFile) {
      toast.error(t("pages:testFixtures.selectZipFirst"));
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("zipFile", selectedFile);
      formData.append("name", fixtureName || selectedFile.name.replace(/\.zip$/i, ""));
      if (fixtureDesc) formData.append("description", fixtureDesc);
      formData.append("complexity", fixtureComplexity);

      const res = await fetch("/api/test-fixtures/upload", {
        method: "POST",
        headers: {
          "x-local-auth-token": localStorage.getItem("local_auth_token") || "",
        },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(t("pages:testFixtures.uploadFailed", { error: err.error || `HTTP ${res.status}` }));
      }

      const data = await res.json();
      toast.success(t("pages:testFixtures.uploadSuccess", { name: data.name, fileCount: data.fileCount }));
      utils.testFixture.list.invalidate();
      resetForm();
      setShowUpload(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(t("pages:testFixtures.deleteConfirm", { name }))) return;
    try {
      const res = await fetch(`/api/test-fixtures/${id}`, {
        method: "DELETE",
        headers: {
          "x-local-auth-token": localStorage.getItem("local_auth_token") || "",
        },
      });
      if (!res.ok) throw new Error(t("pages:testFixtures.deleteFailed", { error: `HTTP ${res.status}` }));
      toast.success(t("pages:testFixtures.deleteSuccess", { name }));
      utils.testFixture.list.invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleDownload = (id: number, name: string) => {
    const token = localStorage.getItem("local_auth_token") || "";
    // Use a temporary link with auth in query string for GET download
    const link = document.createElement("a");
    link.href = `/api/test-fixtures/${id}.zip`;
    link.download = `${name}.zip`;
    // For auth, we need to fetch and create a blob URL
    fetch(`/api/test-fixtures/${id}.zip`, {
      headers: { "x-local-auth-token": token },
    })
      .then((res) => {
        if (!res.ok) throw new Error(t("pages:testFixtures.downloadFailed", { error: `HTTP ${res.status}` }));
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      })
      .catch((err) => toast.error(t("pages:testFixtures.downloadFailed", { error: err.message })));
  };

  return (
    <AppShell>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-900">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-5 h-5 text-emerald-400" />
            <div>
              <h1 className="text-lg font-semibold text-neutral-100">{t("pages:testFixtures.title")}</h1>
              <p className="text-xs text-neutral-500">{t("pages:testFixtures.subtitle")}</p>
            </div>
          </div>
          <Button
            onClick={() => setShowUpload(!showUpload)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {showUpload ? (
              <X className="w-4 h-4 mr-1" />
            ) : (
              <Plus className="w-4 h-4 mr-1" />
            )}
            {showUpload ? t("pages:testFixtures.closeButton") : t("pages:testFixtures.uploadButton")}
          </Button>
        </div>

        {/* Upload Form */}
        {showUpload && (
          <div className="border-b border-neutral-800 bg-neutral-900/50 px-6 py-4">
            <div className="max-w-2xl mx-auto space-y-4">
              {/* Drop Zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  dragOver
                    ? "border-emerald-400 bg-emerald-500/5"
                    : selectedFile
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : "border-neutral-700 hover:border-neutral-600"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                  }}
                />
                {selectedFile ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileArchive className="w-8 h-8 text-emerald-400" />
                    <div className="text-left">
                      <p className="text-sm font-medium text-neutral-200">{selectedFile.name}</p>
                      <p className="text-xs text-neutral-500">{formatBytes(selectedFile.size)}</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                    <p className="text-sm text-neutral-400">{t("pages:testFixtures.dropzone")}</p>
                    <p className="text-xs text-neutral-600 mt-1">{t("pages:testFixtures.maxSize")}</p>
                  </>
                )}
              </div>

              {/* Metadata */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-neutral-400 mb-1">{t("pages:testFixtures.nameLabel")}</label>
                  <input
                    type="text"
                    value={fixtureName}
                    onChange={(e) => setFixtureName(e.target.value)}
                    placeholder={t("pages:testFixtures.namePlaceholder")}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-400 mb-1">{t("pages:testFixtures.complexityLabel")}</label>
                  <select
                    value={fixtureComplexity}
                    onChange={(e) => setFixtureComplexity(e.target.value as Complexity)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="easy">{t("pages:testFixtures.complexityEasy")}</option>
                    <option value="medium">{t("pages:testFixtures.complexityMedium")}</option>
                    <option value="complex">{t("pages:testFixtures.complexityComplex")}</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-400 mb-1">{t("pages:testFixtures.descriptionLabel")}</label>
                <Textarea
                  value={fixtureDesc}
                  onChange={(e) => setFixtureDesc(e.target.value)}
                  placeholder={t("pages:testFixtures.descriptionPlaceholder")}
                  rows={2}
                  className="bg-neutral-800 border-neutral-700 text-neutral-100 resize-none"
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => { resetForm(); setShowUpload(false); }} className="text-neutral-400">
                  {t("pages:testFixtures.cancelButton")}
                </Button>
                <Button
                  onClick={handleUpload}
                  disabled={!selectedFile || uploading}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {uploading && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                  {t("pages:testFixtures.uploadButtonSubmit")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Fixtures List */}
        <ScrollArea className="flex-1 px-6 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-6 h-6 animate-spin text-neutral-500" />
            </div>
          ) : !fixtures || fixtures.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-neutral-600">
              <Package className="w-12 h-12 mb-3" />
              <p className="text-sm">{t("pages:testFixtures.emptyTitle")}</p>
              <p className="text-xs mt-1">{t("pages:testFixtures.emptyDesc")}</p>
            </div>
          ) : (
            <div className="space-y-2 max-w-3xl mx-auto">
              {fixtures.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between bg-neutral-900 border border-neutral-800 rounded-lg px-4 py-3 hover:border-neutral-700 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileArchive className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-neutral-200 truncate">{f.name}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${COMPLEXITY_COLORS[f.complexity ?? "medium"]}`}>
                          {f.complexity ?? "medium"}
                        </span>
                      </div>
                      {f.description && (
                        <p className="text-xs text-neutral-500 truncate">{f.description}</p>
                      )}
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[10px] text-neutral-600">
                          {f.fileCount} {t("pages:testFixtures.filesSuffix")}
                        </span>
                        <span className="text-[10px] text-neutral-600">
                          {f.sizeBytes ? formatBytes(f.sizeBytes) : "—"}
                        </span>
                        {f.createdAt && (
                          <span className="text-[10px] text-neutral-600">
                            {new Date(f.createdAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDownload(f.id, f.name)}
                      className="text-neutral-400 hover:text-emerald-400 h-7 px-2"
                      title={t("pages:testFixtures.downloadTooltip")}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(f.id, f.name)}
                      className="text-neutral-400 hover:text-red-400 h-7 px-2"
                      title={t("pages:testFixtures.deleteTooltip")}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </AppShell>
  );
}
