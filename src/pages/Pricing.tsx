import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useSeo } from "@/hooks/useSeo";
import { Button } from "@/components/ui/button";
import { Hexagon, Check, ArrowLeft, Loader2, Store } from "lucide-react";

// One flat per-account subscription (owner decision 2026-09-22): no plan
// levels and no seats, so `solo` is the only offering.
const FEATURE_KEYS = ["feature1", "feature2", "feature3", "feature4"] as const;
const MODEL_KEYS = ["monthly", "trial", "byok", "noPerRun"] as const;

export default function PricingPage() {
  const { t } = useTranslation("pricing");

  const { data, isLoading } = trpc.billing.listPlans.useQuery();
  const plan = data?.plans.find((p) => p.id === "solo");

  useSeo({
    title: `${t("title")} | AI Swarm Studio`,
    description: t("subtitle"),
    path: "/pricing",
  });

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
          <div className="mt-10 grid gap-5 lg:grid-cols-2">
            {/* The single offering */}
            <div className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6">
              <h2 className="text-xl font-semibold">{plan?.name ?? t("plans.solo.name")}</h2>
              <p className="mt-1 text-sm text-neutral-500">{t("plans.solo.tagline")}</p>
              <p className="mt-4 text-sm font-medium text-neutral-200">{t("flatMonthly")}</p>

              <ul className="mt-5 flex-1 space-y-2.5">
                {FEATURE_KEYS.map((key) => (
                  <li key={key} className="flex items-start gap-2 text-sm text-neutral-300">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
                    {t(`plans.solo.${key}`)}
                  </li>
                ))}
              </ul>

              {/* Honest state of billing: no gateway is wired up yet, so this
                  page must not offer a checkout. */}
              <Button className="mt-6 w-full" variant="outline" disabled>
                {t("checkoutDisabled")}
              </Button>
            </div>

            {/* How billing actually works */}
            <div className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/30 p-6">
              <h2 className="text-lg font-medium">{t("model.title")}</h2>
              <ul className="mt-4 flex-1 space-y-3">
                {MODEL_KEYS.map((key) => (
                  <li key={key} className="flex items-start gap-2 text-sm text-neutral-300">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
                    <span>
                      <span className="font-medium text-neutral-200">{t(`model.${key}.title`)}</span>
                      <span className="block text-neutral-500">{t(`model.${key}.body`)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
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
