/**
 * Admin Panel
 * System-wide administration: feedback triage, user management, stats, feature flags.
 * Accessible only to users with role === "admin".
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/layout/AppShell";
import {
  Shield,
  MessageSquare,
  Users,
  BarChart3,
  ToggleLeft,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Search,
  ChevronDown,
  ChevronUp,
  Monitor,
  Globe,
  Cpu,
  XCircle,
  CheckCircle,
  ClipboardList,
  Award,
  Rocket,
  Server,
  Boxes,
  FileSearch,
  Coins,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────

type FeedbackStatus = "new" | "triaged" | "in_progress" | "resolved" | "verified" | "closed";
type FeedbackSeverity = "critical" | "major" | "minor" | "cosmetic";
type FeedbackType = "bug" | "suggestion" | "praise" | "confusion";
type UserRole = "user" | "admin";

type TabKey =
  | "feedback" | "users" | "stats" | "flags" | "certification" | "audit" | "beta"
  // v2 operations (spec D10)
  | "endpoints" | "catalog" | "evidence" | "spend";

// ─── Helpers ──────────────────────────────────────────────────────────

function statusColor(status: string) {
  switch (status) {
    case "new":         return "bg-blue-500/15 text-blue-400 border-blue-500/20";
    case "triaged":     return "bg-purple-500/15 text-purple-400 border-purple-500/20";
    case "in_progress": return "bg-amber-500/15 text-amber-400 border-amber-500/20";
    case "resolved":    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/20";
    case "verified":    return "bg-green-500/15 text-green-400 border-green-500/20";
    case "closed":      return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
    default:            return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
  }
}

function severityColor(severity: string) {
  switch (severity) {
    case "critical": return "bg-red-500/15 text-red-400 border-red-500/20";
    case "major":    return "bg-orange-500/15 text-orange-400 border-orange-500/20";
    case "minor":    return "bg-yellow-500/15 text-yellow-400 border-yellow-500/20";
    case "cosmetic": return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
    default:         return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
  }
}

function typeColor(type: string) {
  switch (type) {
    case "bug":        return "bg-red-500/15 text-red-400 border-red-500/20";
    case "suggestion": return "bg-blue-500/15 text-blue-400 border-blue-500/20";
    case "praise":     return "bg-emerald-500/15 text-emerald-400 border-emerald-500/20";
    case "confusion":  return "bg-yellow-500/15 text-yellow-400 border-yellow-500/20";
    default:           return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
  }
}

function timeAgo(date: Date | string | null | undefined, t: (key: string) => string): string {
  if (!date) return "\u2014";
  const d = typeof date === "string" ? new Date(date) : date;
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("pages:admin.time.justNow");
  if (mins < 60) return `${mins}${t("pages:admin.time.minutesAgo")}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}${t("pages:admin.time.hoursAgo")}`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}${t("pages:admin.time.daysAgo")}`;
  return d.toLocaleDateString();
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Badge component ──────────────────────────────────────────────────

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border font-medium capitalize ${className ?? ""}`}>
      {children}
    </span>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────

function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const { t } = useTranslation("pages");
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between px-1 pt-3">
      <span className="text-[11px] text-neutral-500">
        {total} {t("pages:admin.pagination.total")} \u2014 {t("pages:admin.pagination.page")} {page} {t("pages:admin.pagination.of")} {totalPages}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0 border-neutral-700"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0 border-neutral-700"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Filter Select ────────────────────────────────────────────────────

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation("pages");
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-200 h-8 text-xs min-w-[140px]">
          <SelectValue placeholder={t("pages:admin.feedback.allFilter", { label: label.toLowerCase() })} />
        </SelectTrigger>
        <SelectContent className="bg-neutral-800 border-neutral-700">
          <SelectItem value="__all__" className="text-neutral-300 text-xs">
            {t("pages:admin.feedback.all")}
          </SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-neutral-200 text-xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────

export default function AdminPanel() {
  const { t } = useTranslation("pages");
  const { user, isLoading: authLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<TabKey>("feedback");

  // Auth guard
  if (authLoading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
        </div>
      </AppShell>
    );
  }

  if (!user || user.role !== "admin") {
    return (
      <AppShell>
        <div className="flex flex-col items-center justify-center h-full text-neutral-500">
          <Shield className="w-12 h-12 mb-4 text-neutral-700" />
          <p className="text-sm font-medium">{t("pages:admin.accessDenied")}</p>
          <p className="text-xs mt-1">{t("pages:admin.accessDeniedDesc")}</p>
        </div>
      </AppShell>
    );
  }

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: "feedback", label: t("pages:admin.tabs.feedback"), icon: <MessageSquare className="w-4 h-4" /> },
    { key: "users", label: t("pages:admin.tabs.users"), icon: <Users className="w-4 h-4" /> },
    { key: "stats", label: t("pages:admin.tabs.stats"), icon: <BarChart3 className="w-4 h-4" /> },
    { key: "flags", label: t("pages:admin.tabs.flags"), icon: <ToggleLeft className="w-4 h-4" /> },
    { key: "certification", label: t("pages:admin.tabs.certification"), icon: <Award className="w-4 h-4" /> },
    { key: "audit", label: t("pages:admin.tabs.audit"), icon: <ClipboardList className="w-4 h-4" /> },
    { key: "beta", label: t("pages:admin.tabs.beta"), icon: <Rocket className="w-4 h-4" /> },
    { key: "endpoints", label: t("pages:admin.tabs.endpoints"), icon: <Server className="w-4 h-4" /> },
    { key: "catalog", label: t("pages:admin.tabs.catalog"), icon: <Boxes className="w-4 h-4" /> },
    { key: "evidence", label: t("pages:admin.tabs.evidence"), icon: <FileSearch className="w-4 h-4" /> },
    { key: "spend", label: t("pages:admin.tabs.spend"), icon: <Coins className="w-4 h-4" /> },
  ];

  return (
    <AppShell>
      <div className="flex flex-col h-full text-neutral-200 overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-4 border-b border-neutral-800">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <Shield className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-neutral-100">{t("pages:admin.title")}</h1>
              <p className="text-[11px] text-neutral-500">{t("pages:admin.subtitle")}</p>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex flex-wrap gap-1 gap-y-1.5">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeTab === tab.key
                    ? "bg-blue-500/10 text-blue-400 border border-blue-500/25"
                    : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/60 border border-transparent"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {activeTab === "feedback" && <FeedbackTab />}
          {activeTab === "users" && <UsersTab />}
          {activeTab === "stats" && <StatsTab />}
          {activeTab === "flags" && <FeatureFlagsTab />}
          {activeTab === "certification" && <CertificationTab />}
          {activeTab === "audit" && <AuditTab />}
          {activeTab === "beta" && <BetaTab />}
          {activeTab === "endpoints" && <EndpointsTab />}
          {activeTab === "catalog" && <CatalogTab />}
          {activeTab === "evidence" && <EvidenceTab />}
          {activeTab === "spend" && <SpendTab />}
        </div>
      </div>
    </AppShell>
  );
}

// ─── FEEDBACK TAB ─────────────────────────────────────────────────────
// Screenshot URLs arrive pre-signed from the server (short-lived, file-scoped
// ?exp&sig params) — plain <img src> works without any token handling here.
function FeedbackTab() {
  const { t } = useTranslation("pages");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("__all__");
  const [severity, setSeverity] = useState("__all__");
  const [feedbackType, setFeedbackType] = useState("__all__");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);
  const pageSize = 20;

  const { data, isLoading, error } = trpc.admin.listAllFeedback.useQuery({
    page,
    pageSize,
    status: status !== "__all__" ? (status as FeedbackStatus) : undefined,
    severity: severity !== "__all__" ? (severity as FeedbackSeverity) : undefined,
    feedbackType: feedbackType !== "__all__" ? (feedbackType as FeedbackType) : undefined,
  });

  // Reset page when filters change
  const handleFilterChange = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(1);
  };

  const utils = trpc.useUtils();
  const updateStatus = trpc.admin.updateFeedbackStatus.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.feedback.statusUpdated"));
      utils.admin.listAllFeedback.invalidate();
    },
    onError: (err) => toast.error(t("pages:admin.feedback.updateFailed", { error: err.message })),
  });

  return (
    <div className="space-y-4">
      {/* Filters row */}
      <div className="flex flex-wrap items-end gap-3 bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
        <FilterSelect
          label={t("pages:admin.feedback.status")}
          value={status}
          onChange={handleFilterChange(setStatus)}
          options={[
            { value: "new", label: t("pages:admin.feedback.statuses.new") },
            { value: "triaged", label: t("pages:admin.feedback.statuses.triaged") },
            { value: "in_progress", label: t("pages:admin.feedback.statuses.in_progress") },
            { value: "resolved", label: t("pages:admin.feedback.statuses.resolved") },
            { value: "verified", label: t("pages:admin.feedback.statuses.verified") },
            { value: "closed", label: t("pages:admin.feedback.statuses.closed") },
          ]}
        />
        <FilterSelect
          label={t("pages:admin.feedback.severity")}
          value={severity}
          onChange={handleFilterChange(setSeverity)}
          options={[
            { value: "critical", label: t("pages:admin.feedback.severities.critical") },
            { value: "major", label: t("pages:admin.feedback.severities.major") },
            { value: "minor", label: t("pages:admin.feedback.severities.minor") },
            { value: "cosmetic", label: t("pages:admin.feedback.severities.cosmetic") },
          ]}
        />
        <FilterSelect
          label={t("pages:admin.feedback.type")}
          value={feedbackType}
          onChange={handleFilterChange(setFeedbackType)}
          options={[
            { value: "bug", label: t("pages:admin.feedback.types.bug") },
            { value: "suggestion", label: t("pages:admin.feedback.types.suggestion") },
            { value: "praise", label: t("pages:admin.feedback.types.praise") },
            { value: "confusion", label: t("pages:admin.feedback.types.confusion") },
          ]}
        />
        <div className="ml-auto text-[11px] text-neutral-500 self-end pb-1">
          {data ? `${data.total} ${t("pages:admin.feedback.itemsSuffix")}` : ""}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="font-medium mb-1">{t("pages:admin.feedback.loadFailed")}</p>
          <p className="text-xs text-red-400/70">{error.message}</p>
        </div>
      )}

      {/* Feedback list */}
      {data && data.items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-600">
          <MessageSquare className="w-10 h-10 mb-3" />
          <p className="text-sm">{t("pages:admin.feedback.noResults")}</p>
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="space-y-2">
            {data.items.map((fb) => {
              const isExpanded = expandedId === fb.id;
              const ctx = fb.contextJson as {
                url?: string;
                browser?: string;
                os?: string;
                screenshotUrl?: string;
                consoleLogs?: string[];
                activePipeline?: string;
                activeStep?: string;
                modelUsed?: string;
              } | null;
              // Only real screenshots may reach the <img> below — ctx.url is
              // the page the user was on, not an image (audit fix #4).
              const screenshotUrl = fb.screenshotUrl ?? ctx?.screenshotUrl;

              return (
                <div
                  key={fb.id}
                  className={`bg-neutral-900 border rounded-xl transition-colors ${
                    isExpanded ? "border-blue-500/30" : "border-neutral-800 hover:border-neutral-700"
                  }`}
                >
                  {/* Collapsed row */}
                  <button
                    className="w-full text-left px-4 py-3 flex items-center gap-3"
                    onClick={() => setExpandedId(isExpanded ? null : fb.id)}
                  >
                    {/* Expand chevron */}
                    <span className="text-neutral-600 shrink-0">
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </span>

                    {/* Username */}
                    <span className="text-xs font-medium text-neutral-300 w-24 shrink-0 truncate" title={fb.username ?? "\u2014"}>
                      {fb.username ?? t("pages:admin.feedback.anonymous")}
                    </span>

                    {/* Badges */}
                    <Badge className={typeColor(fb.feedbackType)}>{fb.feedbackType}</Badge>
                    {fb.severity && <Badge className={severityColor(fb.severity)}>{fb.severity}</Badge>}
                    <Badge className={statusColor(fb.status)}>{fb.status.replace("_", " ")}</Badge>

                    {/* Content preview */}
                    <span className="flex-1 text-xs text-neutral-400 truncate ml-2">
                      {fb.content}
                    </span>

                    {/* Date */}
                    <span className="text-[10px] text-neutral-600 shrink-0 ml-2">
                      {timeAgo(fb.createdAt, t)}
                    </span>
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-neutral-800/60 ml-7">
                      {/* Full content */}
                      <div className="mb-4">
                        <p className="text-[10px] text-neutral-500 uppercase tracking-wide mb-1">{t("pages:admin.feedback.content")}</p>
                        <p className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed bg-neutral-800/40 rounded-lg p-3 border border-neutral-800">
                          {fb.content}
                        </p>
                      </div>

                      {/* Context metadata */}
                      {ctx && (
                        <div className="mb-4">
                          <p className="text-[10px] text-neutral-500 uppercase tracking-wide mb-1.5">{t("pages:admin.feedback.context")}</p>
                          <div className="flex flex-wrap gap-2">
                            {ctx.url && (
                              <span className="flex items-center gap-1 text-[11px] text-neutral-400 bg-neutral-800 px-2 py-1 rounded border border-neutral-700">
                                <Globe className="w-3 h-3" /> {ctx.url}
                              </span>
                            )}
                            {ctx.browser && (
                              <span className="flex items-center gap-1 text-[11px] text-neutral-400 bg-neutral-800 px-2 py-1 rounded border border-neutral-700">
                                <Monitor className="w-3 h-3" /> {ctx.browser}
                              </span>
                            )}
                            {ctx.os && (
                              <span className="flex items-center gap-1 text-[11px] text-neutral-400 bg-neutral-800 px-2 py-1 rounded border border-neutral-700">
                                <Cpu className="w-3 h-3" /> {ctx.os}
                              </span>
                            )}
                            {ctx.activePipeline && (
                              <span className="flex items-center gap-1 text-[11px] text-neutral-400 bg-neutral-800 px-2 py-1 rounded border border-neutral-700">
                                {t("pages:admin.feedback.pipeline")} {ctx.activePipeline}
                              </span>
                            )}
                            {ctx.activeStep && (
                              <span className="flex items-center gap-1 text-[11px] text-neutral-400 bg-neutral-800 px-2 py-1 rounded border border-neutral-700">
                                {t("pages:admin.feedback.step")} {ctx.activeStep}
                              </span>
                            )}
                            {ctx.modelUsed && (
                              <span className="flex items-center gap-1 text-[11px] text-neutral-400 bg-neutral-800 px-2 py-1 rounded border border-neutral-700">
                                {t("pages:admin.feedback.model")} {ctx.modelUsed}
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Console logs */}
                      {ctx?.consoleLogs && ctx.consoleLogs.length > 0 && (
                        <div className="mb-4">
                          <p className="text-[10px] text-neutral-500 uppercase tracking-wide mb-1.5">{t("pages:admin.feedback.consoleLogs")}</p>
                          <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 max-h-32 overflow-y-auto">
                            {ctx.consoleLogs.map((log, i) => (
                              <p key={i} className="text-[10px] font-mono text-neutral-500 leading-relaxed">
                                {log}
                              </p>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Screenshot thumbnail */}
                      {screenshotUrl && (
                        <div className="mb-4">
                          <p className="text-[10px] text-neutral-500 uppercase tracking-wide mb-1.5">{t("pages:admin.feedback.screenshot")}</p>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedScreenshot(screenshotUrl);
                            }}
                            className="block"
                          >
                            <img
                              src={screenshotUrl}
                              alt={t("pages:admin.feedback.screenshotAlt")}
                              className="max-h-40 rounded-lg border border-neutral-700 hover:border-blue-500/50 transition-colors object-cover shadow-lg"
                            />
                          </button>
                        </div>
                      )}

                      {/* Status change controls */}
                      <div className="flex items-center gap-3 pt-2 border-t border-neutral-800/60 flex-wrap">
                        <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{t("pages:admin.feedback.changeStatus")}</span>
                        {(["new", "triaged", "in_progress", "resolved", "verified", "closed"] as const).map((s) => (
                          <button
                            key={s}
                            onClick={() => updateStatus.mutate({ feedbackId: fb.id, status: s })}
                            disabled={fb.status === s || updateStatus.isPending}
                            className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                              fb.status === s
                                ? "border-blue-500/40 bg-blue-500/10 text-blue-400 cursor-default"
                                : "border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600"
                            }`}
                          >
                            {s.replace("_", " ")}
                          </button>
                        ))}
                        {updateStatus.isPending && (
                          <Loader2 className="w-3 h-3 animate-spin text-blue-400 ml-1" />
                        )}
                      </div>

                      {/* Metadata */}
                      <div className="flex items-center gap-4 mt-3 text-[10px] text-neutral-600">
                        <span>{t("pages:admin.meta.id")} {fb.id}</span>
                        <span>{t("pages:admin.meta.userId")} {fb.userId}</span>
                        {fb.projectId && <span>{t("pages:admin.meta.projectId")} {fb.projectId}</span>}
                        <span>{t("pages:admin.meta.created")} {fb.createdAt ? new Date(fb.createdAt).toLocaleString() : "\u2014"}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
          />
        </>
      )}

      {/* Screenshot lightbox */}
      {expandedScreenshot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => setExpandedScreenshot(null)}
        >
          <img
            src={expandedScreenshot}
            alt={t("pages:admin.feedback.screenshotFull")}
            className="max-w-[92vw] max-h-[92vh] rounded-xl border border-neutral-700 shadow-2xl"
          />
          <button
            className="absolute top-6 right-6 text-neutral-400 hover:text-white transition-colors"
            onClick={() => setExpandedScreenshot(null)}
          >
            <XCircle className="w-8 h-8" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── USERS TAB ────────────────────────────────────────────────────────

function UsersTab() {
  const { t } = useTranslation("pages");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const pageSize = 20;

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = trpc.admin.listUsers.useQuery({
    page,
    pageSize,
    search: debouncedSearch || undefined,
  });

  const utils = trpc.useUtils();
  const setRole = trpc.admin.setUserRole.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.users.roleUpdated"));
      utils.admin.listUsers.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex items-center gap-3 bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
        <Search className="w-4 h-4 text-neutral-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("pages:admin.users.searchPlaceholder")}
          className="flex-1 bg-transparent text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none"
        />
        {data && (
          <span className="text-[11px] text-neutral-500">{data.total} {t("pages:admin.users.countSuffix")}</span>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        </div>
      )}

      {/* User table */}
      {data && data.users.length > 0 && (
        <>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="text-left px-4 py-3 font-medium">{t("pages:admin.users.headers.user")}</th>
                  <th className="text-left px-4 py-3 font-medium">{t("pages:admin.users.headers.email")}</th>
                  <th className="text-left px-4 py-3 font-medium">{t("pages:admin.users.headers.role")}</th>
                  <th className="text-right px-4 py-3 font-medium">{t("pages:admin.users.headers.projects")}</th>
                  <th className="text-right px-4 py-3 font-medium">{t("pages:admin.users.headers.runs")}</th>
                  <th className="text-right px-4 py-3 font-medium">{t("pages:admin.users.headers.lastSignIn")}</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id} className="border-b border-neutral-800/50 hover:bg-neutral-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                          {(u.name || u.username || "?").charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-neutral-200">{u.name || u.username}</p>
                          <p className="text-[10px] text-neutral-600">@{u.username}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{u.email || "\u2014"}</td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        onChange={(e) => setRole.mutate({ userId: u.id, role: e.target.value as UserRole })}
                        className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 focus:outline-none focus:border-blue-500"
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-400">{u.projectCount}</td>
                    <td className="px-4 py-3 text-right text-neutral-400">{u.runCount}</td>
                    <td className="px-4 py-3 text-right text-neutral-500">{timeAgo(u.lastSignInAt, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={setPage}
          />
        </>
      )}

      {data && data.users.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-600">
          <Users className="w-10 h-10 mb-3" />
          <p className="text-sm">{t("pages:admin.users.noResults")}</p>
        </div>
      )}
    </div>
  );
}

// ─── STATS TAB ────────────────────────────────────────────────────────

function StatsTab() {
  const { t } = useTranslation("pages");
  const { data, isLoading, error } = trpc.admin.systemStats.useQuery(undefined, {
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
        <p className="font-medium">{t("pages:admin.stats.loadFailed")}</p>
        <p className="text-xs text-red-400/70 mt-1">{error?.message ?? t("pages:admin.stats.unknownError")}</p>
      </div>
    );
  }

  const statGroups = [
    {
      title: t("pages:admin.stats.usersGroup"),
      icon: <Users className="w-4 h-4 text-blue-400" />,
      stats: [
        { label: t("pages:admin.stats.totalUsers"), value: data.users.total },
        { label: t("pages:admin.stats.active7d"), value: data.users.active7d },
      ],
    },
    {
      title: t("pages:admin.stats.runsGroup"),
      icon: <BarChart3 className="w-4 h-4 text-emerald-400" />,
      stats: [
        { label: t("pages:admin.stats.totalRuns"), value: data.runs.total },
        { label: t("pages:admin.stats.completed"), value: data.runs.completed },
        { label: t("pages:admin.stats.failed"), value: data.runs.failed },
        { label: t("pages:admin.stats.totalTokens"), value: data.runs.totalTokens?.toLocaleString() ?? "0" },
      ],
    },
    {
      title: t("pages:admin.stats.feedbackGroup"),
      icon: <MessageSquare className="w-4 h-4 text-amber-400" />,
      stats: [
        { label: t("pages:admin.stats.totalFeedback"), value: data.feedback.total },
        { label: t("pages:admin.stats.open"), value: data.feedback.open },
        { label: t("pages:admin.stats.criticalOpen"), value: data.feedback.critical },
      ],
    },
    {
      title: t("pages:admin.stats.systemGroup"),
      icon: <Cpu className="w-4 h-4 text-purple-400" />,
      stats: [
        { label: t("pages:admin.stats.projects"), value: data.projects.total },
        { label: t("pages:admin.stats.uptime"), value: formatUptime(data.uptime) },
        { label: t("pages:admin.stats.memoryRss"), value: `${data.memory.rss} MB` },
        { label: t("pages:admin.stats.heapUsed"), value: `${data.memory.heap} MB` },
      ],
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4">
      {statGroups.map((group) => (
        <div key={group.title} className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            {group.icon}
            <h3 className="text-sm font-semibold text-neutral-200">{group.title}</h3>
          </div>
          <div className="space-y-3">
            {group.stats.map((stat) => (
              <div key={stat.label} className="flex items-center justify-between">
                <span className="text-xs text-neutral-500">{stat.label}</span>
                <span className="text-sm font-semibold text-neutral-200 tabular-nums">{stat.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── FEATURE FLAGS TAB ────────────────────────────────────────────────

function FeatureFlagsTab() {
  const { t } = useTranslation("pages");
  const { data: flags, isLoading, error } = trpc.admin.listFeatureFlags.useQuery();
  const utils = trpc.useUtils();

  const toggleFlag = trpc.admin.toggleFeatureFlag.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.flags.updated"));
      utils.admin.listFeatureFlags.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
        <p className="font-medium">{t("pages:admin.flags.loadFailed")}</p>
        <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
      </div>
    );
  }

  if (!flags || flags.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-neutral-600">
        <ToggleLeft className="w-10 h-10 mb-3" />
        <p className="text-sm">{t("pages:admin.flags.empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {flags.map((flag) => (
        <div
          key={flag.id}
          className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex items-center gap-4"
        >
          {/* Toggle */}
          <button
            onClick={() => toggleFlag.mutate({ key: flag.key, enabled: !flag.enabled })}
            disabled={toggleFlag.isPending}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
              flag.enabled ? "bg-blue-600" : "bg-neutral-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                flag.enabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-neutral-200">{flag.name}</span>
              <span className="text-[10px] font-mono text-neutral-600 bg-neutral-800 px-1.5 py-0.5 rounded">
                {flag.key}
              </span>
            </div>
            {flag.description && (
              <p className="text-xs text-neutral-500 mt-0.5 truncate">{flag.description}</p>
            )}
            <div className="flex items-center gap-3 mt-1">
              {flag.rolloutPercent !== null && flag.rolloutPercent !== undefined && (
                <span className="text-[10px] text-neutral-600">
                  {t("pages:admin.flags.rollout")} {flag.rolloutPercent}%
                </span>
              )}
              {flag.pluginId && (
                <span className="text-[10px] text-neutral-600">
                  {t("pages:admin.flags.plugin")} {flag.pluginId}
                </span>
              )}
              {flag.allowedUserIds && flag.allowedUserIds.length > 0 && (
                <span className="text-[10px] text-neutral-600">
                  {flag.allowedUserIds.length} {t("pages:admin.flags.betaUsers")}
                </span>
              )}
            </div>
          </div>

          {/* Status indicator */}
          <div className="shrink-0">
            {flag.enabled ? (
              <CheckCircle className="w-4 h-4 text-emerald-400" />
            ) : (
              <XCircle className="w-4 h-4 text-neutral-600" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── CERTIFICATION QUEUE TAB ──────────────────────────────────────────
// Trust Phase 0 ops view: listings by stage with last-activity age and
// blind-pool progress, plus a requeue action for stuck states.
function certStageColor(status: string) {
  switch (status) {
    case "generating":     return "bg-amber-500/15 text-amber-400 border-amber-500/20";
    case "pending_review": return "bg-blue-500/15 text-blue-400 border-blue-500/20";
    case "reviewing":      return "bg-blue-500/15 text-blue-400 border-blue-500/20";
    case "certifying":     return "bg-purple-500/15 text-purple-400 border-purple-500/20";
    case "rejected":       return "bg-red-500/15 text-red-400 border-red-500/20";
    case "published":      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/20";
    default:               return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
  }
}

function CertificationTab() {
  const { t } = useTranslation("pages");
  const { data: queue, isLoading, error } = trpc.admin.certificationQueue.useQuery();
  const utils = trpc.useUtils();

  const requeue = trpc.admin.requeueCertification.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.certification.requeued"));
      utils.admin.certificationQueue.invalidate();
    },
    onError: (err) => toast.error(t("pages:admin.certification.requeueFailed", { error: err.message })),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
        <p className="font-medium">{t("pages:admin.certification.loadFailed")}</p>
        <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
      </div>
    );
  }

  if (!queue || queue.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-neutral-600">
        <Award className="w-10 h-10 mb-3" />
        <p className="text-sm">{t("pages:admin.certification.empty")}</p>
      </div>
    );
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-neutral-800 text-neutral-500">
            <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.certification.listing")}</th>
            <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.certification.creator")}</th>
            <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.certification.stage")}</th>
            <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.certification.lastActivity")}</th>
            <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.certification.aiGrade")}</th>
            <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.certification.reviews")}</th>
            <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.certification.grade")}</th>
            <th className="text-right px-4 py-2.5 font-medium">{t("pages:admin.certification.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {queue.map((row) => {
            const canRequeue = row.status === "generating" || (row.status === "certifying" && Number(row.poolTotal) === 0);
            return (
              <tr key={row.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30">
                <td className="px-4 py-2.5">
                  <span className="text-neutral-200 font-medium">#{row.id}</span>{" "}
                  <span className="text-neutral-400">{row.title}</span>
                </td>
                <td className="px-4 py-2.5 text-neutral-400">{row.creatorUsername ?? "—"}</td>
                <td className="px-4 py-2.5">
                  <Badge className={certStageColor(row.status ?? "")}>
                    {t(`pages:admin.certification.stages.${row.status ?? "unknown"}`)}
                  </Badge>
                  {row.stuck && (
                    <Badge className="bg-red-500/15 text-red-400 border-red-500/20 ml-1">
                      {t("pages:admin.certification.stuck")}
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2.5 text-neutral-400">{timeAgo(row.updatedAt ?? row.createdAt, t)}</td>
                <td className="px-4 py-2.5 text-neutral-400 tabular-nums">{row.aiGrade ?? "—"}</td>
                <td className="px-4 py-2.5 text-neutral-400 tabular-nums">
                  {Number(row.poolTotal) > 0 ? `${row.poolCompleted}/${row.poolTotal}` : (row.reviewCount ?? 0)}
                </td>
                <td className="px-4 py-2.5 text-neutral-400 tabular-nums">{row.grade ?? "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  {canRequeue && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={requeue.isPending}
                      onClick={() => requeue.mutate({ listingId: row.id })}
                      className="text-xs h-7"
                    >
                      {row.status === "generating"
                        ? t("pages:admin.certification.resetToDraft")
                        : t("pages:admin.certification.recreatePool")}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── AUDIT TAB ────────────────────────────────────────────────────────
function AuditTab() {
  const { t } = useTranslation("pages");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data, isLoading, error } = trpc.admin.listAdminAuditLog.useQuery({
    page,
    pageSize,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
        <p className="font-medium">{t("pages:admin.audit.loadFailed")}</p>
        <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-neutral-600">
        <ClipboardList className="w-10 h-10 mb-3" />
        <p className="text-sm">{t("pages:admin.audit.empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-neutral-800 text-neutral-500">
              <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.audit.time")}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.audit.admin")}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.audit.action")}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.audit.target")}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.audit.details")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30">
                <td className="px-4 py-2.5 text-neutral-400 whitespace-nowrap">
                  {row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-2.5 text-neutral-300 font-medium">
                  {row.adminUsername ?? `Admin #${row.adminUserId}`}
                </td>
                <td className="px-4 py-2.5">
                  <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/20">{row.action}</Badge>
                </td>
                <td className="px-4 py-2.5 text-neutral-400">
                  {row.targetType} #{row.targetId}
                </td>
                <td className="px-4 py-2.5 text-neutral-400">
                  <pre className="text-[10px] font-mono bg-neutral-800/40 rounded p-1.5 border border-neutral-800 overflow-x-auto max-w-xs">
                    {JSON.stringify(row.detail ?? {}, null, 2)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={data.page}
        pageSize={data.pageSize}
        total={data.total}
        onPageChange={setPage}
      />
    </div>
  );
}


// ─── BETA TAB (Pioneer 100 waitlist + vouchers) ───────────────────────
function BetaTab() {
  const { t } = useTranslation("pages");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const pageSize = 20;

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error } = trpc.admin.listWaitlist.useQuery({
    page,
    pageSize,
    search: debouncedSearch || undefined,
  });

  const utils = trpc.useUtils();

  const markInvited = trpc.admin.markWaitlistInvited.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.beta.invitedSuccess"));
      utils.admin.listWaitlist.invalidate();
    },
    onError: (err) => toast.error(t("pages:admin.beta.inviteFailed", { error: err.message })),
  });

  // Voucher state
  const [voucherTier, setVoucherTier] = useState<"pro_designer" | "pro_auto">("pro_designer");
  const [durationDays, setDurationDays] = useState(30);
  const [maxUses, setMaxUses] = useState(1);
  const [voucherLabel, setVoucherLabel] = useState("");

  const { data: vouchers } = trpc.voucher.list.useQuery();
  const generateVoucher = trpc.voucher.generate.useMutation({
    onSuccess: (res) => {
      toast.success(t("pages:admin.beta.generated", { code: res.code }));
      utils.voucher.list.invalidate();
    },
    onError: (err) => toast.error(t("pages:admin.beta.generateFailed", { error: err.message })),
  });

  return (
    <div className="space-y-6">
      {/* Waitlist section */}
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
          <Search className="w-4 h-4 text-neutral-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("pages:admin.beta.searchPlaceholder")}
            className="flex-1 bg-transparent text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none"
          />
          {data && (
            <span className="text-[11px] text-neutral-500">{data.total} {t("pages:admin.beta.countSuffix")}</span>
          )}
        </div>

        {isLoading && (
          <div className="flex justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
          </div>
        )}

        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
            <p className="font-medium">{t("pages:admin.beta.loadFailed")}</p>
            <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
          </div>
        )}

        {data && data.items.length > 0 && (
          <>
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-neutral-800 text-neutral-500">
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.beta.position")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.beta.email")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.beta.role")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.beta.referrals")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.beta.referredBy")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.beta.joined")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.beta.invited")}</th>
                    <th className="text-right px-4 py-2.5 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30">
                      <td className="px-4 py-2.5 text-neutral-200 font-medium">#{row.position}</td>
                      <td className="px-4 py-2.5 text-neutral-300">{row.email}</td>
                      <td className="px-4 py-2.5">
                        <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/20">{row.role}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-neutral-400 tabular-nums">{row.referralCount}</td>
                      <td className="px-4 py-2.5 text-neutral-400">{row.referredBy ?? "—"}</td>
                      <td className="px-4 py-2.5 text-neutral-400 whitespace-nowrap">
                        {row.createdAt ? new Date(row.createdAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.invitedAt ? (
                          <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/20">
                            {new Date(row.invitedAt).toLocaleDateString()}
                          </Badge>
                        ) : (
                          <Badge className="bg-neutral-500/15 text-neutral-400 border-neutral-500/20">—</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {!row.invitedAt && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={markInvited.isPending}
                            onClick={() => markInvited.mutate({ entryId: row.id })}
                            className="text-xs h-7"
                          >
                            {t("pages:admin.beta.markInvited")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={setPage}
            />
          </>
        )}

        {data && data.items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-600">
            <Rocket className="w-10 h-10 mb-3" />
            <p className="text-sm">{t("pages:admin.beta.empty")}</p>
          </div>
        )}
      </div>

      {/* Vouchers section */}
      <div className="border-t border-neutral-800 pt-6 space-y-4">
        <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.beta.vouchers")}</h3>
        <p className="text-[11px] text-amber-400/80">{t("pages:admin.beta.tierLegacy")}</p>

        {/* Generate form */}
        <div className="flex flex-wrap items-end gap-3 bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{t("pages:admin.beta.tier")}</span>
            <select
              value={voucherTier}
              onChange={(e) => setVoucherTier(e.target.value as "pro_designer" | "pro_auto")}
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 focus:outline-none focus:border-blue-500"
            >
              <option value="pro_designer">pro_designer</option>
              <option value="pro_auto">pro_auto</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{t("pages:admin.beta.durationDays")}</span>
            <input
              type="number"
              min={1}
              max={365}
              value={durationDays}
              onChange={(e) => setDurationDays(Number(e.target.value))}
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 w-20 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{t("pages:admin.beta.maxUses")}</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 w-20 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{t("pages:admin.beta.label")}</span>
            <input
              value={voucherLabel}
              onChange={(e) => setVoucherLabel(e.target.value)}
              placeholder="Optional"
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <Button
            size="sm"
            disabled={generateVoucher.isPending}
            onClick={() => generateVoucher.mutate({ tier: voucherTier, durationDays, maxUses, label: voucherLabel || undefined })}
            className="text-xs h-8"
          >
            {t("pages:admin.beta.generate")}
          </Button>
        </div>

        {/* Voucher list */}
        {vouchers && vouchers.length > 0 && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="text-left px-4 py-2.5 font-medium">Code</th>
                  <th className="text-left px-4 py-2.5 font-medium">Tier</th>
                  <th className="text-left px-4 py-2.5 font-medium">Duration</th>
                  <th className="text-left px-4 py-2.5 font-medium">Uses</th>
                  <th className="text-left px-4 py-2.5 font-medium">Label</th>
                  <th className="text-left px-4 py-2.5 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {vouchers.map((v) => (
                  <tr key={v.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30">
                    <td className="px-4 py-2.5 font-mono text-neutral-300">{v.code}</td>
                    <td className="px-4 py-2.5">
                      <Badge className="bg-purple-500/15 text-purple-400 border-purple-500/20">{v.tier}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{v.durationDays}d</td>
                    <td className="px-4 py-2.5 text-neutral-400">{v.usedCount}/{v.maxUses}</td>
                    <td className="px-4 py-2.5 text-neutral-400">{v.label ?? "—"}</td>
                    <td className="px-4 py-2.5 text-neutral-400">
                      {v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {vouchers && vouchers.length === 0 && (
          <p className="text-sm text-neutral-500">No vouchers yet.</p>
        )}
      </div>
    </div>
  );
}

// ═══ V2 OPERATIONS (spec D10) ════════════════════════════════════════
// Four screens for the operational metadata v2 created and nobody could
// reach: the approved endpoint list, the reviewed model catalog, evidence
// publications, and the spend ledger. Nothing here reads or writes a user's
// private work content, and no read on this screen mutates a row.

const EGRESS_POLICY_VERSION = "v2-egress-1";

/** Small form field so the four new sections stay as compact as the tabs
 *  above; the label markup is the one used everywhere else in this file. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-neutral-500 uppercase tracking-wide">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-neutral-600">{hint}</span>}
    </div>
  );
}

const inputClass =
  "bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-blue-500";

function endpointStateColor(row: { enabled: boolean; liveForGate: boolean }) {
  if (!row.enabled) return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
  if (row.liveForGate) return "bg-emerald-500/15 text-emerald-400 border-emerald-500/20";
  return "bg-amber-500/15 text-amber-400 border-amber-500/20";
}

// ─── TRUSTED PROVIDER ENDPOINTS TAB ───────────────────────────────────
// A protected buyer run may only reach a destination named here, and the
// disclosure columns are the point of the row, not decoration: the promise is
// that we name the destination AND record its logging posture before the run.
function EndpointsTab() {
  const { t } = useTranslation("pages");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [endpointClass, setEndpointClass] = useState<"first_party" | "approved_proxy">("first_party");
  const [loggingDisclosure, setLoggingDisclosure] = useState("");
  const [protectionClass, setProtectionClass] = useState<"" | "standard" | "reduced">("");
  const [policyVersion, setPolicyVersion] = useState(EGRESS_POLICY_VERSION);

  const { data, isLoading, error } = trpc.admin.listTrustedEndpoints.useQuery({ enabledOnly });
  const utils = trpc.useUtils();

  const approve = trpc.admin.approveTrustedEndpoint.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.endpoints.approved"));
      utils.admin.listTrustedEndpoints.invalidate();
      setBaseUrl("");
      setLoggingDisclosure("");
    },
    onError: (err) => toast.error(t("pages:admin.endpoints.approveFailed", { error: err.message })),
  });

  const setEnabled = trpc.admin.setTrustedEndpointEnabled.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.endpoints.stateUpdated"));
      utils.admin.listTrustedEndpoints.invalidate();
    },
    onError: (err) => toast.error(t("pages:admin.endpoints.stateFailed", { error: err.message })),
  });

  const canApprove = provider.trim().length > 0 && baseUrl.trim().length > 7
    && loggingDisclosure.trim().length >= 20 && protectionClass !== "" && policyVersion.trim().length > 0;

  return (
    <div className="space-y-5">
      <p className="text-[11px] text-neutral-500">{t("pages:admin.endpoints.intro")}</p>

      {/* Approval form — both disclosures are required, with no silent default
          for the protection class. */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.endpoints.approveTitle")}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("pages:admin.endpoints.fields.provider")} hint={t("pages:admin.endpoints.providerHint")}>
            <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="openai" className={`${inputClass} w-32`} />
          </Field>
          <Field label={t("pages:admin.endpoints.fields.baseUrl")} hint={t("pages:admin.endpoints.baseUrlHint")}>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className={`${inputClass} w-72`} />
          </Field>
          <Field label={t("pages:admin.endpoints.fields.endpointClass")}>
            <select value={endpointClass} onChange={(e) => setEndpointClass(e.target.value as "first_party" | "approved_proxy")} className={inputClass}>
              <option value="first_party">first_party</option>
              <option value="approved_proxy">approved_proxy</option>
            </select>
          </Field>
          <Field label={t("pages:admin.endpoints.fields.protectionClass")} hint={t("pages:admin.endpoints.protectionHint")}>
            <select value={protectionClass} onChange={(e) => setProtectionClass(e.target.value as "" | "standard" | "reduced")} className={inputClass}>
              <option value="">—</option>
              <option value="standard">standard</option>
              <option value="reduced">reduced</option>
            </select>
          </Field>
          <Field label={t("pages:admin.endpoints.fields.policyVersion")}>
            <input value={policyVersion} onChange={(e) => setPolicyVersion(e.target.value)} className={`${inputClass} w-32`} />
          </Field>
        </div>
        <Field label={t("pages:admin.endpoints.fields.loggingDisclosure")} hint={t("pages:admin.endpoints.disclosureHint")}>
          <textarea
            value={loggingDisclosure}
            onChange={(e) => setLoggingDisclosure(e.target.value)}
            rows={2}
            placeholder={t("pages:admin.endpoints.disclosurePlaceholder")}
            className={`${inputClass} w-full resize-y`}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={!canApprove || approve.isPending}
            onClick={() => protectionClass && approve.mutate({
              provider: provider.trim(),
              baseUrl: baseUrl.trim(),
              endpointClass,
              loggingDisclosure: loggingDisclosure.trim(),
              protectionClass,
              policyVersion: policyVersion.trim(),
            })}
            className="text-xs h-8"
          >
            {approve.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            {t("pages:admin.endpoints.approve")}
          </Button>
          {!canApprove && (
            <span className="text-[10px] text-neutral-600">{t("pages:admin.endpoints.needBothDisclosures")}</span>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setEnabledOnly((v) => !v)}
          className={`text-[11px] px-2 py-1 rounded border transition-colors ${
            enabledOnly
              ? "border-blue-500/40 bg-blue-500/10 text-blue-400"
              : "border-neutral-700 text-neutral-500 hover:text-neutral-200"
          }`}
        >
          {t("pages:admin.endpoints.enabledOnly")}
        </button>
        {data && (
          <span className="text-[11px] text-neutral-500">
            {data.length} {t("pages:admin.endpoints.countSuffix")}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="font-medium">{t("pages:admin.endpoints.loadFailed")}</p>
          <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
        </div>
      )}

      {data && data.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-600 gap-2">
          <Server className="w-10 h-10" />
          <p className="text-sm">{t("pages:admin.endpoints.empty")}</p>
          <p className="text-xs text-neutral-700 max-w-md text-center">{t("pages:admin.endpoints.emptyWhy")}</p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="space-y-2">
          {data.map((row) => (
            <div key={row.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-neutral-200">{row.provider}</span>
                <span className="text-xs font-mono text-neutral-400 break-all">{row.baseUrl}</span>
                <Badge className="bg-neutral-500/15 text-neutral-400 border-neutral-500/20">{row.adapterKind}</Badge>
                <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/20">{row.endpointClass}</Badge>
                <Badge className={row.protectionClass === "reduced"
                  ? "bg-red-500/15 text-red-400 border-red-500/20"
                  : "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"}>
                  {row.protectionClass}
                </Badge>
                <Badge className={endpointStateColor(row)}>
                  {row.enabled
                    ? (row.liveForGate ? t("pages:admin.endpoints.reachable") : t("pages:admin.endpoints.enabledNotMatching"))
                    : t("pages:admin.endpoints.disabled")}
                </Badge>
                <div className="ml-auto">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    disabled={setEnabled.isPending}
                    onClick={() => setEnabled.mutate({ endpointId: row.id, enabled: !row.enabled })}
                  >
                    {row.enabled ? t("pages:admin.endpoints.disable") : t("pages:admin.endpoints.enable")}
                  </Button>
                </div>
              </div>

              {/* The disclosure a buyer's run is made under. */}
              <p className="text-xs text-neutral-300 bg-neutral-800/40 border border-neutral-800 rounded-lg p-2.5">
                {row.loggingDisclosure}
              </p>

              {row.matchKey && (
                <p className="text-[10px] font-mono text-neutral-600 break-all">
                  {t("pages:admin.endpoints.matchKey")} {row.matchKey}
                </p>
              )}
              {row.urlUnusable && (
                <p className="text-[10px] text-amber-400">
                  {t("pages:admin.endpoints.urlUnusable", { error: row.urlUnusable })}
                </p>
              )}
              {!row.adapterMatchesProvider && !row.urlUnusable && (
                <p className="text-[10px] text-amber-400">
                  {t("pages:admin.endpoints.adapterMismatch", { expected: row.expectedAdapterKind })}
                </p>
              )}
              <div className="flex items-center gap-4 text-[10px] text-neutral-600">
                <span>{t("pages:admin.endpoints.policy")} {row.policyVersion}</span>
                <span>{t("pages:admin.endpoints.approvedBy")} {row.approvedByUsername ?? `#${row.approvedBy ?? "?"}`}</span>
                <span>{t("pages:admin.meta.created")} {row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}</span>
                <span>{t("pages:admin.meta.id")} {row.id}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MODEL CATALOG TAB ────────────────────────────────────────────────
// Vendor (the model's developer) is the field a D12 refusal tells a user to
// ask for, so it is editable here. Entry writes still go through the reviewed
// path, which validates lineage and refreshes instead of duplicating.
function CatalogTab() {
  const { t } = useTranslation("pages");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [missingVendorOnly, setMissingVendorOnly] = useState(false);
  const [vendorDrafts, setVendorDrafts] = useState<Record<number, string>>({});
  const pageSize = 20;

  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [family, setFamily] = useState("");
  const [vendor, setVendor] = useState("");
  const [successorOfModelId, setSuccessorOfModelId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error } = trpc.admin.listModelCatalog.useQuery({
    page, pageSize, search: debouncedSearch || undefined, missingVendorOnly,
  });
  const { data: events } = trpc.admin.listModelReleaseEvents.useQuery({ page: 1, pageSize: 20 });

  const utils = trpc.useUtils();
  const invalidate = () => {
    utils.admin.listModelCatalog.invalidate();
    utils.admin.listModelReleaseEvents.invalidate();
  };

  const record = trpc.modelCatalog.recordModel.useMutation({
    onSuccess: (res) => {
      toast.success(t("pages:admin.catalog.recorded", { id: res.catalogId }));
      invalidate();
      setModelId("");
      setVendor("");
      setSuccessorOfModelId("");
    },
    onError: (err) => toast.error(t("pages:admin.catalog.recordFailed", { error: err.message })),
  });

  const setVendorOnModel = trpc.admin.setModelVendor.useMutation({
    onSuccess: (res) => {
      toast.success(t("pages:admin.catalog.vendorSaved", { vendor: res.vendor ?? t("pages:admin.catalog.unknown") }));
      invalidate();
    },
    onError: (err) => toast.error(t("pages:admin.catalog.vendorFailed", { error: err.message })),
  });

  return (
    <div className="space-y-5">
      <p className="text-[11px] text-neutral-500">{t("pages:admin.catalog.intro")}</p>

      {/* Record / refresh one reviewed entry */}
      <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.catalog.recordTitle")}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("pages:admin.catalog.fields.provider")}>
            <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="together" className={`${inputClass} w-32`} />
          </Field>
          <Field label={t("pages:admin.catalog.fields.modelId")} hint={t("pages:admin.catalog.modelIdHint")}>
            <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="deepseek-ai/DeepSeek-V3" className={`${inputClass} w-60`} />
          </Field>
          <Field label={t("pages:admin.catalog.fields.vendor")} hint={t("pages:admin.catalog.vendorHint")}>
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="deepseek" className={`${inputClass} w-32`} />
          </Field>
          <Field label={t("pages:admin.catalog.fields.family")}>
            <input value={family} onChange={(e) => setFamily(e.target.value)} className={`${inputClass} w-32`} />
          </Field>
          <Field label={t("pages:admin.catalog.fields.successorOf")} hint={t("pages:admin.catalog.successorHint")}>
            <input value={successorOfModelId} onChange={(e) => setSuccessorOfModelId(e.target.value)} className={`${inputClass} w-56`} />
          </Field>
          <Field label={t("pages:admin.catalog.fields.sourceUrl")}>
            <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} className={`${inputClass} w-56`} />
          </Field>
          <Button
            size="sm"
            className="text-xs h-8"
            disabled={!provider.trim() || !modelId.trim() || record.isPending}
            onClick={() => record.mutate({
              provider: provider.trim(),
              modelId: modelId.trim(),
              family: family.trim() || undefined,
              vendor: vendor.trim() || undefined,
              successorOfModelId: successorOfModelId.trim() || undefined,
              sourceUrl: sourceUrl.trim() || undefined,
            })}
          >
            {record.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            {t("pages:admin.catalog.record")}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
        <Search className="w-4 h-4 text-neutral-500" />
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder={t("pages:admin.catalog.searchPlaceholder")}
          className="flex-1 bg-transparent text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none"
        />
        <button
          onClick={() => { setMissingVendorOnly((v) => !v); setPage(1); }}
          className={`text-[11px] px-2 py-1 rounded border transition-colors ${
            missingVendorOnly
              ? "border-blue-500/40 bg-blue-500/10 text-blue-400"
              : "border-neutral-700 text-neutral-500 hover:text-neutral-200"
          }`}
        >
          {t("pages:admin.catalog.missingVendorOnly")}
        </button>
        {data && (
          <span className="text-[11px] text-neutral-500">
            {data.total} {t("pages:admin.catalog.countSuffix")}
            {" · "}
            {t("pages:admin.catalog.vendorMissing", { n: data.vendorMissingTotal })}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="font-medium">{t("pages:admin.catalog.loadFailed")}</p>
          <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-600 gap-2">
          <Boxes className="w-10 h-10" />
          <p className="text-sm">{t("pages:admin.catalog.empty")}</p>
          <p className="text-xs text-neutral-700 max-w-md text-center">{t("pages:admin.catalog.emptyWhy")}</p>
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.model")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.vendor")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.family")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.lineage")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.source")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.events")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.verified")}</th>
                  <th className="text-right px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => {
                  const draft = vendorDrafts[row.id] ?? row.vendor ?? "";
                  const dirty = draft.trim().toLowerCase() !== (row.vendor ?? "").trim().toLowerCase();
                  return (
                    <tr key={row.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30">
                      <td className="px-4 py-2.5">
                        <p className="text-neutral-200 font-medium break-all">{row.modelId}</p>
                        <p className="text-[10px] text-neutral-600">{row.provider}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        {row.vendor
                          ? <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/20">{row.vendor}</Badge>
                          : <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/20">{t("pages:admin.catalog.unknown")}</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-400">{row.family ?? "—"}</td>
                      <td className="px-4 py-2.5 text-neutral-400 break-all">{row.successorOfModelId ?? "—"}</td>
                      <td className="px-4 py-2.5 text-neutral-400">{row.availabilitySource}</td>
                      <td className="px-4 py-2.5 text-neutral-400 tabular-nums">{Number(row.releaseEventCount)}</td>
                      <td className="px-4 py-2.5 text-neutral-500 whitespace-nowrap">
                        {row.verifiedAt ? new Date(row.verifiedAt).toLocaleDateString() : "—"}
                        {row.deprecatedAt && (
                          <Badge className="bg-red-500/15 text-red-400 border-red-500/20 ml-1">{t("pages:admin.catalog.deprecated")}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2 justify-end">
                          <input
                            value={draft}
                            onChange={(e) => setVendorDrafts((d) => ({ ...d, [row.id]: e.target.value }))}
                            placeholder={t("pages:admin.catalog.vendorPlaceholder")}
                            className={`${inputClass} w-28`}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-[10px] h-6 px-2"
                            disabled={!dirty || setVendorOnModel.isPending}
                            onClick={() => setVendorOnModel.mutate({ catalogId: row.id, vendor: draft.trim() || null })}
                          >
                            {t("pages:admin.catalog.saveVendor")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}

      {/* Release events: what has been reviewed as a release, and on which rule */}
      <div className="border-t border-neutral-800 pt-5 space-y-3">
        <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.catalog.eventsTitle")}</h3>
        <p className="text-[11px] text-neutral-500">{t("pages:admin.catalog.eventsNote")}</p>
        {!events || events.items.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("pages:admin.catalog.eventsEmpty")}</p>
        ) : (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.eventKey")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.model")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.rule")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.recordedBy")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.catalog.headers.date")}</th>
                </tr>
              </thead>
              <tbody>
                {events.items.map((e) => (
                  <tr key={e.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30">
                    <td className="px-4 py-2.5 font-mono text-neutral-300 break-all">{e.eventKey}</td>
                    <td className="px-4 py-2.5 text-neutral-300 break-all">
                      {e.modelId} <span className="text-neutral-600">({e.provider}{e.vendor ? ` · ${e.vendor}` : ""})</span>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{e.relevanceRule ?? "—"}</td>
                    <td className="px-4 py-2.5 text-neutral-400">{e.recordedByUsername ?? "—"}</td>
                    <td className="px-4 py-2.5 text-neutral-400 whitespace-nowrap">
                      {e.createdAt ? new Date(e.createdAt).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── EVIDENCE PUBLICATIONS TAB (read-only) ────────────────────────────
function pubStateColor(state: string) {
  switch (state) {
    case "published": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/20";
    case "withdrawn": return "bg-red-500/15 text-red-400 border-red-500/20";
    default:          return "bg-neutral-500/15 text-neutral-400 border-neutral-500/20";
  }
}

function EvidenceTab() {
  const { t } = useTranslation("pages");
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState("__all__");
  const [state, setState] = useState("__all__");
  const [listingId, setListingId] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const pageSize = 20;

  const { data, isLoading, error } = trpc.admin.listEvidencePublications.useQuery({
    page, pageSize,
    publicationKind: kind !== "__all__" ? (kind as "seller" | "community") : undefined,
    state: state !== "__all__" ? (state as "draft_preview" | "published" | "withdrawn") : undefined,
    listingId: listingId.trim() ? Number(listingId.trim()) : undefined,
  });
  const { data: detail } = trpc.admin.evidencePublicationDetail.useQuery(
    { publicationId: openId ?? 0 },
    { enabled: openId !== null },
  );

  const handleFilter = (setter: (v: string) => void) => (v: string) => { setter(v); setPage(1); };

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-neutral-500">{t("pages:admin.evidence.intro")}</p>

      <div className="flex flex-wrap items-end gap-3 bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
        <FilterSelect
          label={t("pages:admin.evidence.kind")}
          value={kind}
          onChange={handleFilter(setKind)}
          options={[
            { value: "seller", label: "seller" },
            { value: "community", label: "community" },
          ]}
        />
        <FilterSelect
          label={t("pages:admin.evidence.state")}
          value={state}
          onChange={handleFilter(setState)}
          options={[
            { value: "draft_preview", label: "draft_preview" },
            { value: "published", label: "published" },
            { value: "withdrawn", label: "withdrawn" },
          ]}
        />
        <Field label={t("pages:admin.evidence.listingId")}>
          <input
            value={listingId}
            onChange={(e) => { setListingId(e.target.value.replace(/[^0-9]/g, "")); setPage(1); }}
            className={`${inputClass} w-28`}
          />
        </Field>
        {data && (
          <span className="ml-auto text-[11px] text-neutral-500 self-end pb-1">
            {data.total} {t("pages:admin.evidence.countSuffix")}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="font-medium">{t("pages:admin.evidence.loadFailed")}</p>
          <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-600 gap-2">
          <FileSearch className="w-10 h-10" />
          <p className="text-sm">{t("pages:admin.evidence.empty")}</p>
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.evidence.headers.publication")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.evidence.headers.state")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.evidence.headers.kind")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.evidence.headers.target")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.evidence.headers.author")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.evidence.headers.testedAt")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.evidence.headers.hash")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenId(openId === row.id ? null : row.id)}
                    className={`border-b border-neutral-800/60 last:border-0 cursor-pointer hover:bg-neutral-800/30 ${
                      openId === row.id ? "bg-neutral-800/40" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <span className="text-neutral-200 font-medium">#{row.id}</span>
                      {row.supersedesPublicationId && (
                        <span className="text-[10px] text-neutral-600 ml-1">
                          {t("pages:admin.evidence.supersedes", { id: row.supersedesPublicationId })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge className={pubStateColor(row.state)}>{row.state.replace("_", " ")}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{row.publicationKind}</td>
                    <td className="px-4 py-2.5 text-neutral-400 whitespace-nowrap">
                      {row.listingId ? `${t("pages:admin.evidence.listing")} #${row.listingId}` : "—"}
                      {row.listingWorkflowVersionId && (
                        <span className="text-[10px] text-neutral-600"> v#{row.listingWorkflowVersionId}</span>
                      )}
                      {row.benchmarkId && (
                        <span className="text-[10px] text-neutral-600"> b#{row.benchmarkId}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{row.authorUsername ?? `#${row.authorId}`}</td>
                    <td className="px-4 py-2.5 text-neutral-400 whitespace-nowrap">
                      {row.testedAt ? new Date(row.testedAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-neutral-500">
                      {row.manifestHash.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}

      {/* Manifest drill-in — the stored bytes, plus their identity */}
      {openId !== null && (
        <div className="bg-neutral-900 border border-blue-500/25 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-neutral-200">
              {t("pages:admin.evidence.manifestFor", { id: openId })}
            </h3>
            {detail && (
              <>
                <Badge className={pubStateColor(detail.publication.state)}>{detail.publication.state.replace("_", " ")}</Badge>
                <Badge className="bg-neutral-500/15 text-neutral-400 border-neutral-500/20">{detail.publication.provenance}</Badge>
                <span className="text-[10px] font-mono text-neutral-600 ml-auto">{detail.publication.manifestHash}</span>
              </>
            )}
            <button className="text-neutral-500 hover:text-neutral-200" onClick={() => setOpenId(null)}>
              <XCircle className="w-4 h-4" />
            </button>
          </div>
          {detail && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-neutral-500">
              <span>{t("pages:admin.evidence.consentVersion")} {detail.publication.consentVersion}</span>
              <span>{t("pages:admin.evidence.schemaVersion")} v{detail.publication.schemaVersion}</span>
              <span>{t("pages:admin.evidence.publishedAt")} {detail.publication.publishedAt ? new Date(detail.publication.publishedAt).toLocaleString() : "—"}</span>
              {detail.publication.withdrawnAt && (
                <span className="text-red-400">
                  {t("pages:admin.evidence.withdrawnAt")} {new Date(detail.publication.withdrawnAt).toLocaleString()}
                  {detail.publication.withdrawalReason ? ` — ${detail.publication.withdrawalReason}` : ""}
                </span>
              )}
            </div>
          )}
          {detail?.manifestError && (
            <p className="text-xs text-amber-400">{t("pages:admin.evidence.manifestUnparsable", { error: detail.manifestError })}</p>
          )}
          {detail?.manifest ? (
            <pre className="text-[10px] font-mono bg-neutral-950 border border-neutral-800 rounded-lg p-3 max-h-96 overflow-auto text-neutral-400 leading-relaxed">
              {JSON.stringify(detail.manifest, null, 2)}
            </pre>
          ) : null}
          <p className="text-[10px] text-neutral-600">{t("pages:admin.evidence.withdrawIsTheirs")}</p>
        </div>
      )}
    </div>
  );
}

// ─── SPEND TAB ────────────────────────────────────────────────────────
/** The one rendering rule that matters: an unknown cost is not zero. A
 *  partially-priced set shows as a FLOOR plus how many operations still have
 *  no price; a set with nothing priced at all shows no dollar figure whatsoever
 *  — "≥ $0.00" is still a dollar figure a reader can mistake for a bill.
 *  The canonical sentence from `costDisclosure()` rides along as the title. */
function MoneyFigure({ cost }: {
  cost: {
    knownUsd: string | null;
    pricedSoFarUsd: string | null;
    unpricedOperations: number;
    display: string;
  };
}) {
  const { t } = useTranslation("pages");
  if (cost.knownUsd !== null) {
    return (
      <span className="text-neutral-100 font-semibold tabular-nums" title={cost.display}>
        ${cost.knownUsd}
      </span>
    );
  }
  if (cost.unpricedOperations > 0) {
    const hasFloor = cost.pricedSoFarUsd !== null && Number(cost.pricedSoFarUsd) > 0;
    return (
      <span className="flex items-center gap-1.5 justify-end" title={cost.display}>
        {hasFloor && <span className="text-amber-300 font-semibold tabular-nums">≥ ${cost.pricedSoFarUsd}</span>}
        <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/20">
          {hasFloor
            ? t("pages:admin.spend.unpriced", { n: cost.unpricedOperations })
            : `${t("pages:admin.spend.unknown")} · ${t("pages:admin.spend.unpriced", { n: cost.unpricedOperations })}`}
        </Badge>
      </span>
    );
  }
  return (
    <span title={cost.display}>
      <Badge className="bg-neutral-500/15 text-neutral-400 border-neutral-500/20">{t("pages:admin.spend.unknown")}</Badge>
    </span>
  );
}

function SpendTab() {
  const { t } = useTranslation("pages");
  const [page, setPage] = useState(1);
  const [approvalStatus, setApprovalStatus] = useState("__all__");
  const pageSize = 10;

  const { data, isLoading, error } = trpc.admin.spendSummary.useQuery({ page, pageSize });
  const { data: approvals } = trpc.admin.listSpendApprovals.useQuery({
    page: 1, pageSize: 20,
    status: approvalStatus !== "__all__"
      ? (approvalStatus as "active" | "consumed" | "expired" | "revoked")
      : undefined,
  });

  return (
    <div className="space-y-6">
      <p className="text-[11px] text-neutral-500">{t("pages:admin.spend.intro")}</p>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="font-medium">{t("pages:admin.spend.loadFailed")}</p>
          <p className="text-xs text-red-400/70 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          {/* Per-benchmark ledger */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.spend.perBenchmark")}</h3>
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-neutral-800 text-neutral-500">
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.benchmark")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.owner")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.purpose")}</th>
                    <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.state")}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.operations")}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.uncertain")}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.benchmarks.map((b) => (
                    <tr key={b.benchmarkId} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30 align-top">
                      <td className="px-4 py-2.5 text-neutral-200 font-medium">
                        #{b.benchmarkId}
                        {b.listingId && <span className="text-[10px] text-neutral-600"> l#{b.listingId}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-400">{b.ownerUsername ?? `#${b.ownerId}`}</td>
                      <td className="px-4 py-2.5 text-neutral-400">{b.purpose ?? "—"}</td>
                      <td className="px-4 py-2.5 text-neutral-400">{b.state}</td>
                      <td className="px-4 py-2.5 text-right text-neutral-400 tabular-nums">
                        {b.totals.totalCalls}
                        <span className="text-[10px] text-neutral-600">
                          {" "}{t("pages:admin.spend.pricedOf", { priced: b.totals.pricedOperations })}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-neutral-400 tabular-nums">{b.totals.uncertainCalls}</td>
                      <td className="px-4 py-2.5 text-right"><MoneyFigure cost={b.cost} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </section>

          {/* Per-account */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.spend.perAccount")}</h3>
            {data.byPayer.length === 0 ? (
              <p className="text-sm text-neutral-500">{t("pages:admin.spend.noAttempts")}</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {data.byPayer.map((a) => (
                  <div key={String(a.payerId)} className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-neutral-200 truncate">
                        {a.username ?? a.displayName ?? `payer #${a.payerId}`}
                      </span>
                      <MoneyFigure cost={a.cost} />
                    </div>
                    <p className="text-[10px] text-neutral-500 tabular-nums">
                      {t("pages:admin.spend.operations", { n: a.totalCalls })}
                      {a.uncertainCalls > 0 && ` · ${t("pages:admin.spend.uncertain", { n: a.uncertainCalls })}`}
                      {a.pricingBases.length > 0 && ` · ${a.pricingBases.join(" + ")}`}
                    </p>
                    <p className="text-[10px] text-neutral-600 leading-relaxed">{a.cost.display}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Per purpose + the rows no benchmark owns */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.spend.perPurpose")}</h3>
            <div className="flex flex-wrap gap-2">
              {data.byPurpose.map((p) => (
                <div key={String(p.purpose)} className="bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 min-w-[180px]">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wide">{p.purpose}</p>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[10px] text-neutral-500 tabular-nums">{t("pages:admin.spend.operations", { n: p.totalCalls })}</span>
                    <MoneyFigure cost={p.cost} />
                  </div>
                </div>
              ))}
              {data.unattached.map((u) => (
                <div key="unattached" className="bg-neutral-900 border border-amber-500/25 rounded-xl px-4 py-3 min-w-[180px]">
                  <p className="text-[10px] text-amber-400 uppercase tracking-wide">{t("pages:admin.spend.unattached")}</p>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[10px] text-neutral-500 tabular-nums">{t("pages:admin.spend.operations", { n: u.totalCalls })}</span>
                    <MoneyFigure cost={u.cost} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Frozen call plans */}
      <section className="space-y-3 border-t border-neutral-800 pt-5">
        <div className="flex items-end gap-3">
          <h3 className="text-sm font-semibold text-neutral-200">{t("pages:admin.spend.approvals")}</h3>
          <FilterSelect
            label={t("pages:admin.spend.headers.state")}
            value={approvalStatus}
            onChange={(v) => setApprovalStatus(v)}
            options={[
              { value: "active", label: "active" },
              { value: "consumed", label: "consumed" },
              { value: "expired", label: "expired" },
              { value: "revoked", label: "revoked" },
            ]}
          />
        </div>
        {!approvals || approvals.items.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("pages:admin.spend.noApprovals")}</p>
        ) : (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-neutral-500">
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.approval")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.payer")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.purpose")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.state")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.ceiling")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.approvedAt")}</th>
                  <th className="text-left px-4 py-2.5 font-medium">{t("pages:admin.spend.headers.planHash")}</th>
                </tr>
              </thead>
              <tbody>
                {approvals.items.map((a) => (
                  <tr key={a.id} className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/30">
                    <td className="px-4 py-2.5 text-neutral-200 font-medium">
                      #{a.id}
                      <span className="text-[10px] text-neutral-600 ml-1">{t("pages:admin.spend.benchmarksUsed", { n: Number(a.benchmarkCount) })}</span>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">
                      {a.payerUsername ?? `#${a.payerId}`}
                      <span className="text-[10px] text-neutral-600"> · {a.actorUsername ?? `#${a.actorId}`}</span>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{a.purpose}</td>
                    <td className="px-4 py-2.5">
                      <Badge className={a.status === "active"
                        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
                        : a.status === "revoked"
                          ? "bg-red-500/15 text-red-400 border-red-500/20"
                          : "bg-neutral-500/15 text-neutral-400 border-neutral-500/20"}>
                        {a.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400 tabular-nums">
                      {a.spendCeilingUsd ? `$${a.spendCeilingUsd}` : t("pages:admin.spend.noCeiling")}
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400 whitespace-nowrap">
                      {a.approvedAt ? new Date(a.approvedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-neutral-500">{a.planHash.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-neutral-600">{t("pages:admin.spend.readOnlyNote")}</p>
      </section>
    </div>
  );
}
