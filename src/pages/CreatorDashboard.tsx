import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tag,
  Plus,
  Eye,
  Send,
  Loader2,
  Star,
  BarChart3,
  Sparkles,
  CheckCircle,
  ClipboardList,
  AlertTriangle,
  FileText,
  ChevronDown,
  ChevronUp,
  Clock,
  Play,
  TestTube,
  Layers,
  AlignLeft,
  MessageSquare,
  GitBranch,
  Trash2,
  Bug,
  CloudOff,
} from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-neutral-800 text-neutral-400 border-neutral-700",
  generating: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  pending_review: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  reviewing: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  rejected: "bg-red-500/10 text-red-400 border-red-500/20",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  published: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  unpublished: "bg-neutral-800 text-neutral-500 border-neutral-700",
};

// Sub-component: debug view — shows raw DB state
function DebugListing({ listingId }: { listingId: number }) {
  const { t } = useTranslation("pages");
  const [show, setShow] = useState(false);
  const { data, isLoading } = trpc.marketplace.debugListing.useQuery(
    { listingId },
    { enabled: show }
  );

  return (
    <div>
      <button
        onClick={() => setShow(!show)}
        className="text-xs text-neutral-600 hover:text-neutral-400 flex items-center gap-1"
      >
        <Bug className="w-3 h-3" />
        {show ? t("pages:marketplace.creator.debug.hideDebug") : t("pages:marketplace.creator.debug.showDebug")}
      </button>
      {show && (
        <div className="mt-2 bg-neutral-950 rounded border border-neutral-800 p-3 font-mono text-xs overflow-x-auto">
          {isLoading ? (
            <span className="text-neutral-500">{t("pages:marketplace.creator.debug.loading")}</span>
          ) : data?.error ? (
            <span className="text-red-400">{data.error}</span>
          ) : (
            <div className="space-y-1 text-neutral-400">
              <div>{t("pages:marketplace.creator.debug.status")} <span className="text-neutral-200">{data?.listingStatus}</span></div>
              <div>{t("pages:marketplace.creator.debug.totalPrompts")} <span className="text-neutral-200">{data?.promptCount}</span></div>
              <div>{t("pages:marketplace.creator.debug.withOutput")} <span className="text-emerald-400">{data?.promptsWithOutput}</span></div>
              <div>{t("pages:marketplace.creator.debug.generating")} <span className="text-yellow-400">{data?.promptsGenerating}</span></div>
              <div>{t("pages:marketplace.creator.debug.withError")} <span className="text-red-400">{data?.promptsWithError}</span></div>
              <div>{t("pages:marketplace.creator.debug.intermediates")} <span className="text-neutral-200">{data?.intermediateCount}</span></div>
              {data?.raw && data.raw.length > 0 && (
                <div className="mt-2 pt-2 border-t border-neutral-800">
                  {data.raw.map((p: any) => (
                    <div key={p.id} className="flex gap-2">
                      <span className="text-neutral-500">#{p.promptIndex}</span>
                      <span className="text-neutral-500">{p.hasOutput ? "Y" : "N"}</span>
                      <span className="text-neutral-500">len={p.outputLength}</span>
                      <span className="text-neutral-500 truncate">{p.inputText?.slice(0, 30)}...</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Sub-component: shows actual test prompts for a listing
function TestPromptsList({ listingId }: { listingId: number }) {
  const { t } = useTranslation("pages");
  const { data: prompts, isLoading } = trpc.marketplace.getTestPrompts.useQuery({ listingId });
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (isLoading) return <div className="text-xs text-neutral-500 py-2">{t("pages:marketplace.creator.testPrompts.loading")}</div>;
  if (!prompts?.length) return <div className="text-xs text-neutral-500 py-2">{t("pages:marketplace.creator.testPrompts.none")}</div>;

  return (
    <div>
      <h4 className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <FileText className="w-3.5 h-3.5" />
        {t("pages:marketplace.creator.testPrompts.title", { count: prompts.length })}
      </h4>
      <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
        {prompts.map((p, i) => (
          <div key={p.id} className="bg-neutral-800/30 rounded-md border border-neutral-800 overflow-hidden">
            <button
              onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
              className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-neutral-800/50 transition-colors"
            >
              <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500 capitalize shrink-0 mt-0.5">
                {p.category}
              </Badge>
              <span className="text-xs text-neutral-300 line-clamp-1 flex-1">{p.inputText}</span>
              {expandedIdx === i ? (
                <ChevronUp className="w-3 h-3 text-neutral-500 shrink-0 mt-0.5" />
              ) : (
                <ChevronDown className="w-3 h-3 text-neutral-500 shrink-0 mt-0.5" />
              )}
            </button>
            {expandedIdx === i && (
              <div className="px-3 pb-3 space-y-2">
                <div className="text-xs text-neutral-400 bg-neutral-800/50 rounded p-2">
                  <span className="text-neutral-500 font-medium">{t("pages:marketplace.creator.testPrompts.input")}</span> {p.inputText}
                </div>
                {p.actualOutput && (
                  <div className="text-xs text-neutral-100 bg-blue-500/5 rounded p-2 border border-blue-500/10 whitespace-pre-wrap font-mono">
                    <span className="text-blue-400 font-medium">{t("pages:marketplace.creator.testPrompts.pipelineOutput")}</span>{" "}
                    {p.actualOutput.length > 200 ? p.actualOutput.slice(0, 200) + "..." : p.actualOutput}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Single listing row with expanded review details
function ListingRow({ listing, onSelfTest, onSubmitWarning }: { listing: { id: number; title: string; description: string | null; category: string | null; price: string; status: string | null; grade: string | null; reviewCount: number | null; salesCount: number | null; createdAt: Date | null }; onSelfTest?: (listingId: number) => void; onSubmitWarning?: (warning: string) => void }) {
  const { t } = useTranslation("pages");
  const [expanded, setExpanded] = useState(false);

  const submitMutation = trpc.marketplace.submitForReview.useMutation({
    onSuccess: (data) => {
      if (data.giteeWarning) {
        onSubmitWarning?.(data.giteeWarning);
        // Reload after 8 seconds
        setTimeout(() => window.location.reload(), 8000);
      } else {
        window.location.reload();
      }
    },
  });

  const publishMutation = trpc.marketplace.publish.useMutation({
    onSuccess: () => window.location.reload(),
  });

  const calculateGradeMutation = trpc.marketplace.calculateGrade.useMutation({
    onSuccess: () => window.location.reload(),
  });

  const deleteMutation = trpc.marketplace.delete.useMutation({
    onSuccess: () => window.location.reload(),
  });

  const { data: reviewStats } = trpc.marketplace.getReviewStats.useQuery(
    { listingId: listing.id },
    { enabled: expanded && (listing.status === "pending_review" || listing.status === "reviewing" || listing.status === "approved"), refetchInterval: 5000 }
  );

  // Poll generation status when listing is generating
  const { data: genStatus } = trpc.marketplace.getGenerationStatus.useQuery(
    { listingId: listing.id },
    { enabled: listing.status === "generating", refetchInterval: 3000 }
  );

  // Auto-reload when generation finishes
  if (genStatus && !genStatus.isGenerating && genStatus.isReady) {
    window.location.reload();
  }

  const { data: testPrompts } = trpc.marketplace.reviewProgress.useQuery(
    { listingId: listing.id },
    { enabled: expanded }
  );

  return (
    <>
      <tr className="border-b border-neutral-800/50 last:border-0 hover:bg-neutral-800/20">
        <td className="px-4 py-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-left w-full"
          >
            <div className="text-sm font-medium text-neutral-200 hover:text-blue-400 transition-colors">{listing.title}</div>
            <div className="text-xs text-neutral-500 capitalize">{listing.category}</div>
          </button>
        </td>
        <td className="px-4 py-3">
          <Badge variant="outline" className={`text-xs capitalize ${STATUS_COLORS[listing.status ?? ""] ?? ""}`}>
            {(listing.status ?? "").replace("_", " ")}
          </Badge>
        </td>
        <td className="px-4 py-3 text-sm text-neutral-300">${listing.price}</td>
        <td className="px-4 py-3 text-sm text-neutral-300">
          {listing.grade ? `${listing.grade}/5` : t("pages:marketplace.creator.table.pending")}
        </td>
        <td className="px-4 py-3 text-sm text-neutral-300">{listing.salesCount ?? 0}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1">
            {listing.status === "draft" && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-purple-400 hover:text-purple-300"
                  onClick={() => onSelfTest?.(listing.id)}
                >
                  <TestTube className="w-3 h-3 mr-1" />
                  {t("pages:marketplace.creator.actions.selfTest")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-blue-400 hover:text-blue-300"
                  onClick={() => submitMutation.mutate({ id: listing.id, giteeToken: localStorage.getItem("gitee_token") ?? undefined })}
                  disabled={submitMutation.isPending}
                >
                  <Send className="w-3 h-3 mr-1" />
                  {submitMutation.isPending ? t("pages:marketplace.creator.actions.generating") : t("pages:marketplace.creator.actions.submitForReview")}
                </Button>
              </div>
            )}

            {listing.status === "generating" && (
              <div className="flex items-center gap-2">
                <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
                <span className="text-xs text-purple-400">
                  {genStatus
                    ? t("pages:marketplace.creator.actions.generatingProgress", { generated: genStatus.generated, total: genStatus.totalPrompts })
                    : t("pages:marketplace.creator.actions.generatingData")}
                </span>
              </div>
            )}

            {listing.status === "pending_review" && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-yellow-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {t("pages:marketplace.creator.actions.pendingReviewers")}
                </span>
                {reviewStats && (
                  <span className="text-xs text-neutral-500">
                    ({reviewStats.uniqueReviewers} {t("pages:marketplace.creator.actions.enrolled")})
                  </span>
                )}
              </div>
            )}

            {(listing.status === "pending_review" || listing.status === "reviewing") && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-amber-400 hover:text-amber-300"
                onClick={() => calculateGradeMutation.mutate({ listingId: listing.id })}
                disabled={calculateGradeMutation.isPending || (reviewStats ? !reviewStats.canCalculateGrade : true)}
                title={reviewStats?.message ?? "Waiting for review reports"}
              >
                <Sparkles className="w-3 h-3 mr-1" />
                {calculateGradeMutation.isPending ? t("pages:marketplace.creator.actions.calculating") : t("pages:marketplace.creator.actions.calculateGrade")}
              </Button>
            )}

            {listing.status === "approved" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-emerald-400 hover:text-emerald-300"
                onClick={() => publishMutation.mutate({ id: listing.id })}
                disabled={publishMutation.isPending}
              >
                <CheckCircle className="w-3 h-3 mr-1" />
                {publishMutation.isPending ? t("pages:marketplace.creator.actions.publishing") : t("pages:marketplace.creator.actions.publish")}
              </Button>
            )}

            {listing.status === "published" && (
              <span className="text-xs text-emerald-400 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                {t("pages:marketplace.creator.actions.live")}
              </span>
            )}

            {/* Delete button — available for all non-generating statuses */}
            {listing.status !== "generating" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-red-400/60 hover:text-red-400"
                onClick={() => {
                  if (confirm(t("pages:marketplace.creator.actions.deleteConfirm"))) {
                    deleteMutation.mutate({ id: listing.id });
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded review details */}
      {expanded && (
        <tr>
          <td colSpan={6} className="px-4 py-4 bg-neutral-900/30 border-b border-neutral-800">
            <div className="space-y-4">
              {/* Review Stats */}
              {reviewStats && (
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-neutral-100">{reviewStats.totalPrompts}</div>
                    <div className="text-xs text-neutral-500">{t("pages:marketplace.creator.reviewStats.testPrompts")}</div>
                  </div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-neutral-100">{reviewStats.uniqueReviewers}</div>
                    <div className="text-xs text-neutral-500">{t("pages:marketplace.creator.reviewStats.reviewers")}</div>
                  </div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-blue-400">{reviewStats.completedReviews}</div>
                    <div className="text-xs text-neutral-500">{t("pages:marketplace.creator.reviewStats.reviewsSubmitted")}</div>
                  </div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-center">
                    <div className={`text-lg font-bold ${reviewStats.canCalculateGrade ? "text-emerald-400" : "text-yellow-400"}`}>
                      {reviewStats.canCalculateGrade ? t("pages:marketplace.creator.reviewStats.ready") : t("pages:marketplace.creator.reviewStats.waiting")}
                    </div>
                    <div className="text-xs text-neutral-500">{t("pages:marketplace.creator.reviewStats.gradeStatus")}</div>
                  </div>
                </div>
              )}

              {!reviewStats?.canCalculateGrade && reviewStats && (
                <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-500/10 rounded-md px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{reviewStats.message}</span>
                </div>
              )}

              {/* Test Prompts — always show when expanded, component handles empty state */}
              <TestPromptsList listingId={listing.id} />

              {/* Debug: raw DB state */}
              <DebugListing listingId={listing.id} />

              {/* Assignment Status */}
              {testPrompts && testPrompts.assignments.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <ClipboardList className="w-3.5 h-3.5" />
                    {t("pages:marketplace.creator.assignments.title", { count: testPrompts.assignments.length })}
                  </h4>
                  <div className="space-y-1.5">
                    {testPrompts.assignments.map((a, i) => (
                      <div key={i} className="flex items-center justify-between text-sm bg-neutral-800/30 rounded-md px-3 py-1.5">
                        <span className="text-neutral-400">{t("pages:marketplace.creator.assignments.reviewerId", { id: a.reviewerId })}</span>
                        <Badge variant="outline" className={`text-xs capitalize ${a.status === "completed" ? "text-emerald-400 border-emerald-500/20" : a.status === "in_progress" ? "text-blue-400 border-blue-500/20" : "text-neutral-400 border-neutral-700"}`}>
                          {a.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function CreatorDashboard() {
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [objectives, setObjectives] = useState("");
  const [inputFormat, setInputFormat] = useState("");
  const [outputFormat, setOutputFormat] = useState("");
  const [remarks, setRemarks] = useState("");
  const [category, setCategory] = useState("other");
  const [price, setPrice] = useState("29");

  // Submit warning (Gitee token missing, etc.)
  const [submitWarning, setSubmitWarning] = useState<string | null>(null);

  // Self-test dialog state
  const [selfTestDialogOpen, setSelfTestDialogOpen] = useState(false);
  const [selfTestListingId, setSelfTestListingId] = useState<number | null>(null);
  const [selfTestInput, setSelfTestInput] = useState("");
  const [selfTestResult, setSelfTestResult] = useState<{
    finalOutput: string;
    stepCount: number;
    agentSteps: number;
    traces: Array<{
      stepIndex: number;
      stepName: string;
      stepRole: string;
      input: string;
      output: string;
      latencyMs: number;
      tokensUsed: number | null;
    }>;
    pipelineName: string;
  } | null>(null);

  const { t } = useTranslation("pages");

  const { data: listings, isLoading } = trpc.marketplace.myListings.useQuery();
  const { data: templates } = trpc.template.list.useQuery();

  const createMutation = trpc.marketplace.create.useMutation({
    onSuccess: () => {
      setSubmitDialogOpen(false);
      setSelectedTemplate("");
      setTitle("");
      setDescription("");
      setObjectives("");
      setInputFormat("");
      setOutputFormat("");
      setRemarks("");
      setPrice("29");
      window.location.reload();
    },
  });

  const selfTestMutation = trpc.marketplace.creatorSelfTest.useMutation({
    onSuccess: (data) => {
      setSelfTestResult(data);
    },
  });

  const handleCreate = () => {
    if (!selectedTemplate || !title || !price) return;
    createMutation.mutate({
      templateId: Number(selectedTemplate),
      title,
      description: description || undefined,
      objectives: objectives || undefined,
      inputFormat: inputFormat || undefined,
      outputFormat: outputFormat || undefined,
      remarks: remarks || undefined,
      category: category as "translation" | "writing" | "code" | "analysis" | "creative" | "other",
      price: Number(price),
    });
  };

  const handleSelfTest = () => {
    if (!selfTestListingId || !selfTestInput.trim()) return;
    setSelfTestResult(null);
    selfTestMutation.mutate({
      listingId: selfTestListingId,
      testInput: selfTestInput.trim(),
      giteeToken: localStorage.getItem("gitee_token") ?? undefined,
    });
  };

  return (
    <AppShell>
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-900/50">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Tag className="w-6 h-6 text-blue-400" />
              <h1 className="text-xl font-bold text-neutral-100">{t("pages:marketplace.creator.title")}</h1>
            </div>
            <Dialog open={submitDialogOpen} onOpenChange={setSubmitDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-1.5" />
                  {t("pages:marketplace.creator.newListing")}
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-neutral-900 border-neutral-800 text-neutral-100 max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-neutral-100">{t("pages:marketplace.creator.sellDialogTitle")}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 mt-2">
                  <div>
                    <label className="text-sm text-neutral-400 mb-1 block">{t("pages:marketplace.creator.pipelineTemplate")}</label>
                    <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                      <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100">
                        <SelectValue placeholder={t("pages:marketplace.creator.selectPipeline")} />
                      </SelectTrigger>
                      <SelectContent className="bg-neutral-900 border-neutral-700">
                        {templates?.map((tmpl) => (
                          <SelectItem key={tmpl.id} value={String(tmpl.id)} className="text-neutral-100">
                            {tmpl.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm text-neutral-400 mb-1 block">{t("pages:marketplace.creator.titleLabel")}</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100"
                      placeholder={t("pages:marketplace.creator.titlePlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="text-sm text-neutral-400 mb-1 block">{t("pages:marketplace.creator.descriptionLabel")}</label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 min-h-[80px]"
                      placeholder={t("pages:marketplace.creator.descriptionPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="text-sm text-neutral-400 mb-1 block flex items-center gap-1">
                      <Layers className="w-3.5 h-3.5" />
                      {t("pages:marketplace.creator.objectivesLabel")}
                    </label>
                    <textarea
                      value={objectives}
                      onChange={(e) => setObjectives(e.target.value)}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 min-h-[60px]"
                      placeholder={t("pages:marketplace.creator.objectivesPlaceholder")}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm text-neutral-400 mb-1 block flex items-center gap-1">
                        <AlignLeft className="w-3.5 h-3.5" />
                        {t("pages:marketplace.creator.inputFormatLabel")}
                      </label>
                      <textarea
                        value={inputFormat}
                        onChange={(e) => setInputFormat(e.target.value)}
                        className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 min-h-[60px]"
                        placeholder={t("pages:marketplace.creator.inputFormatPlaceholder")}
                      />
                    </div>
                    <div>
                      <label className="text-sm text-neutral-400 mb-1 block flex items-center gap-1">
                        <GitBranch className="w-3.5 h-3.5" />
                        {t("pages:marketplace.creator.outputFormatLabel")}
                      </label>
                      <textarea
                        value={outputFormat}
                        onChange={(e) => setOutputFormat(e.target.value)}
                        className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 min-h-[60px]"
                        placeholder={t("pages:marketplace.creator.outputFormatPlaceholder")}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm text-neutral-400 mb-1 block flex items-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5" />
                      {t("pages:marketplace.creator.remarksLabel")}
                    </label>
                    <textarea
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 min-h-[60px]"
                      placeholder={t("pages:marketplace.creator.remarksPlaceholder")}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm text-neutral-400 mb-1 block">{t("pages:marketplace.creator.categoryLabel")}</label>
                      <Select value={category} onValueChange={setCategory}>
                        <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-neutral-900 border-neutral-700">
                          {["translation", "writing", "code", "analysis", "creative", "other"].map((c) => (
                            <SelectItem key={c} value={c} className="text-neutral-100 capitalize">
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm text-neutral-400 mb-1 block">{t("pages:marketplace.creator.priceLabel")}</label>
                      <input
                        type="number"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100"
                        min={0}
                        max={9999}
                      />
                    </div>
                  </div>
                  <Button
                    className="w-full bg-blue-600 hover:bg-blue-700"
                    onClick={handleCreate}
                    disabled={createMutation.isPending || !selectedTemplate || !title}
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    ) : (
                      <Tag className="w-4 h-4 mr-1.5" />
                    )}
                    {t("pages:marketplace.creator.createListing")}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Submit Warning Banner */}
      {submitWarning && (
        <div className="max-w-6xl mx-auto px-6 pt-4">
          <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3">
            <CloudOff className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs text-yellow-400 font-medium">{t("pages:marketplace.creator.giteeBackupSkipped")}</p>
              <p className="text-xs text-yellow-400/70 mt-0.5">{submitWarning}</p>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="max-w-6xl mx-auto px-6 py-4">
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
            <div className="flex items-center gap-2 text-neutral-500 mb-1">
              <BarChart3 className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider">{t("pages:marketplace.creator.stats.totalListings")}</span>
            </div>
            <div className="text-2xl font-bold text-neutral-100">{listings?.length ?? 0}</div>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
            <div className="flex items-center gap-2 text-neutral-500 mb-1">
              <Eye className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider">{t("pages:marketplace.creator.stats.published")}</span>
            </div>
            <div className="text-2xl font-bold text-neutral-100">
              {listings?.filter((l) => l.status === "published").length ?? 0}
            </div>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
            <div className="flex items-center gap-2 text-neutral-500 mb-1">
              <Star className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider">{t("pages:marketplace.creator.stats.avgGrade")}</span>
            </div>
            <div className="text-2xl font-bold text-neutral-100">
              {listings?.filter((l) => l.grade).length
                ? (listings!.filter((l) => l.grade).reduce((s, l) => s + parseFloat(String(l.grade)), 0) /
                   listings!.filter((l) => l.grade).length).toFixed(1)
                : "\u2014"}
            </div>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
            <div className="flex items-center gap-2 text-neutral-500 mb-1">
              <Tag className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider">{t("pages:marketplace.creator.stats.totalSales")}</span>
            </div>
            <div className="text-2xl font-bold text-neutral-100">
              {listings?.reduce((s, l) => s + (l.salesCount ?? 0), 0) ?? 0}
            </div>
          </div>
        </div>

        {/* Listings Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : !listings?.length ? (
          <div className="text-center py-16 bg-neutral-900 border border-neutral-800 rounded-lg">
            <Tag className="w-10 h-10 text-neutral-600 mx-auto mb-3" />
            <h3 className="text-base font-medium text-neutral-300">{t("pages:marketplace.creator.empty.title")}</h3>
            <p className="text-sm text-neutral-500 mt-1 mb-4">{t("pages:marketplace.creator.empty.desc")}</p>
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => setSubmitDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-1.5" />
              {t("pages:marketplace.creator.newListing")}
            </Button>
          </div>
        ) : (
          <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-800">
                  <th className="text-left text-xs font-medium text-neutral-500 uppercase px-4 py-3">{t("pages:marketplace.creator.table.pipeline")}</th>
                  <th className="text-left text-xs font-medium text-neutral-500 uppercase px-4 py-3">{t("pages:marketplace.creator.table.status")}</th>
                  <th className="text-left text-xs font-medium text-neutral-500 uppercase px-4 py-3">{t("pages:marketplace.creator.table.price")}</th>
                  <th className="text-left text-xs font-medium text-neutral-500 uppercase px-4 py-3">{t("pages:marketplace.creator.table.grade")}</th>
                  <th className="text-left text-xs font-medium text-neutral-500 uppercase px-4 py-3">{t("pages:marketplace.creator.table.sales")}</th>
                  <th className="text-left text-xs font-medium text-neutral-500 uppercase px-4 py-3">{t("pages:marketplace.creator.table.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {listings.map((listing) => (
                  <ListingRow
                    key={listing.id}
                    listing={listing}
                    onSelfTest={(id) => {
                      setSelfTestListingId(id);
                      setSelfTestInput("");
                      setSelfTestResult(null);
                      setSelfTestDialogOpen(true);
                    }}
                    onSubmitWarning={(w) => setSubmitWarning(w)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Self-Test Dialog */}
      <Dialog open={selfTestDialogOpen} onOpenChange={setSelfTestDialogOpen}>
        <DialogContent className="bg-neutral-900 border-neutral-800 text-neutral-100 max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-neutral-100 flex items-center gap-2">
              <TestTube className="w-5 h-5 text-purple-400" />
              {t("pages:marketplace.creator.selfTest.title")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <p className="text-xs text-neutral-400">
              {t("pages:marketplace.creator.selfTest.description")}
            </p>
            <div>
              <label className="text-sm text-neutral-400 mb-1 block">{t("pages:marketplace.creator.selfTest.testInputLabel")}</label>
              <textarea
                value={selfTestInput}
                onChange={(e) => setSelfTestInput(e.target.value)}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-sm text-neutral-100 min-h-[80px]"
                placeholder={t("pages:marketplace.creator.selfTest.testInputPlaceholder")}
              />
            </div>
            <Button
              className="w-full bg-purple-600 hover:bg-purple-700"
              onClick={handleSelfTest}
              disabled={selfTestMutation.isPending || !selfTestInput.trim()}
            >
              {selfTestMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-1.5" />
              )}
              {selfTestMutation.isPending ? t("pages:marketplace.creator.selfTest.running") : t("pages:marketplace.creator.selfTest.runTest")}
            </Button>

            {selfTestMutation.error && (
              <div className="text-xs text-red-400 bg-red-500/10 rounded-md px-3 py-2">
                Error: {selfTestMutation.error.message}
              </div>
            )}

            {selfTestResult && (
              <div className="space-y-3 border-t border-neutral-800 pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-neutral-500">{t("pages:marketplace.creator.selfTest.pipeline", { name: selfTestResult.pipelineName })}</span>
                  <span className="text-xs text-neutral-500">
                    {t("pages:marketplace.creator.selfTest.stepsExecuted", { agentSteps: selfTestResult.agentSteps, stepCount: selfTestResult.stepCount })}
                  </span>
                </div>

                {/* Step traces */}
                {selfTestResult.traces.map((trace) => (
                  <div key={trace.stepIndex} className="bg-neutral-800/30 rounded-lg border border-neutral-800 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-neutral-300">
                        {t("pages:marketplace.creator.selfTest.stepLabel", { index: trace.stepIndex + 1, name: trace.stepName })}
                      </span>
                      <div className="flex items-center gap-2">
                        {trace.tokensUsed !== null && (
                          <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500">
                            {trace.tokensUsed} {t("pages:marketplace.creator.selfTest.tokens")}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500">
                          {trace.latencyMs}ms
                        </Badge>
                      </div>
                    </div>
                    <div className="text-xs text-neutral-400 bg-neutral-900/50 rounded p-2 line-clamp-2">
                      <span className="text-neutral-500 font-medium">{t("pages:marketplace.creator.selfTest.input")}</span> {trace.input}
                    </div>
                    <div className="text-xs text-neutral-100 bg-blue-500/5 rounded p-2 border border-blue-500/10 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                      <span className="text-blue-400 font-medium">{t("pages:marketplace.creator.selfTest.output")}</span> {trace.output}
                    </div>
                  </div>
                ))}

                {/* Final output */}
                <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
                  <h4 className="text-xs font-medium text-emerald-400 mb-2">{t("pages:marketplace.creator.selfTest.finalOutput")}</h4>
                  <p className="text-sm text-neutral-100 whitespace-pre-wrap font-mono max-h-[50vh] overflow-y-auto">
                    {selfTestResult.finalOutput}
                  </p>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </AppShell>
  );
}
