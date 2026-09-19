import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  ArrowLeft,
  ChevronRight,
  ChevronLeft,
  Star,
  Loader2,
  Send,
  Check,
  Timer,
  FileText,
  Layers,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

const DIMENSIONS = [
  { key: "accuracy", labelKey: "reviewer.review.dimensions.accuracy", descKey: "reviewer.review.dimensions.accuracyDesc", weight: "30%" },
  { key: "completeness", labelKey: "reviewer.review.dimensions.completeness", descKey: "reviewer.review.dimensions.completenessDesc", weight: "20%" },
  { key: "clarity", labelKey: "reviewer.review.dimensions.clarity", descKey: "reviewer.review.dimensions.clarityDesc", weight: "15%" },
  { key: "tokenEfficiency", labelKey: "reviewer.review.dimensions.tokenEfficiency", descKey: "reviewer.review.dimensions.tokenEfficiencyDesc", weight: "10%" },
  { key: "speed", labelKey: "reviewer.review.dimensions.speed", descKey: "reviewer.review.dimensions.speedDesc", weight: "10%" },
  { key: "consistency", labelKey: "reviewer.review.dimensions.consistency", descKey: "reviewer.review.dimensions.consistencyDesc", weight: "15%" },
];

export default function ReviewerReview() {
  const { t } = useTranslation("pages");
  const { listingId } = useParams<{ listingId: string }>();
  const id = Number(listingId);
  const startTime = useRef(Date.now());

  const [currentIndex, setCurrentIndex] = useState(0);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showTraces, setShowTraces] = useState(false);

  const { data: prompts, isLoading } = trpc.marketplace.getAssignmentPrompts.useQuery(
    { listingId: id },
    { enabled: !isNaN(id) },
  );

  const submitMutation = trpc.marketplace.submitReview.useMutation({
    onSuccess: () => {
      setSubmitted(true);
      setSubmitting(false);
    },
  });

  const currentPrompt = prompts?.[currentIndex];
  const totalPrompts = prompts?.length ?? 0;

  // Fetch intermediate traces for current prompt (if available)
  const { data: intermediateTraces } = trpc.marketplace.getIntermediateForReviewer.useQuery(
    { testPromptId: currentPrompt?.id ?? 0 },
    { enabled: !!currentPrompt?.id && submitted, },
  );

  const handleScoreChange = (dimension: string, value: number[]) => {
    setScores((prev) => ({ ...prev, [dimension]: value[0] }));
  };

  const handleSubmit = () => {
    if (!currentPrompt) return;
    // Check all dimensions have scores
    for (const dim of DIMENSIONS) {
      if (scores[dim.key] === undefined) {
        alert(t("pages:reviewer.review.alertRateDimension", { dimension: t(dim.labelKey) }));
        return;
      }
    }

    setSubmitting(true);
    const reviewTime = Math.floor((Date.now() - startTime.current) / 1000);

    submitMutation.mutate({
      listingId: id,
      promptIndex: currentPrompt.promptIndex,
      accuracy: scores.accuracy ?? 3,
      completeness: scores.completeness ?? 3,
      clarity: scores.clarity ?? 3,
      tokenEfficiency: scores.tokenEfficiency ?? 3,
      speed: scores.speed ?? 3,
      consistency: scores.consistency ?? 3,
      reviewTime: Math.max(reviewTime, 3), // minimum 3 seconds
    });
  };

  const handleNext = () => {
    if (currentIndex < totalPrompts - 1) {
      setCurrentIndex((prev) => prev + 1);
      setScores({});
      setSubmitted(false);
      startTime.current = Date.now();
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
      setScores({});
      setSubmitted(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (!prompts?.length) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center">
        <div className="text-center">
          <Star className="w-10 h-10 text-neutral-600 mx-auto mb-3" />
          <h2 className="text-lg font-medium text-neutral-300">{t("pages:reviewer.review.noPrompts")}</h2>
          <p className="text-sm text-neutral-500 mt-1">{t("pages:reviewer.review.noPromptsDesc")}</p>
          <Link
            to="/reviewer/portal"
            className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 mt-4"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("pages:reviewer.review.backToPortal")}
          </Link>
        </div>
      </div>
    );
  }

  const progress = ((currentIndex + 1) / totalPrompts) * 100;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-900/50">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <Link
            to="/reviewer/portal"
            className="inline-flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-100 transition-colors mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("pages:reviewer.review.backToPortal")}
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Star className="w-6 h-6 text-amber-400" />
              <h1 className="text-xl font-bold text-neutral-100">{t("pages:reviewer.review.title")}</h1>
            </div>
            <div className="flex items-center gap-2 text-sm text-neutral-400">
              <span className="text-neutral-200 font-medium">{currentIndex + 1}</span>
              <span>/</span>
              <span>{totalPrompts}</span>
            </div>
          </div>
          {/* Progress bar */}
          <div className="w-full h-1.5 bg-neutral-800 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-amber-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6">
        {/* Input Card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-400 capitalize">
              {currentPrompt?.category}
            </Badge>
            {currentPrompt?.reviewed && (
              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">
                <Check className="w-3 h-3 mr-1" />
                {t("pages:reviewer.review.reviewed")}
              </Badge>
            )}
          </div>
          <h3 className="text-sm font-medium text-neutral-300 mb-2">{t("pages:reviewer.review.testInput")}</h3>
          <p className="text-sm text-neutral-100 leading-relaxed bg-neutral-800/30 rounded-lg p-4 border border-neutral-700/50">
            {currentPrompt?.inputText}
          </p>
        </div>

        {/* Output Card — REAL pipeline output */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5 mb-4">
          <h3 className="text-sm font-medium text-blue-300 mb-2 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" />
            {t("pages:reviewer.review.pipelineOutput")}
          </h3>
          <p className="text-sm text-neutral-100 leading-relaxed bg-blue-500/5 rounded-lg p-4 border border-blue-500/10 whitespace-pre-wrap font-mono text-xs max-h-64 overflow-y-auto">
            {currentPrompt?.actualOutput ?? t("pages:reviewer.review.noOutput")}
          </p>
          <p className="text-xs text-blue-400/60 mt-2">
            {t("pages:reviewer.review.outputNote")}
          </p>
        </div>

        {/* Intermediate Step Traces — helps reviewers understand pipeline internals */}
        {currentPrompt?.id && (
          <div className="mb-6">
            <button
              onClick={() => setShowTraces(!showTraces)}
              className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              <Layers className="w-3.5 h-3.5" />
              {showTraces ? t("pages:reviewer.review.hideTraces") : t("pages:reviewer.review.showTraces")}
              {showTraces ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {showTraces && (
              <div className="mt-2 space-y-2">
                {intermediateTraces && intermediateTraces.length > 0 ? (
                  intermediateTraces.map((trace) => (
                    <div key={trace.id} className="bg-neutral-800/30 rounded-lg border border-neutral-800 p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-medium text-neutral-400">
                          {t("pages:reviewer.review.stepLabel", { index: trace.stepIndex + 1, name: trace.stepName })}
                        </span>
                        <div className="flex items-center gap-2">
                          {trace.tokensUsed !== null && (
                            <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500">
                              {trace.tokensUsed} {t("pages:reviewer.review.tokens")}
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500">
                            {trace.latencyMs}ms
                          </Badge>
                        </div>
                      </div>
                      <div className="text-xs text-neutral-500 bg-neutral-900/50 rounded p-2 line-clamp-1 mb-1.5">
                        <span className="font-medium">{t("pages:reviewer.review.input")}</span> {trace.inputText?.slice(0, 150)}
                        {trace.inputText && trace.inputText.length > 150 ? "..." : ""}
                      </div>
                      <div className="text-xs text-neutral-300 bg-blue-500/5 rounded p-2 border border-blue-500/10 whitespace-pre-wrap font-mono line-clamp-3">
                        <span className="text-blue-400 font-medium">{t("pages:reviewer.review.output")}</span> {trace.outputText?.slice(0, 200)}
                        {trace.outputText && trace.outputText.length > 200 ? "..." : ""}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-neutral-600 italic">
                    {submitted
                      ? t("pages:reviewer.review.noTracesSubmitted")
                      : t("pages:reviewer.review.submitToLoadTraces")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {submitted ? (
          /* Submitted state */
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-emerald-400" />
            </div>
            <h3 className="text-lg font-medium text-emerald-400 mb-2">{t("pages:reviewer.review.reviewSubmitted")}</h3>
            <p className="text-sm text-neutral-400 mb-6">
              {t("pages:reviewer.review.weightedScore", { score: submitMutation.data?.weightedScore ?? "calculated" })}
            </p>
            <div className="flex items-center justify-center gap-3">
              {currentIndex > 0 && (
                <Button variant="outline" onClick={handlePrev} className="border-neutral-700 text-neutral-300">
                  <ChevronLeft className="w-4 h-4 mr-1.5" />
                  {t("pages:reviewer.review.previous")}
                </Button>
              )}
              {currentIndex < totalPrompts - 1 && (
                <Button onClick={handleNext} className="bg-blue-600 hover:bg-blue-700">
                  {t("pages:reviewer.review.nextPrompt")}
                  <ChevronRight className="w-4 h-4 ml-1.5" />
                </Button>
              )}
              {currentIndex === totalPrompts - 1 && (
                <Link to="/reviewer/portal">
                  <Button className="bg-emerald-600 hover:bg-emerald-700">
                    {t("pages:reviewer.review.done")}
                    <Check className="w-4 h-4 ml-1.5" />
                  </Button>
                </Link>
              )}
            </div>
          </div>
        ) : (
          /* Rating Sliders */
          <div className="space-y-4 mb-6">
            {DIMENSIONS.map((dim) => (
              <div key={dim.key} className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="text-sm font-medium text-neutral-200">{t(dim.labelKey)}</span>
                    <span className="text-xs text-neutral-500 ml-2">({dim.weight})</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                    <span className="text-lg font-bold text-neutral-100">
                      {scores[dim.key] ?? "—"}
                    </span>
                    <span className="text-xs text-neutral-500">/5</span>
                  </div>
                </div>
                <p className="text-xs text-neutral-500 mb-3">{t(dim.descKey)}</p>
                <Slider
                  value={[scores[dim.key] ?? 3]}
                  onValueChange={(v) => handleScoreChange(dim.key, v)}
                  min={1}
                  max={5}
                  step={1}
                  className="w-full"
                />
                <div className="flex justify-between mt-1.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => handleScoreChange(dim.key, [n])}
                      className={`text-xs px-2 py-0.5 rounded transition-colors ${
                        scores[dim.key] === n
                          ? "bg-amber-500/20 text-amber-400"
                          : "text-neutral-600 hover:text-neutral-400"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Footer actions */}
        {!submitted && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Timer className="w-3.5 h-3.5" />
              <span>{t("pages:reviewer.review.qualityOverSpeed")}</span>
            </div>
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-1.5" />
              )}
              {t("pages:reviewer.review.submitReview")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
