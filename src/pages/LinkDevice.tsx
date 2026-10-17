// Device-link approval page (V3 L3): a local install shows a code and this
// page is where the signed-in marketplace user approves it.
import { useState } from "react";
import { useSearchParams } from "react-router";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plug, CheckCircle2, Loader2 } from "lucide-react";

export default function LinkDevice() {
  const { user, isLoading } = useAuth();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  const approve = async () => {
    setState("pending");
    setError("");
    try {
      const res = await fetch("/api/device/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-auth-token": localStorage.getItem("local_auth_token") ?? "",
        },
        body: JSON.stringify({ userCode: code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  return (
    <AppShell>
      <div className="flex items-center justify-center p-6" style={{ minHeight: "60vh" }}>
        <Card className="w-full max-w-md bg-neutral-900 border-neutral-800">
          <CardHeader>
            <CardTitle className="text-lg text-neutral-100 flex items-center gap-2">
              <Plug className="w-5 h-5 text-blue-400" />
              Link a local install
            </CardTitle>
            <CardDescription className="text-xs text-neutral-500">
              Approving lets a DeeWaanAI app running on your computer publish and fork
              pipelines as this account. Only approve a code your own app is showing you.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
            ) : !user ? (
              <p className="text-sm text-neutral-400">Sign in first (home page), then return here.</p>
            ) : state === "done" ? (
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="w-5 h-5" />
                Linked — you can return to your local app.
              </div>
            ) : (
              <>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="XXXX-XXXX"
                  className="bg-neutral-800 border-neutral-700 text-neutral-100 font-mono text-center text-lg tracking-widest"
                  maxLength={9}
                />
                {state === "error" && (
                  <p className="text-sm text-red-400">
                    {error === "code_not_found_or_expired"
                      ? "That code doesn't exist or has expired — codes live 10 minutes."
                      : error}
                  </p>
                )}
                <Button
                  onClick={approve}
                  disabled={state === "pending" || code.length < 9}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white"
                >
                  {state === "pending" && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                  Approve this device
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
