import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useSeo } from "@/hooks/useSeo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Hexagon, Check, ArrowLeft, Loader2, Store } from "lucide-react";

const PLAN_IDS = ["solo", "team_seat"] as const;
const FEATURE_KEYS = ["feature1", "feature2", "feature3", "feature4"] as const;

export default function PricingPage() {
  const { t } = useTranslation("pricing");
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const { data, isLoading } = trpc.billing.listPlans.useQuery();
  const checkout = trpc.billing.createCheckout.useMutation({
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) => toast.error(err.message),
  });

  useSeo({
    title: `${t("title")} | AI Swarm Studio`,
    description: t("subtitle"),
    path: "/pricing",
  });

  const handleSubscribe = (planId: (typeof PLAN_IDS)[number]) => {
    if (!isAuthenticated) {
      navigate("/");
      return;
    }
    checkout.mutate({ planId });
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 bg-neutral-900/50">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Hexagon className="h-6 w-6 text-blue-500" />
            <span className="font-semibold">AI Swarm Studio</span>
          </div>
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-neutral-400">{t("subtitle")}</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-neutral-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {PLAN_IDS.map((planId) => {
              const plan = data?.plans.find((p) => p.id === planId);
              const available = plan?.available ?? false;
              return (
                <div
                  key={planId}
                  className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-xl font-semibold">{t(`plans.${planId}.name`)}</h2>
                    {plan?.perSeat && (
                      <Badge
                        variant="outline"
                        className="border-blue-500/30 bg-blue-500/10 text-blue-400"
                      >
                        {t("perSeat")}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-neutral-500">{t(`plans.${planId}.tagline`)}</p>

                  <ul className="mt-5 flex-1 space-y-2.5">
                    {FEATURE_KEYS.map((key) => (
                      <li key={key} className="flex items-start gap-2 text-sm text-neutral-300">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
                        {t(`plans.${planId}.${key}`)}
                      </li>
                    ))}
                  </ul>

                  <Button
                    className="mt-6 w-full bg-blue-600 text-white hover:bg-blue-700"
                    disabled={!available || checkout.isPending}
                    onClick={() => handleSubscribe(planId)}
                  >
                    {checkout.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {!available
                      ? t("comingSoon")
                      : isAuthenticated
                        ? t("subscribe")
                        : t("loginToSubscribe")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Marketplace note */}
        <div className="mt-8 flex flex-col items-start gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/30 p-6 sm:flex-row sm:items-center">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10">
            <Store className="h-5 w-5 text-purple-400" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium">{t("marketplace.title")}</h3>
            <p className="mt-1 text-sm text-neutral-400">{t("marketplace.body")}</p>
          </div>
          <Link to="/marketplace">
            <Button
              variant="outline"
              className="border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
            >
              Marketplace
            </Button>
          </Link>
        </div>

        <p className="mt-6 text-center text-xs text-neutral-600">{t("billingNote")}</p>
      </main>
    </div>
  );
}
