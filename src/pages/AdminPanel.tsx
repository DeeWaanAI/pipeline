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
type UserTier = "standard" | "pro_designer" | "pro_auto";

type TabKey = "feedback" | "users" | "stats" | "flags" | "certification" | "audit" | "beta";

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
          <div className="flex gap-1">
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
  const setTier = trpc.admin.setUserTier.useMutation({
    onSuccess: () => {
      toast.success(t("pages:admin.users.tierUpdated"));
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
                  <th className="text-left px-4 py-3 font-medium">{t("pages:admin.users.headers.tier")}</th>
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
                    <td className="px-4 py-3">
                      <select
                        value={u.tier}
                        onChange={(e) => setTier.mutate({ userId: u.id, tier: e.target.value as UserTier })}
                        className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 focus:outline-none focus:border-blue-500"
                      >
                        <option value="standard">standard</option>
                        <option value="pro_designer">pro_designer</option>
                        <option value="pro_auto">pro_auto</option>
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

  const tierData = data.users.byTier as Record<string, number> | null;

  const statGroups = [
    {
      title: t("pages:admin.stats.usersGroup"),
      icon: <Users className="w-4 h-4 text-blue-400" />,
      stats: [
        { label: t("pages:admin.stats.totalUsers"), value: data.users.total },
        { label: t("pages:admin.stats.active7d"), value: data.users.active7d },
        { label: t("pages:admin.stats.standardTier"), value: tierData?.standard ?? 0 },
        { label: t("pages:admin.stats.proDesigner"), value: tierData?.pro_designer ?? 0 },
        { label: t("pages:admin.stats.proAuto"), value: tierData?.pro_auto ?? 0 },
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
