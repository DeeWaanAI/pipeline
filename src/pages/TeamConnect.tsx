import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import {
  Copy,
  Check,
  Users,
  UserPlus,
  Loader2,
  Terminal,
  Hourglass,
  Send,
  MousePointerClick,
  ShieldCheck,
  ChevronRight,
  ArrowRight,
} from "lucide-react";

type AppKey = "claude" | "chatgpt" | "qwen" | "kimi";

const APP_ORDER: AppKey[] = ["claude", "chatgpt", "qwen", "kimi"];
const STEP_KEYS = ["step1", "step2", "step3", "step4"] as const;
const ROLE_KEYS = ["owner", "admin", "tester", "viewer"] as const;

const APP_ACCENT: Record<AppKey, string> = {
  claude: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  chatgpt: "text-green-400 bg-green-500/10 border-green-500/30",
  qwen: "text-purple-400 bg-purple-500/10 border-purple-500/30",
  kimi: "text-blue-400 bg-blue-500/10 border-blue-500/30",
};

const ROLE_ACCENT: Record<string, string> = {
  owner: "bg-amber-500/10 text-amber-400",
  admin: "bg-blue-500/10 text-blue-400",
  tester: "bg-emerald-500/10 text-emerald-400",
  viewer: "bg-neutral-500/10 text-neutral-400",
};

