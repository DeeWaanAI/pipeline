import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Copy,
  Check,
  Plug,
  KeyRound,
  MousePointerClick,
  ShieldCheck,
  Terminal,
} from "lucide-react";

type AppKey = "claude" | "chatgpt" | "qwen" | "kimi";

const APP_ORDER: AppKey[] = ["claude", "chatgpt", "qwen", "kimi"];
const STEP_KEYS = ["step1", "step2", "step3", "step4"] as const;

const APP_ACCENT: Record<AppKey, string> = {
  claude: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  chatgpt: "text-green-400 bg-green-500/10 border-green-500/30",
  qwen: "text-purple-400 bg-purple-500/10 border-purple-500/30",
  kimi: "text-blue-400 bg-blue-500/10 border-blue-500/30",
};

export default function ConnectPage() {
  const { t } = useTranslation("connect");
  const [copied, setCopied] = useState(false);

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/mcp` : "/mcp";

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      toast.success(t("endpoint.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(mcpUrl);
    }
  };

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

          {/* Endpoint card */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              {t("endpoint.label")}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-2.5 font-mono text-sm text-neutral-200 break-all">
                {mcpUrl}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={copyUrl}
                className="shrink-0 border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
              >
                {copied ? (
                  <Check className="mr-1.5 h-4 w-4 text-green-400" />
                ) : (
                  <Copy className="mr-1.5 h-4 w-4" />
                )}
                {copied ? t("endpoint.copied") : t("endpoint.copy")}
              </Button>
            </div>
            <p className="mt-2 text-xs text-neutral-500">{t("endpoint.hint")}</p>
          </div>

          {/* How it works */}
          <div>
            <h2 className="text-lg font-medium">{t("howItWorks.title")}</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {[
                { icon: Plug, title: t("howItWorks.step1Title"), desc: t("howItWorks.step1Desc") },
                { icon: KeyRound, title: t("howItWorks.step2Title"), desc: t("howItWorks.step2Desc") },
                { icon: MousePointerClick, title: t("howItWorks.step3Title"), desc: t("howItWorks.step3Desc") },
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
          </div>

          {/* Per-app guides */}
          <div>
            <h2 className="text-lg font-medium">{t("appsTitle")}</h2>
            <div className="mt-3 space-y-3">
              {APP_ORDER.map((appKey) => (
                <div
                  key={appKey}
                  className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t(`apps.${appKey}.name`)}</span>
                    <Badge
                      variant="outline"
                      className={`text-xs ${APP_ACCENT[appKey]}`}
                    >
                      {t(`apps.${appKey}.tagline`)}
                    </Badge>
                  </div>
                  <ol className="mt-3 space-y-2">
                    {STEP_KEYS.map((stepKey, i) => (
                      <li key={stepKey} className="flex gap-3 text-sm text-neutral-300">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs text-neutral-400">
                          {i + 1}
                        </span>
                        <span className="flex-1">
                          {t(`apps.${appKey}.${stepKey}`)}
                          {appKey === "qwen" && stepKey === "step1" && (
                            <code className="mt-1.5 flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 break-all">
                              <Terminal className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                              qwen mcp add --transport http ai-swarm-studio {mcpUrl}
                            </code>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>

          {/* Security note */}
          <div className="flex gap-3 rounded-xl border border-neutral-800 bg-neutral-900/30 p-5">
            <ShieldCheck className="h-5 w-5 shrink-0 text-green-400" />
            <div>
              <div className="text-sm font-medium">{t("securityNote.title")}</div>
              <div className="mt-1 text-xs text-neutral-400">
                {t("securityNote.desc")}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
