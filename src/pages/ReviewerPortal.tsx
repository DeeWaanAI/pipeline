import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/layout/AppShell";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Star,
  Loader2,
  Trophy,
  ArrowLeft,
  ClipboardList,
  Award,
  Zap,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  EyeOff,
  Send,
} from "lucide-react";

// Scoring dimension keys — must mirror REVIEW_RUBRIC in api/routers/marketplace.ts exactly.
const BLIND_DIMENSION_KEYS = [
  "accuracy",
  "completeness",
  "clarity",
  "tokenEfficiency",
  "speed",
  "consistency",
] as const;

type BlindTask = {
  taskId: number;
  inputText: string;
  actualOutput: string | null;
  rubric: Record<(typeof BLIND_DIMENSION_KEYS)[number], string>;
};

// Sub-component: blind review task flow (spec 0.5/0.6). The task payload
// deliberately carries NO listing identity — the UI must not try to show one.
function BlindReviewSection() {
  const { t } = useTranslation("pages");
  const [task, setTask] = useState<BlindTask | null>(null);
  const [noTaskAvailable, setNoTaskAvailable] = useState(false);
  const [scores, setScores] = useState<Partial<Record<(typeof BLIND_DIMENSION_KEYS)[number], number>>>({});
  const [submitted, setSubmitted] = useState<{ weightedScore: number; pointsAwarded: number } | null>(null);
  const startedAtRef = useRef<number>(0);

  const pullMutation = trpc.marketplace.getNextReviewTask.useMutation({
    onSuccess: (data) => {
      if (!data.task) {
        setNoTaskAvailable(true);
        setTask(null);
        return;
      }
      setNoTaskAvailable(false);
      setSubmitted(null);
      setScores({});
      setTask(data.task);
      startedAtRef.current = Date.now();
    },
    onError: (err) => toast.error(err.message),
  });

  const submitMutation = trpc.marketplace.submitReviewTask.useMutation({
    onSuccess: (data) => {
      setSubmitted({ weightedScore: data.weightedScore, pointsAwarded: data.pointsAwarded });
      setTask(null);
      toast.success(data.message);
    },
    onError: (err) => toast.error(err.message),
  });

  const allScored = BLIND_DIMENSION_KEYS.every((k) => scores[k] !== undefined);

  const handleSubmit = () => {
    if (!task || !allScored) {
      toast.error(t("pages:reviewer.portal.blindTask.rateAll"));
      return;
    }
    submitMutation.mutate({
      taskId: task.taskId,
      accuracy: scores.accuracy!,
      completeness: scores.completeness!,
      clarity: scores.clarity!,
      tokenEfficiency: scores.tokenEfficiency!,
      speed: scores.speed!,
      consistency: scores.consistency!,
      reviewTime: Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)),
    });
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5 mb-6">
      <h3 className="text-sm font-medium text-neutral-300 mb-1 flex items-center gap-2">
        <EyeOff className="w-4 h-4 text-purple-400" />
        {t("pages:reviewer.portal.blindTask.title")}
      </h3>
      <p className="text-xs text-neutral-500 mb-4">{t("pages:reviewer.portal.blindTask.description")}</p>

      {/* Idle / no-task / submitted states */}
      {!task && (
        <div className="text-center py-6">
          {submitted && (
            <div className="mb-4">
              <div className="w-12 h-12 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="w-6 h-6 text-emerald-400" />
              </div>
              <p className="text-sm font-medium text-emerald-400">{t("pages:reviewer.portal.blindTask.submittedTitle")}</p>
              <p className="text-xs text-neutral-400 mt-1">
                {t("pages:reviewer.portal.blindTask.weightedScore", { score: submitted.weightedScore })}
                <span className="mx-2 text-neutral-600">|</span>
                <span className="text-amber-400">{t("pages:reviewer.portal.blindTask.pointsAwarded", { points: submitted.pointsAwarded })}</span>
              </p>
            </div>
          )}
          {noTaskAvailable && !submitted && (
            <div className="mb-4">
              <Clock className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
              <p className="text-sm text-neutral-400">{t("pages:reviewer.portal.blindTask.noTask")}</p>
            </div>
          )}
          <Button
            size="sm"
            className="bg-purple-600 hover:bg-purple-700"
            onClick={() => pullMutation.mutate()}
            disabled={pullMutation.isPending}
          >
            {pullMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <ClipboardList className="w-4 h-4 mr-1.5" />
            )}
            {pullMutation.isPending
              ? t("pages:reviewer.portal.blindTask.pulling")
              : submitted
                ? t("pages:reviewer.portal.blindTask.nextTask")
                : t("pages:reviewer.portal.blindTask.pullTask")}
          </Button>
        </div>
      )}

      {/* Active task: blind input/output + rubric scoring */}
      {task && (
        <div>
          <div className="flex items-center gap-1.5 text-xs text-purple-300 bg-purple-500/5 border border-purple-500/10 rounded-md px-3 py-2 mb-4">
            <EyeOff className="w-3.5 h-3.5 shrink-0" />
            {t("pages:reviewer.portal.blindTask.blindNote")}
          </div>

          <div className="mb-4">
            <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-1.5">
              {t("pages:reviewer.portal.blindTask.inputLabel")}
            </h4>
            <p className="text-sm text-neutral-100 leading-relaxed bg-neutral-800/30 rounded-lg p-4 border border-neutral-700/50 whitespace-pre-wrap">
              {task.inputText}
            </p>
          </div>

          <div className="mb-5">
            <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-1.5">
              {t("pages:reviewer.portal.blindTask.outputLabel")}
            </h4>
            {task.actualOutput ? (
              <p className="text-sm text-neutral-100 leading-relaxed bg-blue-500/5 rounded-lg p-4 border border-blue-500/10 whitespace-pre-wrap font-mono text-xs max-h-64 overflow-y-auto">
                {task.actualOutput}
              </p>
            ) : (
              <p className="text-sm text-neutral-500 italic">{t("pages:reviewer.portal.blindTask.noOutput")}</p>
            )}
          </div>

          <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-3">
            {t("pages:reviewer.portal.blindTask.rubricTitle")}
          </h4>
          <div className="space-y-4 mb-5">
            {BLIND_DIMENSION_KEYS.map((key) => (
              <div key={key} className="p-3 bg-neutral-800/30 rounded-lg border border-neutral-800">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-medium text-neutral-200">
                    {t(`pages:reviewer.review.dimensions.${key}`)}
                  </span>
                  <span className="text-sm font-bold text-amber-400">{scores[key] ?? "—"}</span>
                </div>
                <p className="text-xs text-neutral-500 mb-2">{task.rubric[key]}</p>
                <div className="flex gap-1.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => setScores((prev) => ({ ...prev, [key]: n }))}
                      className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                        scores[key] === n
                          ? "bg-purple-600 text-white"
                          : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <Button
            className="w-full bg-purple-600 hover:bg-purple-700"
            onClick={handleSubmit}
            disabled={submitMutation.isPending || !allScored}
          >
            {submitMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-1.5" />
            )}
            {submitMutation.isPending
              ? t("pages:reviewer.portal.blindTask.submitting")
              : t("pages:reviewer.portal.blindTask.submit")}
          </Button>
        </div>
      )}
    </div>
  );
}

