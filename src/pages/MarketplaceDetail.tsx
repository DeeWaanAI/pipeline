import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/layout/AppShell";
import { ListingStatusBadge } from "@/components/marketplace/ListingStatusBadge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Store,
  Star,
  ShoppingCart,
  ArrowLeft,
  Check,
  Loader2,
  Shield,
  ShieldAlert,
  Users,
  Award,
  Sparkles,
} from "lucide-react";

export default function MarketplaceDetail() {
  const { t } = useTranslation("pages");
  const { id } = useParams<{ id: string }>();
  const listingId = Number(id);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [purchasing, setPurchasing] = useState(false);

  const { data: listing, isLoading } = trpc.marketplace.getById.useQuery(
    { id: listingId },
    { enabled: !isNaN(listingId) },
  );

  const { data: purchaseCheck } = trpc.marketplace.checkPurchase.useQuery(
    { listingId },
    { enabled: !!user && !isNaN(listingId) },
  );

  const forkMutation = trpc.marketplace.forkListing.useMutation({
    onSuccess: (data) => {
      setPurchasing(false);
      toast.success(t("pages:marketplace.detail.forkSuccess", { name: data.projectName }));
    },
    onError: (err) => {
      setPurchasing(false);
      toast.error(err.message);
    },
  });

  const handlePurchase = () => {
    if (!user) {
      navigate("/");
      return;
    }
    setPurchasing(true);
    forkMutation.mutate({ listingId });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center">
        <div className="text-center">
          <Store className="w-12 h-12 text-neutral-600 mx-auto mb-3" />
          <h2 className="text-lg font-medium text-neutral-300">{t("pages:marketplace.detail.notFound")}</h2>
        </div>
      </div>
    );
  }

  const isOwner = user?.id === listing.creatorId;
  const hasPurchased = purchaseCheck?.purchased;
  // Published evidence anyone can inspect — seller records first (the list is
  // newest-first, and a seller publication always precedes its comments).
  const { data: publications } = trpc.marketplace.listListingEvidence.useQuery(
    { listingId: Number(listingId ?? 0) },
    { enabled: !!listingId },
  );
  const isCertifying = listing.status === "certifying";

  return (
    <AppShell>
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <div className="border-b border-neutral-800 bg-neutral-900/50">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <Link
            to="/marketplace"
            className="inline-flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-100 transition-colors mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("pages:marketplace.detail.backToMarketplace")}
          </Link>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-400 capitalize">
                  {listing.category}
                </Badge>
                <ListingStatusBadge status={listing.status} />
                {listing.grade && (
                  <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">
                    <Star className="w-3 h-3 mr-1 fill-amber-400" />
                    {listing.grade}/5
                  </Badge>
                )}
              </div>
              <h1 className="text-2xl font-bold text-neutral-100">{listing.title}</h1>
              <p className="text-sm text-neutral-400 mt-1">
                {t("pages:marketplace.detail.by", { name: listing.creatorName })}
              </p>
            </div>
            <div className="text-right">
              <span className="text-3xl font-bold text-emerald-400">{t("pages:marketplace.detail.freeLabel")}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Description */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
              <h3 className="text-sm font-medium text-neutral-300 mb-2">{t("pages:marketplace.detail.aboutPipeline")}</h3>
              <p className="text-sm text-neutral-400 leading-relaxed">
                {listing.description || t("pages:marketplace.detail.noDescription")}
              </p>
            </div>

            {/* Quality Stats */}
            {/* Published evidence — what anyone can inspect before buying. */}
            {(publications?.length ?? 0) > 0 && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
                <h3 className="text-sm font-medium text-neutral-300 mb-1">{t("pages:marketplace.detail.evidenceTitle")}</h3>
                <p className="mb-3 text-xs text-neutral-500">{t("pages:marketplace.detail.evidenceNote")}</p>
                <ul className="space-y-2">
                  {publications!.map((p) => (
                    <li key={p.publicationId} className="rounded-lg border border-neutral-800 bg-neutral-800/30 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-neutral-300">
                          {p.publicationKind === "seller"
                            ? t("pages:marketplace.detail.evidenceSeller")
                            : t("pages:marketplace.detail.evidenceCommunity")}
                          {" · v"}{p.workflowVersionNumber}
                          {" · "}{p.caseCount}{t("pages:marketplace.detail.evidenceCases")}
                        </span>
                        {p.state === "withdrawn" ? (
                          <span className="text-[11px] text-amber-400">{t("pages:marketplace.detail.evidenceWithdrawn")}</span>
                        ) : (
                          <Link to={`/evidence/${p.manifestHash}`} className="text-xs text-blue-400 hover:text-blue-300 underline">
                            {t("pages:marketplace.detail.evidenceOpen")}
                          </Link>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-neutral-600">
                        {p.provenance === "platform_recorded"
                          ? t("pages:marketplace.detail.evidencePlatformRecorded")
                          : t("pages:marketplace.detail.evidenceUserReported")}
                        {" · "}{new Date(p.testedAt).toLocaleDateString()}
                        {p.disclosureClass === "limited" && ` · ${t("pages:marketplace.detail.evidenceLimited")}`}
                        {p.testedModels.length > 0 && ` · ${p.testedModels.join(", ")}`}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Legacy certification numbers. `grade`, `reviewCount` and `kappaScore`
                are the retired five-human-reviewers pipeline's output; a v2 listing
                is published on its evidence record instead, so this block only ever
                describes old work and says so. */}
            {(listing.grade || listing.kappaScore) && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
                <h3 className="text-sm font-medium text-neutral-300 mb-1">{t("pages:marketplace.detail.qualityVerification")}</h3>
                <p className="mb-4 text-[11px] text-neutral-500">{t("pages:marketplace.detail.legacyCertificationNote")}</p>
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center p-3 bg-neutral-800/50 rounded-lg">
                    <Star className="w-5 h-5 text-amber-400 mx-auto mb-1" />
                    <div className="text-lg font-bold text-neutral-100">{listing.grade}/5</div>
                    <div className="text-xs text-neutral-500">{t("pages:marketplace.detail.grade")}</div>
                  </div>
                  <div className="text-center p-3 bg-neutral-800/50 rounded-lg">
                    <Users className="w-5 h-5 text-blue-400 mx-auto mb-1" />
                    <div className="text-lg font-bold text-neutral-100">{listing.reviewCount}</div>
                    <div className="text-xs text-neutral-500">{t("pages:marketplace.detail.reviewsCount")}</div>
                  </div>
                  <div className="text-center p-3 bg-neutral-800/50 rounded-lg">
                    <Award className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
                    <div className="text-lg font-bold text-neutral-100">{listing.kappaScore}</div>
                    <div className="text-xs text-neutral-500">{t("pages:marketplace.detail.kappa")}</div>
                  </div>
                </div>
                {listing.kappaScore && parseFloat(String(listing.kappaScore)) > 0.75 && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 rounded-md px-3 py-2">
                    <Shield className="w-3.5 h-3.5" />
                    <span>{t("pages:marketplace.detail.excellentReliability")}</span>
                  </div>
                )}
                {listing.grade && (listing.status === "approved" || listing.status === "published") && (
                  <Link
                    to={`/certification/${listing.id}`}
                    className="mt-3 flex items-center justify-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 bg-blue-500/10 rounded-md px-3 py-2"
                  >
                    <Award className="w-3.5 h-3.5" />
                    {t("pages:marketplace.detail.viewCertification")}
                  </Link>
                )}
              </div>
            )}

            {/* Sample Prompts */}
            {listing.samplePrompts && listing.samplePrompts.length > 0 && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
                <h3 className="text-sm font-medium text-neutral-300 mb-4">{t("pages:marketplace.detail.sampleTestInputs")}</h3>
                <div className="space-y-2">
                  {listing.samplePrompts.map((sample) => (
                    <div
                      key={sample.promptIndex}
                      className="flex items-start gap-3 p-3 bg-neutral-800/30 rounded-md"
                    >
                      <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500 capitalize shrink-0 mt-0.5">
                        {sample.category}
                      </Badge>
                      <p className="text-sm text-neutral-400 line-clamp-2">{sample.inputText}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Purchase Card */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
              {hasPurchased ? (
                <div className="text-center">
                  <div className="w-12 h-12 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Check className="w-6 h-6 text-emerald-400" />
                  </div>
                  <h3 className="text-sm font-medium text-emerald-400 mb-1">{t("pages:marketplace.detail.youOwnThis")}</h3>
                  <p className="text-xs text-neutral-500 mb-3">{t("pages:marketplace.detail.createToUse")}</p>
                  <Link to="/?new=true">
                    <Button className="w-full bg-blue-600 hover:bg-blue-700">
                      <Sparkles className="w-4 h-4 mr-1.5" />
                      {t("pages:marketplace.detail.usePipeline")}
                    </Button>
                  </Link>
                </div>
              ) : (
                <>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-3xl font-bold text-emerald-400">{t("pages:marketplace.detail.freeLabel")}</span>
                  </div>
                  <p className="text-xs text-neutral-500 mb-4">{t("pages:marketplace.detail.freeNote")}</p>
                  <Button
                    className="w-full bg-blue-600 hover:bg-blue-700"
                    onClick={handlePurchase}
                    disabled={purchasing || isOwner || isCertifying}
                    title={isCertifying ? t("pages:marketplace.detail.certifyingNotice") : undefined}
                  >
                    {purchasing ? (
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    ) : isCertifying ? (
                      <ShieldAlert className="w-4 h-4 mr-1.5" />
                    ) : (
                      <ShoppingCart className="w-4 h-4 mr-1.5" />
                    )}
                    {isOwner ? t("pages:marketplace.detail.youCreatedThis") : purchasing ? t("pages:marketplace.detail.processing") : t("pages:marketplace.detail.forkNow")}
                  </Button>
                  {isCertifying && (
                    <div className="mt-3 rounded-md bg-blue-500/5 border border-blue-500/10 px-3 py-2.5">
                      <p className="text-xs text-blue-300 leading-relaxed">
                        {t("pages:marketplace.detail.certifyingNotice")}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Stats */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
              <h4 className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-3">{t("pages:marketplace.detail.statsTitle")}</h4>
              <div className="space-y-2.5">
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-400">{t("pages:marketplace.detail.reviewsCount")}</span>
                  <span className="text-neutral-200">{listing.reviewCount}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-400">{t("pages:marketplace.detail.grade")}</span>
                  <span className="text-neutral-200">{listing.grade ?? t("pages:marketplace.detail.gradePending")}/5</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-400">{t("pages:marketplace.detail.kappa")}</span>
                  <span className="text-neutral-200">{listing.kappaScore ?? t("pages:marketplace.detail.gradePending")}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </AppShell>
  );
}
