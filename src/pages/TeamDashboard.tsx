/**
 * Team Dashboard
 * Main hub for beta testing management.
 * Shows: feedback feed, engagement metrics, team members.
 */

import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/layout/AppShell";
import {
  Users, MessageSquare, CheckCircle,
  Plus, ChevronRight, FolderOpen, Share2,
  Loader2, Workflow, Bot, Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

export default function TeamDashboard() {
  const { t } = useTranslation("pages");
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<"overview" | "space" | "feedback" | "members">("overview");
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);

  const utils = trpc.useUtils();
  const { data: myTeams, isLoading: teamsLoading } = trpc.team.listMyTeams.useQuery();
  const { data: teamDetail } = trpc.team.getTeam.useQuery(
    { teamId: selectedTeamId! },
    { enabled: !!selectedTeamId },
  );
  const { data: feedbackStats } = trpc.feedback.stats.useQuery(
    { teamId: selectedTeamId! },
    { enabled: !!selectedTeamId },
  );

  const createTeam = trpc.team.create.useMutation({
    onSuccess: (result) => {
      toast.success(t("pages:team.toasts.created", { name: result.name }));
      setShowCreateTeam(false);
      setTeamName("");
      utils.team.listMyTeams.invalidate();
      setSelectedTeamId(result.id);
    },
  });

  const joinTeam = trpc.team.joinByCode.useMutation({
    onSuccess: (result) => {
      toast.success(t("pages:team.toasts.joined", { name: result.name }));
      setInviteCode("");
      utils.team.listMyTeams.invalidate();
    },
  });

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen bg-neutral-950 text-neutral-400">
        {t("pages:team.loginRequired")}
      </div>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full text-neutral-200">
        {/* Sidebar */}
        <div className="w-64 shrink-0 border-r border-neutral-800 bg-neutral-900/50 p-4 overflow-y-auto">
          {/* Join by code */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 mb-4">
            <p className="text-[11px] text-neutral-500 mb-1.5 uppercase tracking-wide">{t("pages:team.joinTeam")}</p>
            <div className="flex gap-1.5">
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder={t("pages:team.inviteCodePlaceholder")}
                className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
              />
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-500 text-xs h-7 px-2"
                onClick={() => inviteCode && joinTeam.mutate({ inviteCode })}
                disabled={joinTeam.isPending || !inviteCode}
              >
                {joinTeam.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t("pages:team.joinButton")}
              </Button>
            </div>
          </div>

          {/* Team list */}
          <p className="text-[11px] text-neutral-500 mb-1.5 uppercase tracking-wide px-1">{t("pages:team.yourTeams")}</p>
          {teamsLoading ? (
            <Loader2 className="w-4 h-4 animate-spin text-neutral-500 mx-auto" />
          ) : !myTeams || myTeams.length === 0 ? (
            <p className="text-xs text-neutral-600 px-1">{t("pages:team.noTeams")}</p>
          ) : (
            <div className="space-y-1">
              {myTeams.map((team) => (
                <button
                  key={team.id}
                  onClick={() => setSelectedTeamId(team.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                    selectedTeamId === team.id
                      ? "bg-blue-500/10 border border-blue-500/30"
                      : "hover:bg-neutral-800 border border-transparent"
                  }`}
                >
                  <div className="w-7 h-7 rounded bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                    {team.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{team.name}</p>
                    <p className="text-[10px] text-neutral-500">
                      {team.memberCount} {t("pages:team.members")} · {team.myRole}
                    </p>
                  </div>
                  <ChevronRight className="w-3 h-3 text-neutral-600 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Main Content */}
        <div className="flex-1 min-w-0 p-6 overflow-y-auto">
          {/* Page Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Users className="w-5 h-5 text-blue-400" />
              <h1 className="text-lg font-semibold">{t("pages:team.title")}</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-neutral-700 hover:bg-neutral-800 text-xs"
                onClick={() => setShowCreateTeam(true)}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> {t("pages:team.createTeam")}
              </Button>
            </div>
          </div>

          {!selectedTeamId ? (
            <EmptyState
              onCreate={() => setShowCreateTeam(true)}
              joinCode={inviteCode}
              setJoinCode={setInviteCode}
              onJoin={() => inviteCode && joinTeam.mutate({ inviteCode })}
              joining={joinTeam.isPending}
            />
          ) : !teamDetail ? (
            <Loader2 className="w-5 h-5 animate-spin text-neutral-500 mx-auto mt-20" />
          ) : (
            <>
              {/* Team Header */}
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-semibold">{teamDetail.team.name}</h2>
                  <p className="text-sm text-neutral-500">
                    {teamDetail.members.length} {t("pages:team.members")} · {t("pages:team.yourRole")} {teamDetail.myRole}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500 bg-neutral-800 px-2 py-1 rounded">
                    {t("pages:team.invite")} {teamDetail.team.inviteCode}
                  </span>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 mb-6 border-b border-neutral-800">
                {(["overview", "space", "feedback", "members"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-xs font-medium capitalize transition-colors border-b-2 ${
                      activeTab === tab
                        ? "border-blue-500 text-blue-400"
                        : "border-transparent text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    {tab === "space" ? t("pages:team.tabs.space") : tab}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              {activeTab === "overview" && (
                <OverviewTab
                  feedbackStats={feedbackStats}
                  memberCount={teamDetail.members.length}
                />
              )}
              {activeTab === "space" && (
                <TeamSpaceTab
                  teamId={selectedTeamId}
                  sharedProjects={teamDetail.sharedProjects}
                  myRole={teamDetail.myRole}
                />
              )}
              {activeTab === "feedback" && <FeedbackTab teamId={selectedTeamId} isAdmin={user?.role === "admin"} />}
              {activeTab === "members" && <MembersTab members={teamDetail.members} />}
            </>
          )}

          {/* Create Team Modal */}
          {showCreateTeam && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-6 w-96">
                <h3 className="text-sm font-semibold mb-4">{t("pages:team.createTeamHeading")}</h3>
                <input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder={t("pages:team.teamNamePlaceholder")}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:border-blue-500"
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1 border-neutral-700"
                    onClick={() => setShowCreateTeam(false)}
                  >
                    {t("pages:team.cancel")}
                  </Button>
                  <Button
                    className="flex-1 bg-blue-600 hover:bg-blue-500"
                    onClick={() => teamName && createTeam.mutate({ name: teamName })}
                    disabled={createTeam.isPending || !teamName}
                  >
                    {createTeam.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t("pages:team.create")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function EmptyState({ onCreate, joinCode, setJoinCode, onJoin, joining }: {
  onCreate: () => void;
  joinCode: string;
  setJoinCode: (v: string) => void;
  onJoin: () => void;
  joining: boolean;
}) {
  const { t } = useTranslation("pages");
  return (
    <div className="flex flex-col items-center justify-center py-20 text-neutral-500">
      <Users className="w-12 h-12 mb-4" />
      <p className="text-sm mb-2">{t("pages:team.empty.noTeam")}</p>
      <p className="text-xs mb-4">{t("pages:team.empty.noTeamDesc")}</p>

      {/* Join Team */}
      <div className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-lg p-4 mb-4">
        <p className="text-xs text-neutral-400 mb-2 font-medium">{t("pages:team.empty.joinExisting")}</p>
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder={t("pages:team.empty.pasteCode")}
            className="flex-1 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-500"
          />
          <Button
            className="bg-blue-600 hover:bg-blue-500 text-xs"
            onClick={onJoin}
            disabled={joining || !joinCode.trim()}
          >
            {joining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("pages:team.joinButton")}
          </Button>
        </div>
      </div>

      <p className="text-xs text-neutral-600 mb-4">{t("pages:team.empty.or")}</p>

      <Button variant="outline" size="sm" className="border-neutral-700" onClick={onCreate}>
        <Plus className="w-3.5 h-3.5 mr-1" /> {t("pages:team.empty.createNew")}
      </Button>
    </div>
  );
}

function OverviewTab({ feedbackStats, memberCount }: {
  feedbackStats?: { total: number; open: number; resolved: number; byType: Record<string, number> };
  memberCount: number;
}) {
  const { t } = useTranslation("pages");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-4">
        <StatCard icon={<Users className="w-4 h-4" />} label={t("pages:team.overview.members")} value={memberCount} color="text-blue-400" />
        <StatCard icon={<MessageSquare className="w-4 h-4" />} label={t("pages:team.overview.feedback")} value={feedbackStats?.total || 0} color="text-emerald-400" />
        <StatCard icon={<MessageSquare className="w-4 h-4" />} label={t("pages:team.overview.openFeedback")} value={feedbackStats?.open || 0} color="text-amber-400" />
        <StatCard icon={<CheckCircle className="w-4 h-4" />} label={t("pages:team.overview.resolved")} value={feedbackStats?.resolved || 0} color="text-green-400" />
      </div>

      {feedbackStats && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
          <h3 className="text-xs font-medium text-neutral-400 mb-3">{t("pages:team.overview.feedbackByType")}</h3>
          <div className="grid grid-cols-4 gap-3 text-center">
            {Object.entries(feedbackStats.byType).map(([type, count]) => (
              <div key={type}>
                <p className="text-lg font-semibold">{count}</p>
                <p className="text-[10px] text-neutral-500 capitalize">{type}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
      <div className={`${color} mb-2`}>{icon}</div>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-[10px] text-neutral-500">{label}</p>
    </div>
  );
}

const FEEDBACK_STATUSES = ["new", "triaged", "in_progress", "resolved", "verified", "closed"] as const;
type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

const statusConfig: Record<FeedbackStatus, { labelKey: string; className: string }> = {
  new: { labelKey: "team.statuses.new", className: "bg-blue-500/10 text-blue-400" },
  triaged: { labelKey: "team.statuses.triaged", className: "bg-amber-500/10 text-amber-400" },
  in_progress: { labelKey: "team.statuses.inProgress", className: "bg-orange-500/10 text-orange-400" },
  resolved: { labelKey: "team.statuses.resolved", className: "bg-green-500/10 text-green-400" },
  verified: { labelKey: "team.statuses.verified", className: "bg-emerald-500/10 text-emerald-400" },
  closed: { labelKey: "team.statuses.closed", className: "bg-neutral-500/10 text-neutral-400" },
};

function StatusBadge({ status }: { status: FeedbackStatus }) {
  const { t } = useTranslation("pages");
  const cfg = statusConfig[status] || statusConfig.new;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${cfg.className}`}>
      {t(cfg.labelKey)}
    </span>
  );
}

function StatusSelect({
  feedbackId,
  currentStatus,
  onStatusChange,
  isPending,
}: {
  feedbackId: number;
  currentStatus: FeedbackStatus;
  onStatusChange: (feedbackId: number, status: FeedbackStatus) => void;
  isPending: boolean;
}) {
  const { t } = useTranslation("pages");
  return (
    <div className="relative inline-flex items-center gap-1">
      {isPending && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
      <select
        value={currentStatus}
        onChange={(e) => onStatusChange(feedbackId, e.target.value as FeedbackStatus)}
        disabled={isPending}
        className="bg-neutral-800 border border-neutral-700 text-xs text-neutral-300 rounded px-1.5 py-0.5 pr-5 appearance-none cursor-pointer focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}
      >
        {FEEDBACK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {t(statusConfig[s].labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}

// Screenshot URLs arrive pre-signed from the server (short-lived, file-scoped
// ?exp&sig params) — plain <img src> works without any token handling here.

function FeedbackTab({ teamId, isAdmin }: { teamId: number; isAdmin: boolean }) {
  const { t } = useTranslation("pages");
  const { data: feedbackList, isLoading, error } = trpc.feedback.list.useQuery({ teamId, limit: 50 });
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const utils = trpc.useUtils();

  const updateStatusMutation = trpc.feedback.updateStatus.useMutation({
    onSuccess: () => {
      toast.success(t("pages:team.feedback.statusUpdated"));
      setUpdatingId(null);
      utils.feedback.list.invalidate({ teamId });
      utils.feedback.stats.invalidate({ teamId });
    },
    onError: (err) => {
      toast.error(t("pages:team.feedback.updateFailed", { error: err.message }));
      setUpdatingId(null);
    },
  });

  const handleStatusChange = (feedbackId: number, status: FeedbackStatus) => {
    setUpdatingId(feedbackId);
    updateStatusMutation.mutate({ feedbackId, status });
  };

  if (isLoading) return <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />;

  if (error) {
    return (
      <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
        <p className="font-medium mb-1">{t("pages:team.feedback.loadFailed")}</p>
        <p className="text-xs text-red-400/70">{error.message}</p>
      </div>
    );
  }

  if (!feedbackList || feedbackList.length === 0) {
    return (
      <div className="text-sm text-neutral-500 py-8 text-center">
        <MessageSquare className="w-8 h-8 mx-auto mb-2 text-neutral-600" />
        <p>{t("pages:team.feedback.none")}</p>
        <p className="text-[11px] text-neutral-600 mt-1">{t("pages:team.feedback.noneDesc")}</p>
      </div>
    );
  }

  return (
    <>
      <ScrollArea className="h-[600px]">
        <div className="space-y-2">
          {feedbackList.map((fb) => {
            const currentStatus = (fb.status || "new") as FeedbackStatus;
            return (
              <div key={fb.id} className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${
                    fb.feedbackType === "bug" ? "bg-red-500/10 text-red-400"
                    : fb.feedbackType === "suggestion" ? "bg-blue-500/10 text-blue-400"
                    : fb.feedbackType === "praise" ? "bg-emerald-500/10 text-emerald-400"
                    : "bg-yellow-500/10 text-yellow-400"
                  }`}>
                    {fb.feedbackType}
                  </span>
                  {isAdmin ? (
                    <StatusSelect
                      feedbackId={fb.id}
                      currentStatus={currentStatus}
                      onStatusChange={handleStatusChange}
                      isPending={updatingId === fb.id && updateStatusMutation.isPending}
                    />
                  ) : (
                    <StatusBadge status={currentStatus} />
                  )}
                  <span className="text-[10px] text-neutral-500">{fb.name || fb.username || t("pages:team.feedback.anonymous")}</span>
                  <span className="text-[9px] text-neutral-600 ml-auto">
                    {fb.createdAt ? new Date(fb.createdAt).toLocaleDateString() : ""}
                  </span>
                </div>
                <p className="text-xs text-neutral-300 whitespace-pre-wrap">{fb.content}</p>
                {fb.screenshotUrl && (
                  <button
                    onClick={() => setExpandedScreenshot(fb.screenshotUrl!)}
                    className="mt-2 block"
                  >
                    <img
                      src={fb.screenshotUrl}
                      alt={t("pages:team.feedback.screenshotAlt")}
                      className="max-h-32 rounded border border-neutral-700 hover:border-blue-500/50 transition-colors object-cover"
                    />
                  </button>
                )}
                {fb.severity && fb.feedbackType === "bug" && (
                  <span className={`inline-block mt-1.5 text-[9px] px-1.5 py-0.5 rounded ${
                    fb.severity === "critical" ? "bg-red-500/10 text-red-400"
                    : fb.severity === "major" ? "bg-orange-500/10 text-orange-400"
                    : fb.severity === "minor" ? "bg-yellow-500/10 text-yellow-400"
                    : "bg-neutral-500/10 text-neutral-400"
                  }`}>
                    {fb.severity}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Expanded screenshot modal */}
      {expandedScreenshot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setExpandedScreenshot(null)}
        >
          <img
            src={expandedScreenshot}
            alt={t("pages:team.feedback.screenshotFullAlt")}
            className="max-w-[90vw] max-h-[90vh] rounded-lg border border-neutral-700"
          />
        </div>
      )}
    </>
  );
}

function MembersTab({ members }: {
  members: Array<{
    id: number; userId: number; role: string; joinedAt: Date | null;
    username: string | null; name: string | null; avatar: string | null;
    engagementScore: number | null;
  }>;
}) {
  const { t } = useTranslation("pages");
  return (
    <div className="space-y-2">
      {members.map((member) => (
        <div key={member.id} className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-lg p-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-xs font-bold text-white shrink-0">
            {(member.name || member.username || "?").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium">{member.name || member.username || t("pages:team.members.unknown")}</p>
            <p className="text-[10px] text-neutral-500">@{member.username}</p>
          </div>
          <span className={`text-[10px] px-2 py-0.5 rounded capitalize ${
            member.role === "owner" ? "bg-amber-500/10 text-amber-400"
            : member.role === "admin" ? "bg-blue-500/10 text-blue-400"
            : member.role === "tester" ? "bg-emerald-500/10 text-emerald-400"
            : "bg-neutral-500/10 text-neutral-400"
          }`}>
            {member.role}
          </span>
        </div>
      ))}
    </div>
  );
}

function TeamSpaceTab({
  teamId,
  sharedProjects,
  myRole,
}: {
  teamId: number;
  sharedProjects: Array<{ id: number; projectId: number; projectName: string | null; addedAt: Date | null }>;
  myRole: string;
}) {
  const canManage = ["owner", "admin"].includes(myRole);
  const { t } = useTranslation("pages");
  const utils = trpc.useUtils();
  const { data: myProjects } = trpc.project.list.useQuery();

  const shareMutation = trpc.team.shareProject.useMutation({
    onSuccess: () => {
      toast.success(t("pages:team.toasts.projectShared"));
      utils.team.getTeam.invalidate({ teamId });
    },
    onError: (err) => toast.error(err.message),
  });

  const unsharedProjects = (myProjects || []).filter(
    (p) => !sharedProjects.find((sp) => sp.projectId === p.id),
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-3">
          <FolderOpen className="w-4 h-4 text-blue-400" />
          <h3 className="text-sm font-medium">{t("pages:team.space.sharedProjects")}</h3>
          <span className="text-[10px] text-neutral-500 bg-neutral-800 px-1.5 py-0.5 rounded">{sharedProjects.length}</span>
        </div>
        {sharedProjects.length === 0 ? (
          <p className="text-xs text-neutral-500 py-4 text-center bg-neutral-900 rounded-lg border border-neutral-800">{t("pages:team.space.noProjects")}</p>
        ) : (
          <div className="space-y-1.5">
            {sharedProjects.map((sp) => (
              <div key={sp.id} className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-lg p-3">
                <FolderOpen className="w-4 h-4 text-emerald-400" />
                <p className="text-xs font-medium">{sp.projectName || `Project #${sp.projectId}`}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage && unsharedProjects.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
          <p className="text-xs font-medium mb-2">{t("pages:team.space.addProject")}</p>
          <div className="space-y-1.5">
            {unsharedProjects.map((project) => (
              <button
                key={project.id}
                onClick={() => shareMutation.mutate({ teamId, projectId: project.id })}
                disabled={shareMutation.isPending}
                className="flex items-center gap-2 w-full px-3 py-2 rounded border border-neutral-700 hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors text-left"
              >
                <FolderOpen className="w-3.5 h-3.5 text-neutral-500" />
                <span className="text-xs text-neutral-300">{project.name}</span>
                <Share2 className="w-3 h-3 text-blue-400 ml-auto" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Shared Pipelines */}
      <SharedPipelinesSection teamId={teamId} myRole={myRole} />

      {/* Shared Agents */}
      <SharedAgentsSection teamId={teamId} />
    </div>
  );
}


function SharedPipelinesSection({ teamId, myRole }: { teamId: number; myRole: string }) {
  const { t } = useTranslation("pages");
  const { data: pipelines, isLoading } = trpc.team.getSharedPipelines.useQuery({ teamId });
  const { data: myProjects } = trpc.project.list.useQuery();

  const importMutation = trpc.team.importPipeline.useMutation({
    onSuccess: (result) => {
      toast.success(t("pages:team.toasts.pipelineImported", { name: result.name }));
    },
    onError: (err) => toast.error(err.message),
  });

  // Group pipeline steps by project
  const grouped = new Map<number, { name: string; steps: NonNullable<typeof pipelines> }>();
  if (pipelines) {
    for (const step of pipelines) {
      const existing = grouped.get(step.projectId);
      if (existing) {
        existing.steps.push(step);
      } else {
        grouped.set(step.projectId, { name: step.projectName, steps: [step] });
      }
    }
  }
  void myRole; // reserved for future remove functionality

  if (isLoading) return <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />;
  if (!pipelines || pipelines.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Workflow className="w-4 h-4 text-purple-400" />
          <h3 className="text-sm font-medium">{t("pages:team.space.sharedPipelines")}</h3>
          <span className="text-[10px] text-neutral-500 bg-neutral-800 px-1.5 py-0.5 rounded">0</span>
        </div>
        <p className="text-xs text-neutral-500 py-4 text-center bg-neutral-900 rounded-lg border border-neutral-800">
          {t("pages:team.space.shareProjectHint")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Workflow className="w-4 h-4 text-purple-400" />
        <h3 className="text-sm font-medium">{t("pages:team.space.sharedPipelines")}</h3>
        <span className="text-[10px] text-neutral-500 bg-neutral-800 px-1.5 py-0.5 rounded">{grouped.size} {t("pages:team.space.projectsSuffix")}</span>
      </div>
      <div className="space-y-3">
        {Array.from(grouped.entries()).map(([projectId, group]) => (
          <div key={projectId} className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
            {/* Project header */}
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-neutral-200">{group.name}</p>
              <span className="text-[9px] text-neutral-500">{group.steps.length} {t("pages:team.space.stepsSuffix")}</span>
            </div>

            {/* Pipeline flow */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {group.steps.sort((a, b) => a.stepOrder - b.stepOrder).map((step, i) => (
                <div key={step.id} className="flex items-center gap-1">
                  {i > 0 && <span className="text-[8px] text-neutral-600">→</span>}
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-neutral-700">
                    {step.role}
                  </span>
                </div>
              ))}
            </div>

            {/* Import buttons */}
            <div className="flex gap-1.5 flex-wrap">
              {myProjects?.map((project) => (
                <button
                  key={project.id}
                  onClick={() => {
                    // Import first step as a starting point
                    const firstStep = group.steps[0];
                    if (!firstStep) return;
                    importMutation.mutate({ teamId, stepId: firstStep.id, targetProjectId: project.id });
                  }}
                  disabled={importMutation.isPending}
                  className="text-[9px] px-2 py-1 rounded border border-neutral-700 hover:border-blue-500/50 hover:bg-blue-500/10 text-neutral-400 hover:text-blue-400 transition-colors flex items-center gap-1"
                >
                  {importMutation.isPending ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
                  {t("pages:team.space.importTo")} {project.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SharedAgentsSection({ teamId }: { teamId: number }) {
  const { t } = useTranslation("pages");
  const { data: agents, isLoading } = trpc.team.getSharedAgents.useQuery({ teamId });
  const { data: myProjects } = trpc.project.list.useQuery();
  const [importingId, setImportingId] = useState<number | null>(null);

  const importMutation = trpc.team.importAgent.useMutation({
    onSuccess: (result) => {
      toast.success(t("pages:team.toasts.agentImported", { name: result.name }));
      setImportingId(null);
    },
    onError: (err) => {
      toast.error(err.message);
      setImportingId(null);
    },
  });

  if (isLoading) return <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />;
  if (!agents || agents.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Bot className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-medium">{t("pages:team.space.sharedAgents")}</h3>
          <span className="text-[10px] text-neutral-500 bg-neutral-800 px-1.5 py-0.5 rounded">0</span>
        </div>
        <p className="text-xs text-neutral-500 py-4 text-center bg-neutral-900 rounded-lg border border-neutral-800">
          {t("pages:team.space.shareAgentsHint")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Bot className="w-4 h-4 text-emerald-400" />
        <h3 className="text-sm font-medium">{t("pages:team.space.sharedAgents")}</h3>
        <span className="text-[10px] text-neutral-500 bg-neutral-800 px-1.5 py-0.5 rounded">{agents.length}</span>
      </div>
      <div className="space-y-1.5">
        {agents.map((agent) => (
          <div key={agent.id} className="bg-neutral-900 border border-neutral-800 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded bg-emerald-600 flex items-center justify-center text-[8px] font-bold text-white shrink-0">
                  {agent.name.charAt(0).toUpperCase()}
                </span>
                <p className="text-xs font-medium text-neutral-200">{agent.name}</p>
                <span className="text-[9px] text-neutral-500 uppercase">{agent.role}</span>
              </div>
            </div>
            <p className="text-[10px] text-neutral-500 mb-1">{t("pages:team.space.by")} {agent.ownerName}</p>
            {agent.description && (
              <p className="text-[10px] text-neutral-600 mb-2">{agent.description}</p>
            )}
            <div className="flex gap-1.5 flex-wrap">
              {myProjects?.map((project) => (
                <button
                  key={project.id}
                  onClick={() => {
                    setImportingId(agent.id);
                    importMutation.mutate({ teamId, agentId: agent.id, targetProjectId: project.id });
                  }}
                  disabled={importMutation.isPending && importingId === agent.id}
                  className="text-[9px] px-2 py-1 rounded border border-neutral-700 hover:border-emerald-500/50 hover:bg-emerald-500/10 text-neutral-400 hover:text-emerald-400 transition-colors flex items-center gap-1"
                >
                  {importingId === agent.id && importMutation.isPending ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  ) : (
                    <Download className="w-2.5 h-2.5" />
                  )}
                  {t("pages:team.space.importTo")} {project.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