// Sub-component: Points redemption UI
function PointsRedemption({ profile }: { profile: { pointsBalance: number | null; subscriptionDays: number | null } }) {
  const { t } = useTranslation("pages");
  // Redeem rate. The wire values are the api's marketplace.redeemPoints enum;
  // they buy the same subscription days and carry no plan meaning.
  const [rate, setRate] = useState<"master" | "sage">("master");
  const [days, setDays] = useState(1);

  const redeemMutation = trpc.marketplace.redeemPoints.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      window.location.reload();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const balance = profile.pointsBalance ?? 0;
  const costPerDay = rate === "sage" ? 120 : 72;
  const totalCost = costPerDay * days;
  const canAfford = balance >= totalCost;

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5 mb-6">
      <h3 className="text-sm font-medium text-neutral-300 mb-3 flex items-center gap-2">
        <Coins className="w-4 h-4 text-amber-400" />
        {t("pages:reviewer.portal.redemption.title")}
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {/* Rate selector */}
        <button
          onClick={() => setRate("master")}
          className={`p-3 rounded-lg border text-left transition-colors ${
            rate === "master"
              ? "border-blue-500 bg-blue-500/10"
              : "border-neutral-700 hover:border-neutral-600"
          }`}
        >
          <div className="text-sm font-medium text-neutral-200">{t("pages:reviewer.portal.redemption.basicLabel")}</div>
          <div className="text-xs text-neutral-500">{t("pages:reviewer.portal.redemption.basicCost")}</div>
          <div className="text-xs text-blue-400 mt-1">{t("pages:reviewer.portal.redemption.basicValue")}</div>
        </button>

        <button
          onClick={() => setRate("sage")}
          className={`p-3 rounded-lg border text-left transition-colors ${
            rate === "sage"
              ? "border-amber-500 bg-amber-500/10"
              : "border-neutral-700 hover:border-neutral-600"
          }`}
        >
          <div className="text-sm font-medium text-neutral-200">{t("pages:reviewer.portal.redemption.enhancedLabel")}</div>
          <div className="text-xs text-neutral-500">{t("pages:reviewer.portal.redemption.enhancedCost")}</div>
          <div className="text-xs text-amber-400 mt-1">{t("pages:reviewer.portal.redemption.enhancedValue")}</div>
        </button>

        {/* Days selector */}
        <div className="p-3 rounded-lg border border-neutral-700">
          <div className="text-sm font-medium text-neutral-200 mb-2">{t("pages:reviewer.portal.redemption.days")}</div>
          <div className="flex items-center gap-2">
            {[1, 3, 7].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  days === d
                    ? "bg-neutral-700 text-white"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="text-neutral-500">{t("pages:reviewer.portal.redemption.cost")} </span>
          <span className={`font-medium ${canAfford ? "text-neutral-200" : "text-red-400"}`}>
            {totalCost} {t("pages:reviewer.portal.redemption.pts")}
          </span>
          <span className="text-neutral-600 mx-2">|</span>
          <span className="text-neutral-500">{t("pages:reviewer.portal.redemption.balance")} </span>
          <span className="text-amber-400 font-medium">{balance} {t("pages:reviewer.portal.redemption.pts")}</span>
        </div>
        <button
          onClick={() => redeemMutation.mutate({ tier: rate, days })}
          // Paused by the owner's 2026-10-13 decision: there is no subscription
          // left to trade points for, so this button would promise something the
          // product cannot deliver. The handler, the balance and the ledger rows
          // are deliberately kept — what reviewers should get is UNDECIDED, and
          // deleting their history would be a worse answer than stopping the offer.
          disabled
          aria-describedby="reviewer-rewards-paused"
          className="px-4 py-1.5 rounded text-sm font-medium bg-neutral-800 text-neutral-500 cursor-not-allowed"
        >
          {redeemMutation.isPending ? t("pages:reviewer.portal.redemption.redeeming") : t("pages:reviewer.portal.redemption.redeem")}
        </button>
      </div>

      <p id="reviewer-rewards-paused" className="text-xs text-neutral-500 mt-2">
        {t("pages:reviewer.portal.redemption.paused")}
      </p>

      {!canAfford && (
        <p className="text-xs text-red-400 mt-2">
          {t("pages:reviewer.portal.redemption.insufficientPoints", { count: totalCost - balance })}
        </p>
      )}
    </div>
  );
}

