import { useState } from "react";
import { useParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/layout/AppShell";
import {
  Bug,
  Loader2,
  Clock,
  ChevronDown,
  ChevronRight,
  Flag,
  Eye,
  Activity,
  FileSearch,
  GitCompare,
  CheckCircle2,
  XCircle,
  Coins,
  Timer,
  ShieldCheck,
  FileJson,
  FileSpreadsheet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

// ─── Types ─────────────────────────────────────────────────────────

type Tab = "runs" | "responses" | "metrics";

// ─── Run List Panel ────────────────────────────────────────────────

function RunList({
  projectId,
  selectedRunId,
  onSelectRun,
}: {
  projectId: number;
  selectedRunId: number | null;
  onSelectRun: (id: number) => void;
}) {
  const { t } = useTranslation(["audit", "common"]);
  const { data: runs, isLoading } = trpc.response.listSwarmRuns.useQuery({ projectId });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="text-center py-8 text-neutral-600">
        <Activity className="w-8 h-8 mx-auto mb-2" />
        <p className="text-sm">{t("common:emptyStates.noExecutions")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {runs.map((run) => (
        <button
          key={run.id}
          onClick={() => onSelectRun(run.id)}
          className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
            selectedRunId === run.id
              ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
              : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            {run.status === "completed" && <CheckCircle2 className="w-3 h-3 text-blue-400" />}
            {run.status === "failed" && <XCircle className="w-3 h-3 text-red-400" />}
            {run.status === "running" && <Loader2 className="w-3 h-3 animate-spin text-amber-400" />}
            <span className="font-medium truncate">{run.userPrompt.substring(0, 50)}...</span>
          </div>
          <div className="flex items-center gap-3 text-neutral-600">
            <span className="flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "N/A"}
            </span>
            {run.totalTokensUsed && (
              <span>{run.totalTokensUsed.toLocaleString()} {t("audit:runCard.tokens")}</span>
            )}
            {run.totalLatencyMs && (
              <span>{(run.totalLatencyMs / 1000).toFixed(1)}{t("audit:runCard.seconds")}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Response Chain Viewer ─────────────────────────────────────────

function ResponseChainViewer({ swarmRunId }: { swarmRunId: number }) {
  const { t } = useTranslation(["audit", "common"]);
  const { data: chain, isLoading } = trpc.response.getChain.useQuery({ swarmRunId });
  const utils = trpc.useUtils();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [flagNotes, setFlagNotes] = useState("");
  const [showFlag, setShowFlag] = useState<number | null>(null);

  const flagMutation = trpc.response.flagResponse.useMutation({
    onSuccess: () => {
      utils.response.getChain.invalidate({ swarmRunId });
      setShowFlag(null);
      setFlagNotes("");
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!chain || chain.length === 0) {
    return (
      <div className="text-center py-8 text-neutral-600">
        <FileSearch className="w-8 h-8 mx-auto mb-2" />
        <p className="text-sm">{t("audit:responseChain.noResponses")}</p>
      </div>
    );
  }

  const roleColors: Record<string, string> = {
    builder: "border-l-blue-500",
    critic: "border-l-amber-500",
    refiner: "border-l-violet-500",
    polisher: "border-l-emerald-500",
  };

  return (
    <div className="space-y-2">
      {chain.map((resp) => (
        <div
          key={resp.id}
          className={`border border-neutral-800 rounded-md overflow-hidden ${
            roleColors[resp.metadata?.agentRole ?? ""] ?? "border-l-neutral-500"
          } border-l-2`}
        >
          <button
            onClick={() => setExpandedId(expandedId === resp.id ? null : resp.id)}
            className="w-full text-left px-4 py-3 hover:bg-neutral-800/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-neutral-200 capitalize">
                  {resp.metadata?.agentName ?? t("common:errors.generic")}
                </span>
                <span className="text-xs px-2 py-0.5 bg-neutral-800 rounded text-neutral-400">
                  {resp.responseType}
                </span>
                {resp.isFlagged && (
                  <Flag className="w-3.5 h-3.5 text-red-400" />
                )}
                {resp.humanReviewed && (
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-400" />
                )}
              </div>
              <div className="flex items-center gap-4 text-xs text-neutral-500">
                <span>{resp.metadata?.model ?? t("common:errors.generic")}</span>
                <span>{resp.metadata?.tokensUsed?.total?.toLocaleString() ?? 0} {t("audit:runCard.tokens")}</span>
                <span>{((resp.metadata?.latencyMs ?? 0) / 1000).toFixed(1)}{t("audit:runCard.seconds")}</span>
                {expandedId === resp.id ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </div>
            </div>
          </button>

          {expandedId === resp.id && (
            <div className="px-4 pb-3 border-t border-neutral-800/50">
              <div className="mt-3 p-3 bg-neutral-900 rounded-md text-xs text-neutral-300 font-mono whitespace-pre-wrap max-h-64 overflow-auto">
                {resp.content}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-400/10"
                  onClick={() => setShowFlag(showFlag === resp.id ? null : resp.id)}
                >
                  <Flag className="w-3 h-3 mr-1" />
                  {resp.isFlagged ? t("audit:responseChain.flagged") : t("audit:responseChain.flag")}
                </Button>
                {showFlag === resp.id && (
                  <div className="flex items-center gap-2 flex-1">
                    <input
                      type="text"
                      value={flagNotes}
                      onChange={(e) => setFlagNotes(e.target.value)}
                      placeholder={t("audit:responseChain.flagReason")}
                      className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200"
                    />
                    <Button
                      size="sm"
                      className="h-6 bg-red-600 hover:bg-red-700 text-xs"
                      onClick={() => flagMutation.mutate({ responseId: resp.id, notes: flagNotes })}
                    >
                      {t("audit:responseChain.saveFlag")}
                    </Button>
                  </div>
                )}
              </div>
              {resp.humanNotes && (
                <p className="mt-2 text-xs text-neutral-500 italic">
                  {t("audit:responseChain.note")}: {resp.humanNotes}
                </p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Metrics Panel ─────────────────────────────────────────────────

function MetricsPanel({ swarmRunId }: { swarmRunId: number }) {
  const { t } = useTranslation(["audit", "common"]);
  const { data: stats, isLoading } = trpc.debug.getRunStats.useQuery({ swarmRunId });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="text-center py-8 text-neutral-600">
        <Activity className="w-8 h-8 mx-auto mb-2" />
        <p className="text-sm">{t("common:emptyStates.noData")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Run summary */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
        <p className="text-xs text-neutral-500 mb-1">Prompt</p>
        <p className="text-sm text-neutral-200 font-medium">{stats.run.userPrompt}</p>
        <div className="flex items-center gap-4 mt-2 text-xs text-neutral-500">
          <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-blue-400" />{stats.run.status}</span>
          <span className="flex items-center gap-1"><Coins className="w-3 h-3" />{stats.run.totalTokensUsed?.toLocaleString() ?? 0} tokens</span>
          <span className="flex items-center gap-1"><Timer className="w-3 h-3" />{((stats.run.totalLatencyMs ?? 0) / 1000).toFixed(1)}s</span>
        </div>
      </div>

      {/* Step-by-step breakdown */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-blue-400" />
            Pipeline Steps
          </h3>
        </div>
        <div className="divide-y divide-neutral-800/50">
          {stats.steps.map((step, idx) => (
            <div key={idx} className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${
                  step.agentRole === "builder" ? "bg-blue-500" :
                  step.agentRole === "critic" ? "bg-amber-500" :
                  step.agentRole === "refiner" ? "bg-violet-500" :
                  step.agentRole === "polisher" ? "bg-blue-500" : "bg-neutral-500"
                }`} />
                <span className="text-sm font-medium text-neutral-200 capitalize">
                  {t(`common:agentRoles.${step.agentRole}`, step.agentRole)}
                </span>
                {(step.iteration ?? 1) > 1 && <span className="text-xs text-neutral-600">(iter {step.iteration ?? 1})</span>}
              </div>
              <div className="flex items-center gap-4 text-xs text-neutral-500">
                <span>{step.tokensUsed.toLocaleString()} tokens</span>
                <span>{(step.latencyMs / 1000).toFixed(1)}s</span>
                <span className="text-neutral-600">{step.modelUsed}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* By role summary */}
      {stats.byRole.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-800">
            <h3 className="text-sm font-semibold text-neutral-200">By Role</h3>
          </div>
          <div className="divide-y divide-neutral-800/50">
            {stats.byRole.map((role) => (
              <div key={role.role} className="px-4 py-2 flex items-center justify-between text-xs">
                <span className="text-neutral-300 capitalize">{t(`common:agentRoles.${role.role}`, role.role)}</span>
                <span className="text-neutral-500">{role.count} runs | ~{role.avgTokens} tokens avg | ~{(role.avgLatencyMs / 1000).toFixed(1)}s avg</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-neutral-600">{stats.responseCount} responses stored for this run</p>
    </div>
  );
}

// ─── Compliance Export Card (admin only) ────────────────────────────

function ComplianceExportCard() {
  const { t } = useTranslation(["audit", "common"]);
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const stamp = () => new Date().toISOString().slice(0, 10);

  const handleExportJson = async () => {
    setExporting("json");
    try {
      const envelope = await utils.export.auditLedgerJson.fetch({});
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
      downloadBlob(blob, `audit-ledger-${stamp()}.json`);
      toast.success(t("audit:complianceExport.successJson"));
    } catch (err) {
      toast.error(t("audit:complianceExport.error", { error: (err as Error).message }));
    } finally {
      setExporting(null);
    }
  };

  const handleExportCsv = async () => {
    setExporting("csv");
    try {
      const result = await utils.export.auditLedgerCsv.fetch({});
      // Stitch the per-section CSVs into one file with the signature header,
      // so a single browser download carries every section.
      const parts: string[] = [
        `# signature: ${result.signature}`,
        `# signedAt: ${result.signedAt}`,
        `# algorithm: ${result.algorithm}`,
      ];
      for (const [section, csv] of Object.entries(result.files)) {
        parts.push("");
        parts.push(`# section: ${section}`);
        parts.push(csv);
      }
      const blob = new Blob([parts.join("\r\n")], { type: "text/csv" });
      downloadBlob(blob, `audit-ledger-${stamp()}.csv`);
      toast.success(t("audit:complianceExport.successCsv"));
    } catch (err) {
      toast.error(t("audit:complianceExport.error", { error: (err as Error).message }));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="px-3 py-3 border-b border-neutral-800">
      <div className="bg-neutral-950/60 border border-neutral-800 rounded-lg p-3 space-y-2">
        <h3 className="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          {t("audit:complianceExport.title")}
        </h3>
        <p className="text-[10px] text-neutral-500 leading-relaxed">
          {t("audit:complianceExport.description")}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-xs border-neutral-700 text-neutral-300 hover:text-blue-300 hover:border-blue-500/30"
          disabled={exporting !== null}
          onClick={handleExportJson}
        >
          {exporting === "json" ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <FileJson className="w-3 h-3 mr-1" />
          )}
          {t("audit:complianceExport.downloadJson")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-xs border-neutral-700 text-neutral-300 hover:text-blue-300 hover:border-blue-500/30"
          disabled={exporting !== null}
          onClick={handleExportCsv}
        >
          {exporting === "csv" ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <FileSpreadsheet className="w-3 h-3 mr-1" />
          )}
          {t("audit:complianceExport.downloadCsv")}
        </Button>
      </div>
    </div>
  );
}

// ─── Inner Audit Content (reusable, no AppShell) ──────────────────

export function AuditContent({ projectId }: { projectId: number }) {
  const { t } = useTranslation(["audit", "common"]);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [activeTab, setActiveTab] = useState<Tab>("runs");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const tabs: { key: Tab; label: string; icon: typeof Bug }[] = [
    { key: "runs", label: t("audit:tabs.runs"), icon: Activity },
    { key: "responses", label: t("audit:tabs.responses"), icon: FileSearch },
    { key: "metrics", label: t("audit:tabs.metrics"), icon: GitCompare },
  ];

  return (
    <div className="flex h-full">
      {/* Left sidebar: Run list */}
      <div className="w-72 border-r border-neutral-800 bg-neutral-900 flex flex-col">
        <div className="px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-100 flex items-center gap-2">
            <Bug className="w-4 h-4 text-blue-400" />
            {t("audit:title")}
          </h2>
        </div>
        {isAdmin && <ComplianceExportCard />}
        <ScrollArea className="flex-1 p-3">
          <RunList
            projectId={projectId}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
          />
        </ScrollArea>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-neutral-800 bg-neutral-900">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === tab.key
                  ? "bg-blue-500/10 text-blue-400"
                  : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 p-6">
          {activeTab === "runs" && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-200 mb-4">
                {t("audit:tabs.runs")}
              </h3>
              {!selectedRunId ? (
                <div className="text-center py-12 text-neutral-600">
                  <Eye className="w-10 h-10 mx-auto mb-3" />
                  <p className="text-sm">{t("audit:selectRun")}</p>
                </div>
              ) : (
                <ResponseChainViewer swarmRunId={selectedRunId} />
              )}
            </div>
          )}

          {activeTab === "responses" && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-200 mb-4">
                {t("audit:tabs.responses")}
              </h3>
              {!selectedRunId ? (
                <div className="text-center py-12 text-neutral-600">
                  <FileSearch className="w-10 h-10 mx-auto mb-3" />
                  <p className="text-sm">{t("audit:selectRunForChain")}</p>
                  <p className="text-xs text-neutral-700 mt-1">
                    {t("audit:selectRunDesc")}
                  </p>
                </div>
              ) : (
                <ResponseChainViewer swarmRunId={selectedRunId} />
              )}
            </div>
          )}

          {activeTab === "metrics" && (
            <div>
              <h3 className="text-sm font-semibold text-neutral-200 mb-4">
                {t("audit:tabs.metrics")}
              </h3>
              {!selectedRunId ? (
                <div className="text-center py-12 text-neutral-600">
                  <GitCompare className="w-10 h-10 mx-auto mb-3" />
                  <p className="text-sm">Select a run to view metrics</p>
                </div>
              ) : (
                <MetricsPanel swarmRunId={selectedRunId} />
              )}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

// ─── Main Page (standalone route — thin wrapper) ───────────────────

export default function AuditPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id ?? "0");

  const { data: project } = trpc.project.getById.useQuery({ id: projectId });

  if (!project) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <AuditContent projectId={projectId} />
    </AppShell>
  );
}
