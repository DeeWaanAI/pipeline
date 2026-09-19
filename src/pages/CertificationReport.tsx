import { useState } from "react";
import { useParams, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { useSeo } from "@/hooks/useSeo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Hexagon,
  ArrowLeft,
  ShieldCheck,
  Users,
  Star,
  Copy,
  Check,
  Loader2,
} from "lucide-react";

const DIMENSION_KEYS = [
  "accuracy",
  "completeness",
  "clarity",
  "tokenEfficiency",
  "speed",
  "consistency",
] as const;

function gradeColor(grade: number): string {
  if (grade >= 4.5) return "text-green-400";
  if (grade >= 4.0) return "text-lime-400";
  if (grade >= 3.5) return "text-yellow-400";
  return "text-red-400";
}

export default function CertificationReportPage() {
  const { t, i18n } = useTranslation("certification");
  const { id } = useParams<{ id: string }>();
  const listingId = Number(id);
  const [copied, setCopied] = useState(false);

  const { data: report, isLoading, error } = trpc.certification.report.useQuery(
    { listingId },
    { enabled: Number.isInteger(listingId) && listingId > 0, retry: false },
  );

  useSeo({
    title: report
      ? `${report.title} — ${t("title")} | AI Swarm Studio`
      : `${t("title")} | AI Swarm Studio`,
    description: report?.description ?? undefined,
    path: `/certification/${listingId}`,
    jsonLd: report
      ? {
          "@context": "https://schema.org",
          "@type": "Product",
          name: report.title,
          description: report.description ?? undefined,
          category: report.category,
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: report.grade,
            bestRating: 5,
            reviewCount: report.reviewCount,
          },
        }
      : undefined,
  });

  const badgeUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/certification/${listingId}/badge.svg`
      : "";
  const badgeMarkdown = `[![AI Swarm Certified](${badgeUrl})](${typeof window !== "undefined" ? window.location.href : ""})`;

  const copyBadge = async () => {
    try {
      await navigator.clipboard.writeText(badgeMarkdown);
      setCopied(true);
      toast.success(t("badge.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(badgeMarkdown);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <header className="border-b border-neutral-800 bg-neutral-900/50">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Hexagon className="h-6 w-6 text-blue-500" />
            <span className="font-semibold">AI Swarm Studio</span>
          </div>
          <Link
            to="/marketplace"
            className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-200"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("backToMarketplace")}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        {isLoading && (
          <div className="flex items-center justify-center py-20 text-neutral-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            {t("loading")}
          </div>
        )}

        {(error || (!isLoading && !report)) && (
          <div className="py-20 text-center text-neutral-500">{t("notFound")}</div>
        )}

        {report && (
          <div className="space-y-8">
            {/* Title + grade hero */}
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="border-green-500/30 bg-green-500/10 text-green-400"
                  >
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                    {t("certified")}
                  </Badge>
                  <Badge variant="outline" className="border-neutral-700 text-neutral-400">
                    {report.category}
                  </Badge>
                </div>
                <h1 className="text-2xl font-semibold tracking-tight">{report.title}</h1>
                {report.description && (
                  <p className="max-w-2xl text-sm text-neutral-400">{report.description}</p>
                )}
              </div>

              <div className="shrink-0 rounded-2xl border border-neutral-800 bg-neutral-900/60 px-8 py-5 text-center">
                <div className={`text-4xl font-bold ${gradeColor(report.grade ?? 0)}`}>
                  {(report.grade ?? 0).toFixed(2)}
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  {t("grade")} · {t("outOf")}
                </div>
                <img
                  src={badgeUrl}
                  alt={`AI Swarm Certified ${(report.grade ?? 0).toFixed(2)} / 5`}
                  className="mx-auto mt-3"
                  width={190}
                  height={20}
                />
              </div>
            </div>

            {/* Stats row */}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
                <div className="flex items-center gap-2 text-sm text-neutral-400">
                  <Star className="h-4 w-4" />
                  {t("kappa")}
                </div>
                <div className="mt-1 text-xl font-semibold">
                  {(report.kappaScore ?? 0).toFixed(3)}
                </div>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
                <div className="flex items-center gap-2 text-sm text-neutral-400">
                  <Users className="h-4 w-4" />
                  {t("reviewers")}
                </div>
                <div className="mt-1 text-xl font-semibold">{report.uniqueReviewers}</div>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
                <div className="flex items-center gap-2 text-sm text-neutral-400">
                  <ShieldCheck className="h-4 w-4" />
                  {t("reviews")}
                </div>
                <div className="mt-1 text-xl font-semibold">{report.reviewCount}</div>
              </div>
            </div>

            {/* Dimensions */}
            <section>
              <h2 className="text-lg font-medium">{t("dimensions.title")}</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {DIMENSION_KEYS.map((key) => {
                  const value = report.dimensions[key] ?? 0;
                  return (
                    <div
                      key={key}
                      className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4"
                    >
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-neutral-400">{t(`dimensions.${key}`)}</span>
                        <span className="font-medium">{value.toFixed(2)}</span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
                        <div
                          className="h-full rounded-full bg-blue-500"
                          style={{ width: `${Math.min(100, (value / 5) * 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Methodology */}
            <section className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-5">
              <h2 className="text-sm font-medium">{t("methodology.title")}</h2>
              <p className="mt-2 text-sm text-neutral-400">{t("methodology.body")}</p>
            </section>

            {/* Badge embed */}
            <section>
              <h2 className="text-lg font-medium">{t("badge.title")}</h2>
              <p className="mt-1 text-sm text-neutral-500">{t("badge.hint")}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-2.5 font-mono text-xs text-neutral-300">
                  {badgeMarkdown}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyBadge}
                  className="shrink-0 border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                >
                  {copied ? (
                    <Check className="mr-1.5 h-4 w-4 text-green-400" />
                  ) : (
                    <Copy className="mr-1.5 h-4 w-4" />
                  )}
                  {copied ? t("badge.copied") : t("badge.copy")}
                </Button>
              </div>
            </section>
          </div>
        )}
      </main>

      <footer className="border-t border-neutral-800 py-6 text-center text-xs text-neutral-600">
        AI Swarm Studio · {new Date(report?.certifiedAt ?? Date.now()).getFullYear()} ·{" "}
        {i18n.language.startsWith("zh") ? "认证报告" : "Certification Report"}
      </footer>
    </div>
  );
}
