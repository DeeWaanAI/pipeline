import { useState, useMemo } from "react";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Database,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  FlaskConical,
  Bug,
  Activity,
  Clock,
  Zap,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Download,
  Trash2,
  Package,
  Play,
} from "lucide-react";

// ─── Run data from listAllRuns ──────────────────────────────────────
interface RunRow {
  id: number;
  userPrompt: string | null;
  status: string;
  currentStep: string | null;
  pipelineVersion: number | null;
  totalTokensUsed: number | null;
  totalLatencyMs: number | null;
  startedAt: Date;
  completedAt: Date | null;
  projectId: number;
  projectName: string;
  isTestRun: boolean | null;
}

// ─── Test fixture from testFixture.list ─────────────────────────────
interface FixtureRow {
  id: number;
  name: string;
  description: string | null;
  complexity: string | null;
  sizeBytes: number | null;
  fileCount: number | null;
  createdAt: Date | null;
}

type TabKey = "audit" | "testing";

const STATUS_BADGE: Record<string, { color: string; icon: typeof CheckCircle2 }> = {
  completed: { color: "text-green-400 bg-green-500/10 border-green-500/30", icon: CheckCircle2 },
  failed: { color: "text-red-400 bg-red-500/10 border-red-500/30", icon: XCircle },
  cancelled: { color: "text-amber-400 bg-amber-500/10 border-amber-500/30", icon: AlertCircle },
  running: { color: "text-blue-400 bg-blue-500/10 border-blue-500/30", icon: Loader2 },
};

const COMPLEXITY_BADGE: Record<string, string> = {
  easy: "text-green-400 bg-green-500/10 border-green-500/30",
  medium: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  complex: "text-red-400 bg-red-500/10 border-red-500/30",
};