export default function ReviewerPortal() {
  const { t } = useTranslation("pages");
  const { user } = useAuth();
  const [enrolling, setEnrolling] = useState(false);

  const { data: profile, isLoading: profileLoading } = trpc.marketplace.myReviewerProfile.useQuery();
  const { data: assignments, isLoading: assignmentsLoading } = trpc.marketplace.myAssignments.useQuery();
  const { data: leaderboard } = trpc.marketplace.reviewerLeaderboard.useQuery();

  const enrollMutation = trpc.marketplace.enrollReviewer.useMutation({
    onSuccess: () => {
      setEnrolling(false);
      window.location.reload();
    },
  });

  const handleEnroll = () => {
    setEnrolling(true);
    enrollMutation.mutate();
  };

  if (profileLoading) {
    return (
      <AppShell>
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
      </AppShell>
    );
  }

  const isEnrolled = !!profile;
  const pendingAssignments = assignments?.filter((a) => a.status === "pending" || a.status === "in_progress") ?? [];

  return (
    <AppShell>
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-900/50">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <Link
            to="/marketplace"
            className="inline-flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-100 transition-colors mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("pages:reviewer.portal.backToMarketplace")}
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Star className="w-6 h-6 text-amber-400" />
              <div>
                <h1 className="text-xl font-bold text-neutral-100">{t("pages:reviewer.portal.title")}</h1>
                <p className="text-sm text-neutral-400">
                  {t("pages:reviewer.portal.subtitle")}
                </p>
              </div>
            </div>
            {!isEnrolled && (
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-700"
                onClick={handleEnroll}
                disabled={enrolling}
              >
                {enrolling ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <Award className="w-4 h-4 mr-1.5" />
                )}
                {t("pages:reviewer.portal.enrollAsReviewer")}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {!isEnrolled ? (
          /* Not enrolled - show benefits */
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 text-center">
              <div className="w-12 h-12 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Zap className="w-6 h-6 text-amber-400" />
              </div>
              <h3 className="text-base font-medium text-neutral-200 mb-2">{t("pages:reviewer.portal.benefits.earnSageDays")}</h3>
              <p className="text-sm text-neutral-400">
                {t("pages:reviewer.portal.benefits.earnSageDesc")}
              </p>
            </div>
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 text-center">
              <div className="w-12 h-12 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Trophy className="w-6 h-6 text-blue-400" />
              </div>
              <h3 className="text-base font-medium text-neutral-200 mb-2">{t("pages:reviewer.portal.benefits.buildReputation")}</h3>
              <p className="text-sm text-neutral-400">
                {t("pages:reviewer.portal.benefits.buildReputationDesc")}
              </p>
            </div>
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 text-center">
              <div className="w-12 h-12 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="text-base font-medium text-neutral-200 mb-2">{t("pages:reviewer.portal.benefits.shapeQuality")}</h3>
              <p className="text-sm text-neutral-400">
                {t("pages:reviewer.portal.benefits.shapeQualityDesc")}
              </p>
            </div>
          </div>
        ) : (
          /* Enrolled - show profile + assignments */
          <>
            {/* Profile Stats */}
            <div className="grid grid-cols-5 gap-3 mb-6">
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-neutral-100">{profile.trustScore}</div>
                <div className="text-xs text-neutral-500 mt-1">{t("pages:reviewer.portal.stats.trustScore")}</div>
                {(profile.trustScore ?? 0) < 100 && (
                  <div className="flex items-center justify-center gap-1 mt-1 text-xs text-red-400">
                    <AlertTriangle className="w-3 h-3" />
                    {t("pages:reviewer.portal.stats.atRisk")}
                  </div>
                )}
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-neutral-100">{profile.reviewsCompleted}</div>
                <div className="text-xs text-neutral-500 mt-1">{t("pages:reviewer.portal.stats.reviewsDone")}</div>
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-amber-400">{profile.pointsBalance ?? 0}</div>
                <div className="text-xs text-neutral-500 mt-1">{t("pages:reviewer.portal.stats.points")}</div>
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-emerald-400">{profile.subscriptionDays ?? 0}</div>
                <div className="text-xs text-neutral-500 mt-1">{t("pages:reviewer.portal.stats.subDays")}</div>
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-neutral-100">{profile.reviewsFlagged}</div>
                <div className="text-xs text-neutral-500 mt-1">{t("pages:reviewer.portal.stats.flagged")}</div>
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 text-center">
                <Badge
                  variant="outline"
                  className={`text-xs ${profile.status === "active" ? "text-emerald-400 border-emerald-500/20" : "text-red-400 border-red-500/20"}`}
                >
                  {profile.status}
                </Badge>
                <div className="text-xs text-neutral-500 mt-1">{t("pages:reviewer.portal.stats.status")}</div>
              </div>
            </div>

            {/* Points Redemption */}
            <PointsRedemption profile={profile} />

            {/* Blind review tasks (spec 0.5/0.6) — active reviewers only */}
            {profile.status === "active" && <BlindReviewSection />}

            {/* Assignments */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Pending */}
              <div>
                <h3 className="text-sm font-medium text-neutral-300 mb-3 flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-blue-400" />
                  {t("pages:reviewer.portal.assignments.title")}
                </h3>
                {assignmentsLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
                  </div>
                ) : !pendingAssignments.length ? (
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 text-center">
                    <Clock className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
                    <p className="text-sm text-neutral-400">{t("pages:reviewer.portal.assignments.noPending")}</p>
                    <p className="text-xs text-neutral-500 mt-1">{t("pages:reviewer.portal.assignments.noPendingDesc")}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {pendingAssignments.map((a) => (
                      <Link
                        key={a.id}
                        to={`/reviewer/review/${a.listingId}`}
                        className="block bg-neutral-900 border border-neutral-800 rounded-lg p-4 hover:border-blue-500/40 transition-all"
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <h4 className="text-sm font-medium text-neutral-200">{a.title}</h4>
                            <p className="text-xs text-neutral-500 capitalize mt-0.5">{a.category}</p>
                          </div>
                          <Badge
                            variant="outline"
                            className={`text-xs ${a.status === "in_progress" ? "text-blue-400 border-blue-500/20" : "text-neutral-400 border-neutral-700"}`}
                          >
                            {a.status}
                          </Badge>
                        </div>
                        {a.dueAt && (
                          <div className="flex items-center gap-1 mt-2 text-xs text-neutral-500">
                            <Clock className="w-3 h-3" />
                            {t("pages:reviewer.portal.assignments.due", { date: new Date(a.dueAt).toLocaleDateString() })}
                          </div>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* Leaderboard */}
              <div>
                <h3 className="text-sm font-medium text-neutral-300 mb-3 flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-400" />
                  {t("pages:reviewer.portal.leaderboard.title")}
                </h3>
                <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
        {!leaderboard?.length ? (
                    <div className="p-6 text-center">
                      <p className="text-sm text-neutral-400">{t("pages:reviewer.portal.leaderboard.noReviewers")}</p>
                    </div>
                  ) : (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-neutral-800">
                          <th className="text-left text-xs font-medium text-neutral-500 uppercase px-3 py-2">{t("pages:reviewer.portal.leaderboard.headers.rank")}</th>
                          <th className="text-left text-xs font-medium text-neutral-500 uppercase px-3 py-2">{t("pages:reviewer.portal.leaderboard.headers.reviewer")}</th>
                          <th className="text-right text-xs font-medium text-neutral-500 uppercase px-3 py-2">{t("pages:reviewer.portal.leaderboard.headers.reviews")}</th>
                          <th className="text-right text-xs font-medium text-neutral-500 uppercase px-3 py-2">{t("pages:reviewer.portal.leaderboard.headers.points")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard.map((r, i) => (
                          <tr
                            key={r.userId}
                            className={`border-b border-neutral-800/50 last:border-0 ${r.userId === user?.id ? "bg-blue-500/5" : ""}`}
                          >
                            <td className="px-3 py-2.5">
                              {i === 0 ? (
                                <Trophy className="w-4 h-4 text-amber-400" />
                              ) : i === 1 ? (
                                <Trophy className="w-4 h-4 text-neutral-300" />
                              ) : i === 2 ? (
                                <Trophy className="w-4 h-4 text-orange-400" />
                              ) : (
                                <span className="text-sm text-neutral-500 pl-1">{i + 1}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-sm text-neutral-200">
                              {r.name ?? t("pages:reviewer.portal.leaderboard.reviewerId", { id: r.userId })}
                              {r.userId === user?.id && (
                                <span className="text-xs text-blue-400 ml-1.5">{t("pages:reviewer.portal.leaderboard.you")}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-sm text-neutral-300 text-right">{r.reviewsCompleted}</td>
                            <td className="px-3 py-2.5 text-sm text-amber-400 text-right font-medium">{r.pointsEarned ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    </AppShell>
  );
}
