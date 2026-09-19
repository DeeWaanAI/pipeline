import { useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Hexagon,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  LogIn,
  Check,
  X,
} from "lucide-react";

/** Scopes this consent screen knows how to describe (must match api/mcp/auth.ts). */
const KNOWN_SCOPES = ["mcp:read", "mcp:run", "mcp:write"] as const;

export default function OAuthConsentPage() {
  const { t } = useTranslation("mcp");
  const [params] = useSearchParams();
  const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);

  const clientId = params.get("client_id") ?? "";
  const clientName = params.get("client_name") ?? "";
  const scopeStr = params.get("scope") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state");

  const isValid = Boolean(clientId && redirectUri && codeChallenge);
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  const token =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("local_auth_token")
      : null;

  const decide = async (decision: "allow" | "deny") => {
    setSubmitting(decision);
    try {
      const res = await fetch("/oauth/authorize/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-local-auth-token": token ?? "",
        },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          scope: scopeStr,
          state: state ?? undefined,
          decision,
        }),
      });
      const data = (await res.json()) as {
        redirect?: string;
        error_description?: string;
      };
      if (res.ok && data.redirect) {
        window.location.assign(data.redirect);
        return;
      }
      toast.error(data.error_description || t("consent.error"));
      setSubmitting(null);
    } catch {
      toast.error(t("consent.error"));
      setSubmitting(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-4 text-neutral-100">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/60 p-8">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10">
            <Hexagon className="h-6 w-6 text-blue-500" />
          </div>
        </div>

        {!isValid ? (
          /* ─── Invalid request ─── */
          <div className="mt-6 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-amber-400" />
            <h1 className="mt-3 text-lg font-semibold">{t("consent.invalidTitle")}</h1>
            <p className="mt-2 text-sm text-neutral-400">{t("consent.invalidDesc")}</p>
          </div>
        ) : !token ? (
          /* ─── Login required ─── */
          <div className="mt-6 text-center">
            <h1 className="text-lg font-semibold">{t("consent.loginTitle")}</h1>
            <p className="mt-2 text-sm text-neutral-400">{t("consent.loginDesc")}</p>
            <Button
              className="mt-6 w-full bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => {
                const here = window.location.pathname + window.location.search;
                window.location.assign(`/login?next=${encodeURIComponent(here)}`);
              }}
            >
              <LogIn className="mr-2 h-4 w-4" />
              {t("consent.loginButton")}
            </Button>
          </div>
        ) : (
          /* ─── Consent decision ─── */
          <div className="mt-6">
            <h1 className="text-center text-lg font-semibold">
              {t("consent.title", { app: clientName || clientId })}
            </h1>
            <p className="mt-2 text-center text-sm text-neutral-400">
              {t("consent.subtitle")}
            </p>

            <div className="mt-5 text-xs font-medium uppercase tracking-wider text-neutral-500">
              {t("consent.scopesTitle")}
            </div>
            <ul className="mt-2 space-y-2">
              {scopes.map((scope) => (
                <li
                  key={scope}
                  className="flex items-start gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-300"
                >
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
                  <span>
                    {(KNOWN_SCOPES as readonly string[]).includes(scope)
                      ? t(`consent.scopes.${scope}`)
                      : scope}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-6 flex gap-3">
              <Button
                variant="outline"
                className="flex-1 border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                disabled={submitting !== null}
                onClick={() => decide("deny")}
              >
                {submitting === "deny" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <X className="mr-2 h-4 w-4" />
                )}
                {t("consent.deny")}
              </Button>
              <Button
                className="flex-1 bg-blue-600 text-white hover:bg-blue-700"
                disabled={submitting !== null}
                onClick={() => decide("allow")}
              >
                {submitting === "allow" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-2 h-4 w-4" />
                )}
                {submitting === "allow" ? t("consent.submitting") : t("consent.allow")}
              </Button>
            </div>

            <p className="mt-5 text-center text-xs text-neutral-500">
              {t("consent.footer")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