export default function TeamConnect() {
  const { t } = useTranslation("teamsync");
  const { user } = useAuth();
  const [inviteCode, setInviteCode] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const { data: myTeams, isLoading: teamsLoading } = trpc.team.listMyTeams.useQuery();
  const { data: teamDetail } = trpc.team.getTeam.useQuery(
    { teamId: selectedTeamId! },
    { enabled: !!selectedTeamId },
  );

  const joinTeam = trpc.team.joinByCode.useMutation({
    onSuccess: (result) => {
      toast.success(t("teams.joinedToast", { name: result.name }));
      setInviteCode("");
      utils.team.listMyTeams.invalidate();
      setSelectedTeamId(result.teamId);
    },
    onError: (err) => toast.error(err.message),
  });

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp";

  const copy = async (key: string, text: string, toastKey: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success(t(toastKey));
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      toast.error(text);
    }
  };

  const roleLabel = (role: string) =>
    (ROLE_KEYS as readonly string[]).includes(role)
      ? t(`teams.roles.${role}`)
      : role;

  const snippets: Record<AppKey, string> = {
    claude: JSON.stringify(
      { mcpServers: { "ai-swarm-studio": { url: mcpUrl } } },
      null,
      2,
    ),
    chatgpt: mcpUrl,
    qwen: `qwen mcp add --transport http ai-swarm-studio ${mcpUrl}`,
    kimi: mcpUrl,
  };

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-400">
        {t("loginRequired")}
      </div>
    );
  }

  return (
    <AppShell>
      <div className="h-full overflow-y-auto bg-neutral-950 text-neutral-100">
        <div className="mx-auto max-w-4xl px-6 py-8 space-y-8">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("title")}
            </h1>
            <p className="mt-2 text-sm text-neutral-400 max-w-2xl">
              {t("subtitle")}
            </p>
          </div>

          {/* ─── Section A: my teams + join by invite code ─── */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-medium">
                <Users className="h-5 w-5 text-blue-400" />
                {t("teams.title")}
              </h2>
              <Link
                to="/team"
                className="flex items-center gap-1 text-xs text-neutral-400 hover:text-blue-400 transition-colors"
              >
                {t("teams.openDashboard")}
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {/* Join by invite code */}
            <div className="mt-4">
              <div className="text-sm font-medium text-neutral-300">
                {t("teams.joinTitle")}
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                {t("teams.joinDesc")}
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder={t("teams.invitePlaceholder")}
                  className="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
                <Button
                  className="shrink-0 bg-blue-600 hover:bg-blue-500"
                  onClick={() =>
                    inviteCode.trim() &&
                    joinTeam.mutate({ inviteCode: inviteCode.trim() })
                  }
                  disabled={joinTeam.isPending || !inviteCode.trim()}
                >
                  {joinTeam.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="mr-1.5 h-4 w-4" />
                  )}
                  {joinTeam.isPending ? t("teams.joining") : t("teams.join")}
                </Button>
              </div>
            </div>

            {/* Team list */}
            <div className="mt-5">
              {teamsLoading ? (
                <Loader2 className="mx-auto h-4 w-4 animate-spin text-neutral-500" />
              ) : !myTeams || myTeams.length === 0 ? (
                <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 py-6 text-center">
                  <p className="text-sm text-neutral-400">{t("teams.noTeams")}</p>
                  <p className="mt-1 text-xs text-neutral-600">
                    {t("teams.noTeamsDesc")}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {myTeams.map((team) => (
                    <div
                      key={team.id}
                      className={`flex w-full items-center gap-3 rounded-lg border p-3 transition-colors ${
                        selectedTeamId === team.id
                          ? "border-blue-500/30 bg-blue-500/10"
                          : "border-neutral-800 bg-neutral-900/30 hover:bg-neutral-800"
                      }`}
                    >
                      <button
                        onClick={() => setSelectedTeamId(team.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gradient-to-br from-blue-500 to-purple-600 text-xs font-bold text-white">
                          {team.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {team.name}
                          </p>
                          <p className="text-xs text-neutral-500">
                            {team.memberCount} {t("teams.membersSuffix")} ·{" "}
                            {t("teams.roleLabel")}{" "}
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] ${ROLE_ACCENT[team.myRole] ?? ROLE_ACCENT.viewer}`}
                            >
                              {roleLabel(team.myRole)}
                            </span>
                          </p>
                        </div>
                      </button>
                      {team.inviteCode && (
                        <button
                          type="button"
                          onClick={() =>
                            copy(
                              `code-${team.id}`,
                              team.inviteCode!,
                              "teams.copied",
                            )
                          }
                          className="flex shrink-0 items-center gap-1.5 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                          title={t("teams.copyCode")}
                        >
                          {copiedKey === `code-${team.id}` ? (
                            <Check className="h-3 w-3 text-green-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          <span className="font-mono">{team.inviteCode}</span>
                        </button>
                      )}
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Selected team members (via team.getTeam) */}
            {selectedTeamId && teamDetail && (
              <div className="mt-4 border-t border-neutral-800 pt-4">
                <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                  {t("teams.membersTitle")}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {teamDetail.members.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/30 px-2.5 py-1.5"
                    >
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-[10px] font-bold text-white">
                        {(member.name || member.username || "?")
                          .charAt(0)
                          .toUpperCase()}
                      </div>
                      <span className="text-xs text-neutral-300">
                        {member.name ||
                          member.username ||
                          t("teams.unknownMember")}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${ROLE_ACCENT[member.role] ?? ROLE_ACCENT.viewer}`}
                      >
                        {roleLabel(member.role)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ─── Section B: per-app connect guide ─── */}
          <div>
            <h2 className="text-lg font-medium">{t("guide.title")}</h2>
            <p className="mt-1 text-sm text-neutral-400 max-w-2xl">
              {t("guide.desc")}
            </p>

            {/* Endpoint card */}
            <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
              <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                {t("guide.endpointLabel")}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-2.5 font-mono text-sm text-neutral-200 break-all">
                  {mcpUrl}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copy("endpoint", mcpUrl, "guide.copied")}
                  className="shrink-0 border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                >
                  {copiedKey === "endpoint" ? (
                    <Check className="mr-1.5 h-4 w-4 text-green-400" />
                  ) : (
                    <Copy className="mr-1.5 h-4 w-4" />
                  )}
                  {copiedKey === "endpoint"
                    ? t("guide.copied")
                    : t("guide.copy")}
                </Button>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                {t("guide.endpointHint")}
              </p>
            </div>

            {/* Per-app guides */}
            <h3 className="mt-6 text-sm font-medium text-neutral-300">
              {t("guide.appsTitle")}
            </h3>
            <div className="mt-3 space-y-3">
              {APP_ORDER.map((appKey) => (
                <div
                  key={appKey}
                  className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {t(`guide.apps.${appKey}.name`)}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-xs ${APP_ACCENT[appKey]}`}
                    >
                      {t(`guide.apps.${appKey}.tagline`)}
                    </Badge>
                  </div>
                  <ol className="mt-3 space-y-2">
                    {STEP_KEYS.map((stepKey, i) => (
                      <li
                        key={stepKey}
                        className="flex gap-3 text-sm text-neutral-300"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs text-neutral-400">
                          {i + 1}
                        </span>
                        <span className="flex-1">
                          {t(`guide.apps.${appKey}.${stepKey}`)}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {/* Copy-paste config snippet targeting /mcp */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-neutral-500">
                        <Terminal className="h-3.5 w-3.5" />
                        {t("guide.configLabel")}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          copy(`snippet-${appKey}`, snippets[appKey], "guide.copied")
                        }
                        className="h-7 border-neutral-700 bg-neutral-800 text-xs text-neutral-200 hover:bg-neutral-700"
                      >
                        {copiedKey === `snippet-${appKey}` ? (
                          <Check className="mr-1.5 h-3.5 w-3.5 text-green-400" />
                        ) : (
                          <Copy className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {copiedKey === `snippet-${appKey}`
                          ? t("guide.copied")
                          : t("guide.copy")}
                      </Button>
                    </div>
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200">
                      {snippets[appKey]}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ─── Section C: "waiting for you" handoff explainer ─── */}
          <div>
            <h2 className="text-lg font-medium">{t("handoff.title")}</h2>
            <p className="mt-1 text-sm text-neutral-400 max-w-2xl">
              {t("handoff.desc")}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {[
                {
                  icon: Hourglass,
                  title: t("handoff.step1Title"),
                  desc: t("handoff.step1Desc"),
                },
                {
                  icon: Send,
                  title: t("handoff.step2Title"),
                  desc: t("handoff.step2Desc"),
                },
                {
                  icon: MousePointerClick,
                  title: t("handoff.step3Title"),
                  desc: t("handoff.step3Desc"),
                },
              ].map(({ icon: Icon, title, desc }) => (
                <div
                  key={title}
                  className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4"
                >
                  <Icon className="h-5 w-5 text-neutral-400" />
                  <div className="mt-2 text-sm font-medium">{title}</div>
                  <div className="mt-1 text-xs text-neutral-400">{desc}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-3 rounded-xl border border-neutral-800 bg-neutral-900/30 p-5">
              <ShieldCheck className="h-5 w-5 shrink-0 text-green-400" />
              <div>
                <div className="text-sm font-medium">
                  {t("handoff.noteTitle")}
                </div>
                <div className="mt-1 text-xs text-neutral-400">
                  {t("handoff.noteDesc")}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