export default function MyDataPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("audit");
  const { t } = useTranslation("pages");

  return (
    <AppShell>
      <div className="h-full flex flex-col bg-neutral-950 text-neutral-100">
        {/* Header */}
        <div className="border-b border-neutral-800 bg-neutral-900/50 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-blue-400" />
              <h1 className="text-lg font-bold text-neutral-100">{t("pages:myData.title")}</h1>
            </div>
          </div>
          {/* Tab bar */}
          <div className="flex items-center gap-1 mt-3">
            <button
              onClick={() => setActiveTab("audit")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === "audit" ? "bg-blue-500/10 text-blue-400" : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800"}`}
            >
              <Bug className="w-3.5 h-3.5" />
              {t("pages:myData.tabs.audit")}
            </button>
            <button
              onClick={() => setActiveTab("testing")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === "testing" ? "bg-blue-500/10 text-blue-400" : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800"}`}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {t("pages:myData.tabs.testing")}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === "audit" ? <AuditTab /> : <TestingDataTab />}
        </div>
      </div>
    </AppShell>
  );
}

// ─── Execution Audit Tab ─────────────────────────────────────────────
function AuditTab() {
  const { data: runs, isLoading } = trpc.response.listAllRuns.useQuery({ limit: 100 });
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const { t } = useTranslation("pages");

  // Group runs by project
  const grouped = useMemo(() => {
    if (!runs) return new Map<string, RunRow[]>();
    const map = new Map<string, RunRow[]>();
    for (const run of runs as RunRow[]) {
      const key = run.projectName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(run);
    }
    // Auto-expand all projects initially
    if (expandedProjects.size === 0) {
      const initial = new Set<string>();
      for (const key of map.keys()) initial.add(key);
      setExpandedProjects(initial);
    }
    return map;
  }, [runs]);

  const toggleProject = (name: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500">
        <Bug className="w-12 h-12 text-neutral-700 mb-3" />
        <p className="text-sm text-neutral-400">{t("pages:myData.audit.noRuns")}</p>
        <p className="text-xs text-neutral-600 mt-1">{t("pages:myData.audit.noRunsDesc")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left sidebar: runs grouped by project */}
      <div className="w-80 border-r border-neutral-800 bg-neutral-900/30 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-800">
          <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            {t("pages:myData.audit.allRuns")} ({(runs as RunRow[]).length})
          </h3>
        </div>
        <ScrollArea className="flex-1 p-3">
          {Array.from(grouped.entries()).map(([projectName, projectRuns]) => {
            const isExpanded = expandedProjects.has(projectName);
            return (
              <div key={projectName} className="mb-2">
                <button
                  onClick={() => toggleProject(projectName)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs font-medium text-neutral-300 hover:bg-neutral-800 transition-colors"
                >
                  {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <FolderOpen className="w-3.5 h-3.5 text-blue-400/70" />
                  <span className="truncate flex-1 text-left">{projectName}</span>
                  <span className="text-[10px] text-neutral-600">{projectRuns.length}</span>
                </button>
                {isExpanded && (
                  <div className="ml-3 space-y-0.5 mt-1">
                    {projectRuns.map((run) => {
                      const statusInfo = STATUS_BADGE[run.status] ?? STATUS_BADGE.running;
                      const StatusIcon = statusInfo.icon;
                      const isSelected = selectedRunId === run.id;
                      return (
                        <button
                          key={run.id}
                          onClick={() => setSelectedRunId(run.id)}
                          className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${isSelected ? "bg-blue-500/10 text-blue-400" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"}`}
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <StatusIcon className={`w-3 h-3 shrink-0 ${run.status === "running" ? "animate-spin" : ""}`} />
                            <span className="truncate flex-1">{run.userPrompt?.substring(0, 50) || t("pages:myData.audit.noPrompt")}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-neutral-600">
                            <span>{new Date(run.startedAt).toLocaleDateString()}</span>
                            {run.totalTokensUsed != null && <span>{run.totalTokensUsed.toLocaleString()} tok</span>}
                            {run.totalLatencyMs != null && <span>{(run.totalLatencyMs / 1000).toFixed(1)}s</span>}
                            {run.isTestRun && (
                              <Badge variant="outline" className="text-[9px] px-1 py-0 border-violet-500/30 text-violet-400">{t("pages:myData.audit.testBadge")}</Badge>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </ScrollArea>
      </div>

      {/* Main: Response chain viewer */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selectedRunId ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <Bug className="w-12 h-12 text-neutral-700 mb-3" />
            <p className="text-sm text-neutral-400">{t("pages:myData.audit.selectRun")}</p>
            <p className="text-xs text-neutral-600 mt-1 max-w-md text-center">
              {t("pages:myData.audit.selectRunDesc")}
            </p>
          </div>
        ) : (
          <RunDetailView runId={selectedRunId} />
        )}
      </div>
    </div>
  );
}

// ─── Testing Data Tab ────────────────────────────────────────────────
function TestingDataTab() {
  const utils = trpc.useUtils();
  const { t } = useTranslation("pages");
  const { data: fixtures, isLoading: fixturesLoading } = trpc.testFixture.list.useQuery();
  const { data: allRuns, isLoading: runsLoading } = trpc.response.listAllRuns.useQuery({ limit: 200 });
  const [selectedFixtureId, setSelectedFixtureId] = useState<number | null>(null);
  const [selectedTestRunId, setSelectedTestRunId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Filter only test runs
  const testRuns = useMemo(() => {
    if (!allRuns) return [];
    return (allRuns as RunRow[]).filter((r) => r.isTestRun);
  }, [allRuns]);

  // Group test runs by project
  const groupedRuns = useMemo(() => {
    const map = new Map<string, RunRow[]>();
    for (const run of testRuns) {
      const key = run.projectName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(run);
    }
    return map;
  }, [testRuns]);

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  // Auto-expand all test run projects
  useMemo(() => {
    if (expandedProjects.size === 0 && groupedRuns.size > 0) {
      const initial = new Set<string>();
      for (const key of groupedRuns.keys()) initial.add(key);
      setExpandedProjects(initial);
    }
  }, [groupedRuns]);

  const toggleProject = (name: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handleDeleteFixture = async (id: number, name: string) => {
    if (!confirm(t("pages:myData.fixture.deleteConfirm", { name }))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/test-fixtures/${id}`, {
        method: "DELETE",
        headers: { "x-local-auth-token": localStorage.getItem("local_auth_token") || "" },
      });
      if (!res.ok) throw new Error(t("pages:myData.fixture.deleteFailed"));
      toast.success(t("pages:myData.fixture.deleteSuccess", { name }));
      utils.testFixture.list.invalidate();
      if (selectedFixtureId === id) setSelectedFixtureId(null);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownloadFixture = async (id: number, name: string) => {
    try {
      const token = localStorage.getItem("local_auth_token") || "";
      const res = await fetch(`/api/test-fixtures/${id}.zip`, {
        headers: { "x-local-auth-token": token },
      });
      if (!res.ok) throw new Error(t("pages:myData.fixture.downloadFailed"));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const isLoading = fixturesLoading || runsLoading;
  const selectedFixture = fixtures?.find((f) => f.id === selectedFixtureId);

  // Determine what's shown in the main panel
  const hasSelection = selectedFixtureId !== null || selectedTestRunId !== null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }

  const fixtureList = (fixtures ?? []) as FixtureRow[];
  const hasAnyData = fixtureList.length > 0 || testRuns.length > 0;

  if (!hasAnyData) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500">
        <FlaskConical className="w-12 h-12 text-neutral-700 mb-3" />
        <p className="text-sm text-neutral-400">{t("pages:myData.testing.noData")}</p>
        <p className="text-xs text-neutral-600 mt-1 max-w-md text-center">
          {t("pages:myData.testing.noDataDesc")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div className="w-80 border-r border-neutral-800 bg-neutral-900/30 flex flex-col overflow-hidden">
        <ScrollArea className="flex-1 p-3">
          {/* Test Fixtures Section */}
          <div className="mb-4">
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5" />
              {t("pages:myData.testing.fixtures")} ({fixtureList.length})
            </h3>
            {fixtureList.length > 0 ? (
              <div className="space-y-0.5">
                {fixtureList.map((f) => {
                  const isSelected = selectedFixtureId === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => { setSelectedFixtureId(f.id); setSelectedTestRunId(null); }}
                      className={`w-full text-left px-2 py-2 rounded text-xs transition-colors ${isSelected ? "bg-blue-500/10 text-blue-400" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"}`}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <Package className="w-3 h-3 shrink-0 text-violet-400/70" />
                        <span className="truncate flex-1 font-medium">{f.name}</span>
                        {f.complexity && (
                          <Badge variant="outline" className={`text-[9px] px-1 py-0 ${COMPLEXITY_BADGE[f.complexity] ?? ""}`}>
                            {f.complexity}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-neutral-600 mt-0.5">
                        {f.fileCount != null && <span>{f.fileCount} {t("pages:myData.fixture.files", "files")}</span>}
                        {f.sizeBytes != null && <span>{formatBytes(f.sizeBytes)}</span>}
                        <span>{f.createdAt ? new Date(f.createdAt).toLocaleDateString() : "—"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-neutral-600 pl-2">{t("pages:myData.testing.noFixtures")}</p>
            )}
          </div>

          {/* Test Runs Section */}
          <div>
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Play className="w-3.5 h-3.5" />
              {t("pages:myData.testing.testRuns")} ({testRuns.length})
            </h3>
            {testRuns.length > 0 ? (
              <div className="space-y-1">
                {Array.from(groupedRuns.entries()).map(([projectName, runs]) => {
                  const isExpanded = expandedProjects.has(projectName);
                  return (
                    <div key={projectName}>
                      <button
                        onClick={() => toggleProject(projectName)}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-neutral-400 hover:bg-neutral-800 transition-colors"
                      >
                        {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        <FolderOpen className="w-3.5 h-3.5 text-emerald-400/70" />
                        <span className="truncate flex-1 text-left">{projectName}</span>
                        <span className="text-[10px] text-neutral-600">{runs.length}</span>
                      </button>
                      {isExpanded && (
                        <div className="ml-3 space-y-0.5 mt-0.5">
                          {runs.map((run) => {
                            const statusInfo = STATUS_BADGE[run.status] ?? STATUS_BADGE.running;
                            const StatusIcon = statusInfo.icon;
                            const isSelected = selectedTestRunId === run.id;
                            return (
                              <button
                                key={run.id}
                                onClick={() => { setSelectedTestRunId(run.id); setSelectedFixtureId(null); }}
                                className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${isSelected ? "bg-blue-500/10 text-blue-400" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"}`}
                              >
                                <div className="flex items-center gap-1.5 mb-0.5">
                                  <StatusIcon className={`w-3 h-3 shrink-0 ${run.status === "running" ? "animate-spin" : ""}`} />
                                  <span className="truncate flex-1">{run.userPrompt?.substring(0, 40) || t("pages:myData.audit.noPrompt")}</span>
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-neutral-600">
                                  <span>{new Date(run.startedAt).toLocaleDateString()}</span>
                                  {run.totalTokensUsed != null && <span>{run.totalTokensUsed.toLocaleString()} tok</span>}
                                  {run.totalLatencyMs != null && <span>{(run.totalLatencyMs / 1000).toFixed(1)}s</span>}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-neutral-600 pl-2">{t("pages:myData.testing.noRuns")}</p>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Main panel */}
      <div className="flex-1 overflow-y-auto p-6">
        {!hasSelection ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <FlaskConical className="w-12 h-12 text-neutral-700 mb-3" />
            <p className="text-sm text-neutral-400">{t("pages:myData.testing.selectItem")}</p>
            <p className="text-xs text-neutral-600 mt-1 max-w-md text-center">
              {t("pages:myData.testing.selectItemDesc")}
            </p>
          </div>
        ) : selectedFixtureId !== null && selectedFixture ? (
          <FixtureDetail
            fixture={selectedFixture}
            onDownload={() => handleDownloadFixture(selectedFixture.id, selectedFixture.name)}
            onDelete={() => handleDeleteFixture(selectedFixture.id, selectedFixture.name)}
            isDeleting={deletingId === selectedFixture.id}
          />
        ) : selectedTestRunId !== null ? (
          <RunDetailView runId={selectedTestRunId} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <p className="text-sm text-neutral-400">{t("pages:myData.testing.notFound")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Fixture Detail View ────────────────────────────────────────────
function FixtureDetail({
  fixture,
  onDownload,
  onDelete,
  isDeleting,
}: {
  fixture: FixtureRow;
  onDownload: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const { t } = useTranslation("pages");

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
            <Package className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-200">{fixture.name}</h3>
            <p className="text-xs text-neutral-500">{t("pages:myData.fixture.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onDownload}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-blue-400 hover:bg-blue-500/10 border border-blue-500/20 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            {t("pages:myData.fixture.downloadZip")}
          </button>
          <button
            onClick={onDelete}
            disabled={isDeleting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors disabled:opacity-50"
          >
            {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {t("pages:myData.fixture.delete")}
          </button>
        </div>
      </div>

      <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4 space-y-4">
        {/* Metadata grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetaCard label={t("pages:myData.fixture.complexity")} value={fixture.complexity ?? "—"} />
          <MetaCard label={t("pages:myData.fixture.files")} value={fixture.fileCount != null ? String(fixture.fileCount) : "—"} />
          <MetaCard label={t("pages:myData.fixture.size")} value={fixture.sizeBytes != null ? formatBytes(fixture.sizeBytes) : "—"} />
          <MetaCard label={t("pages:myData.fixture.created")} value={fixture.createdAt ? new Date(fixture.createdAt).toLocaleDateString() : "—"} />
        </div>

        {fixture.description && (
          <div>
            <p className="text-xs text-neutral-500 mb-1">{t("pages:myData.fixture.description")}</p>
            <p className="text-sm text-neutral-300">{fixture.description}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-neutral-800/50 rounded-md p-2.5">
      <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-0.5">{label}</p>
      <p className="text-sm text-neutral-300 font-medium">{value}</p>
    </div>
  );
}

// ─── Run Detail: shows response chain for a single run ──────────────
function RunDetailView({ runId }: { runId: number }) {
  const { data: chain, isLoading } = trpc.response.getChain.useQuery({ swarmRunId: runId });
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set());
  const { t } = useTranslation("pages");

  const toggleCard = (id: number) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (!chain || chain.length === 0) {
    return (
      <div className="text-center py-12 text-neutral-500">
        <p className="text-sm">{t("pages:myData.responseChain.noData")}</p>
      </div>
    );
  }

  const ROLE_COLORS: Record<string, string> = {
    builder: "border-l-blue-500",
    critic: "border-l-amber-500",
    refiner: "border-l-violet-500",
    polisher: "border-l-emerald-500",
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-neutral-200">{t("pages:myData.responseChain.title")}</h3>
        <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500">
          {t("pages:myData.responseChain.responses", { count: chain.length })}
        </Badge>
      </div>
      <div className="space-y-3">
        {(chain as Array<{
          id: number;
          content: string;
          responseType: string;
          metadata: {
            agentName?: string;
            agentRole?: string;
            tokensUsed?: { prompt: number; completion: number; total: number };
            latencyMs?: number;
            model?: string;
          };
          isFlagged: boolean | null;
        }>).map((resp) => {
          const isExpanded = expandedCards.has(resp.id);
          const borderColor = ROLE_COLORS[resp.metadata?.agentRole ?? ""] ?? "border-l-neutral-600";
          const agentName = resp.metadata?.agentName
            ?? (resp.metadata?.agentRole ? t("common:agentRoles." + resp.metadata.agentRole, resp.metadata.agentRole) : t("pages:myData.responseChain.agent"));
          const totalTokens = resp.metadata?.tokensUsed?.total;
          const latency = resp.metadata?.latencyMs;
          const model = resp.metadata?.model;
          return (
            <div key={resp.id} className={`bg-neutral-900 rounded-lg border border-neutral-800 border-l-2 ${borderColor} overflow-hidden`}>
              <button
                onClick={() => toggleCard(resp.id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-neutral-800/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-neutral-200 capitalize">{agentName}</span>
                    <Badge variant="outline" className="text-[10px] border-neutral-700 text-neutral-500">{resp.responseType}</Badge>
                    {resp.isFlagged && <Badge className="text-[10px] bg-red-500/10 text-red-400 border-red-500/30">{t("pages:myData.responseChain.flagged")}</Badge>}
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-neutral-600">
                    {model && <span>{model}</span>}
                    {totalTokens != null && <span className="flex items-center gap-0.5"><Zap className="w-2.5 h-2.5" />{totalTokens.toLocaleString()}</span>}
                    {latency != null && <span className="flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{(latency / 1000).toFixed(1)}s</span>}
                  </div>
                </div>
                {isExpanded ? <ChevronDown className="w-4 h-4 text-neutral-600" /> : <ChevronRight className="w-4 h-4 text-neutral-600" />}
              </button>
              {isExpanded && (
                <div className="px-4 pb-3 border-t border-neutral-800 pt-3">
                  <pre className="text-xs text-neutral-300 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">
                    {resp.content}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
