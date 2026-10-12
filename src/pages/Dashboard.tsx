import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/hooks/useAuth";
import {
  FolderOpen,
  Plus,
  Clock,
  Bot,
  Trash2,
  Settings,
  GitBranch,
  Loader2,
  Hexagon,
  LogIn,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ─── Auth Form (Login / Signup) ────────────────────────────────────

function AuthForm() {
  const { t } = useTranslation(["pages", "common", "login"]);
  const [searchParams, setSearchParams] = useSearchParams();
  // OAuth return path (e.g. /oauth/authorize?... or /oauth/consent?...).
  // Guard against open redirects: only same-origin /oauth/ paths allowed.
  const nextParam = searchParams.get("next");
  const safeNext = nextParam && nextParam.startsWith("/oauth/") ? nextParam : null;
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  // Enterprise SSO (Phase 3): email-domain branching on the login form.
  const [ssoEmail, setSsoEmail] = useState("");
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoHint, setSsoHint] = useState("");

  const afterLogin = () => {
    if (safeNext) {
      window.location.href = safeNext;
    } else {
      window.location.reload();
    }
  };

  // SSO landing: the server 302s here after a successful IdP round-trip
  // (?sso_token=<local JWT>) or a failed one (?sso_error=<key>). Store the
  // token exactly like a normal login response and clean the URL so the
  // token never lingers in history. `next` is preserved for afterLogin().
  useEffect(() => {
    const token = searchParams.get("sso_token");
    const errKey = searchParams.get("sso_error");
    if (!token && !errKey) return;

    const cleaned = new URLSearchParams(searchParams);
    cleaned.delete("sso_token");
    cleaned.delete("sso_error");
    setSearchParams(cleaned, { replace: true });

    if (token) {
      localStorage.setItem("local_auth_token", token);
      afterLogin();
      return;
    }
    if (errKey) {
      const known = ["config", "exchange", "state", "denied", "provision"];
      setError(
        known.includes(errKey)
          ? t(`login:sso.errors.${errKey}`)
          : t("login:sso.errors.exchange"),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only SSO landing handler
  }, []);

  const handleSsoContinue = async () => {
    setError("");
    setSsoHint("");
    const email = ssoEmail.trim().toLowerCase();
    const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !domain) {
      setSsoHint(t("login:sso.invalidEmail"));
      return;
    }
    setSsoBusy(true);
    try {
      const res = await fetch(`/api/sso/lookup?domain=${encodeURIComponent(domain)}`);
      // 404 = enterprise_sso flag off or route unmounted → no SSO available.
      if (res.status === 404) {
        setSsoHint(t("login:sso.noSsoForDomain"));
        return;
      }
      if (!res.ok) {
        setSsoHint(t("login:sso.lookupFailed"));
        return;
      }
      const data = (await res.json()) as {
        sso?: boolean;
        connectionId?: number;
        type?: "oidc" | "saml";
      };
      if (!data.sso || !data.connectionId) {
        setSsoHint(t("login:sso.noSsoForDomain"));
        return;
      }
      const base =
        data.type === "saml" ? "/api/sso/saml/authorize" : "/api/sso/oidc/authorize";
      window.location.href =
        `${base}?connectionId=${data.connectionId}` +
        (safeNext ? `&next=${encodeURIComponent(safeNext)}` : "");
    } catch {
      setSsoHint(t("login:sso.lookupFailed"));
    } finally {
      setSsoBusy(false);
    }
  };

  const loginMutation = trpc.localAuth.login.useMutation({
    onSuccess: (data) => {
      localStorage.setItem("local_auth_token", data.token);
      afterLogin();
    },
    onError: (err) => setError(err.message),
  });

  const signupMutation = trpc.localAuth.signup.useMutation({
    onSuccess: (data) => {
      localStorage.setItem("local_auth_token", data.token);
      afterLogin();
    },
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password.trim()) {
      setError(t("pages:dashboard.auth.fillAllFields"));
      return;
    }
    if (mode === "login") {
      loginMutation.mutate({ username: username.trim(), password });
    } else {
      if (password.length < 4) {
        setError(t("pages:dashboard.auth.passwordTooShort"));
        return;
      }
      signupMutation.mutate({
        username: username.trim(),
        password,
        name: displayName.trim() || undefined,
      });
    }
  };

  const isPending = loginMutation.isPending || signupMutation.isPending;

  return (
    <div className="flex items-center justify-center min-h-screen bg-neutral-950">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <Hexagon className="w-8 h-8 text-blue-500" />
          <h1 className="text-xl font-bold text-neutral-100">{t("common:appName")}</h1>
        </div>

        <Card className="bg-neutral-900 border-neutral-800">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg text-neutral-100">
              {mode === "login" ? (
                <span className="flex items-center gap-2">
                  <LogIn className="w-5 h-5 text-blue-400" />
                  {t("pages:dashboard.auth.signIn")}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <UserPlus className="w-5 h-5 text-blue-400" />
                  {t("pages:dashboard.auth.createAccount")}
                </span>
              )}
            </CardTitle>
            <CardDescription className="text-xs text-neutral-500">
              {mode === "login"
                ? t("pages:dashboard.auth.signInDesc")
                : t("pages:dashboard.auth.createAccountDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-neutral-400 mb-1 block">{t("pages:dashboard.auth.usernameLabel")}</label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t("pages:dashboard.auth.usernamePlaceholder")}
                  className="bg-neutral-800 border-neutral-700 text-neutral-100"
                  autoComplete="username"
                />
              </div>
              {mode === "signup" && (
                <div>
                  <label className="text-xs font-medium text-neutral-400 mb-1 block">{t("pages:dashboard.auth.displayNameLabel")}</label>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={t("pages:dashboard.auth.displayNamePlaceholder")}
                    className="bg-neutral-800 border-neutral-700 text-neutral-100"
                  />
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-neutral-400 mb-1 block">{t("pages:dashboard.auth.passwordLabel")}</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("pages:dashboard.auth.passwordPlaceholder")}
                  className="bg-neutral-800 border-neutral-700 text-neutral-100"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                />
              </div>

              {error && (
                <p className="text-xs text-red-400 bg-red-500/10 rounded-md px-3 py-2">{error}</p>
              )}

              <Button
                type="submit"
                disabled={isPending}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              >
                {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {mode === "login" ? t("pages:dashboard.auth.signIn") : t("pages:dashboard.auth.createAccount")}
              </Button>

              {mode === "login" && (
                <>
                  <div className="flex items-center gap-3 py-1">
                    <div className="flex-1 h-px bg-neutral-800" />
                    <span className="text-[11px] uppercase tracking-wide text-neutral-600">{t("login:sso.divider")}</span>
                    <div className="flex-1 h-px bg-neutral-800" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-neutral-400 mb-1 block">{t("login:sso.emailLabel")}</label>
                    <Input
                      type="email"
                      value={ssoEmail}
                      onChange={(e) => setSsoEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSsoContinue();
                        }
                      }}
                      placeholder={t("login:sso.emailPlaceholder")}
                      className="bg-neutral-800 border-neutral-700 text-neutral-100"
                      autoComplete="email"
                    />
                  </div>
                  {ssoHint && (
                    <p className="text-xs text-amber-400 bg-amber-500/10 rounded-md px-3 py-2">{ssoHint}</p>
                  )}
                  <Button
                    type="button"
                    disabled={ssoBusy}
                    onClick={handleSsoContinue}
                    className="w-full bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border border-neutral-700"
                  >
                    {ssoBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    {t("login:sso.continueButton")}
                  </Button>
                </>
              )}

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  {mode === "login" ? t("pages:dashboard.auth.needAccount") : t("pages:dashboard.auth.alreadyHaveAccount")}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-neutral-600 mt-6">
          {t("pages:dashboard.auth.apiKeysEncrypted")}
        </p>
      </div>
    </div>
  );
}

// ─── Create Project Modal ──────────────────────────────────────────

function CreateProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(["pages", "dashboard", "common"]);
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const createMutation = trpc.project.create.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
    },
    onError: (err) => alert(`Failed: ${err.message}`),
  });
  const createDefaultsMutation = trpc.agent.createDefaults.useMutation();

  const handleSubmit = async () => {
    if (!name.trim()) return;
    try {
      const project = await createMutation.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        giteeToken: localStorage.getItem("gitee_token") ?? undefined,
      });
      await createDefaultsMutation.mutateAsync({ projectId: project.id });

      // Optional: upload ZIP file to populate the project (issue #12)
      if (zipFile) {
        setUploading(true);
        try {
          const formData = new FormData();
          formData.append("projectId", String(project.id));
          formData.append("zipFile", zipFile);
          const giteeToken = localStorage.getItem("gitee_token");
          if (giteeToken) formData.append("giteeToken", giteeToken);
          const authToken = localStorage.getItem("local_auth_token") ?? "";
          const resp = await fetch("/api/import-project", {
            method: "POST",
            body: formData,
            headers: { "x-local-auth-token": authToken },
          });
          if (!resp.ok) {
            const errBody = await resp.text();
            console.warn("[CreateProject] ZIP upload failed:", errBody);
            alert(`Project created but ZIP import failed: ${errBody}`);
          }
        } finally {
          setUploading(false);
        }
      }

      utils.project.list.invalidate();
      onClose();
      setName(""); setDescription(""); setZipFile(null);
    } catch (e) {
      alert(`Error: ${(e as Error).message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-neutral-900 border-neutral-700 text-neutral-100 max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{t("pages:dashboard.modal.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <label className="text-sm font-medium text-neutral-300 mb-1.5 block">{t("pages:dashboard.modal.nameLabel")}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("pages:dashboard.modal.namePlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" />
          </div>
          <div>
            <label className="text-sm font-medium text-neutral-300 mb-1.5 block">{t("pages:dashboard.modal.descLabel")}</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("pages:dashboard.modal.descPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" />
          </div>
          <div>
            <label className="text-sm font-medium text-neutral-300 mb-1.5 block">
              {t("pages:dashboard.createProject.sourceZip")} <span className="text-xs text-neutral-500">{t("pages:dashboard.createProject.optional")}</span>
            </label>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-neutral-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:bg-blue-600 file:text-white hover:file:bg-blue-500 file:cursor-pointer cursor-pointer"
            />
            {zipFile && (
              <p className="text-[11px] text-neutral-500 mt-1">
                {t("pages:dashboard.createProject.willExtract", { name: zipFile.name, size: (zipFile.size / 1024).toFixed(1) })}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} className="text-neutral-400">{t("common:actions.cancel")}</Button>
            <Button onClick={handleSubmit} disabled={!name.trim() || createMutation.isPending || uploading} className="bg-blue-600 hover:bg-blue-700 text-white">
              {(createMutation.isPending || uploading) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {uploading ? t("pages:dashboard.createProject.importing") : t("common:actions.create")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Project Card ──────────────────────────────────────────────────

function ProjectCard({ project }: { project: { id: number; name: string; description: string | null; giteeOwner: string | null; giteeRepo: string | null; createdAt: Date | null } }) {
  const navigate = useNavigate();
  const { t } = useTranslation(["dashboard", "common"]);
  const utils = trpc.useUtils();
  const deleteMutation = trpc.project.delete.useMutation({
    onSuccess: () => utils.project.list.invalidate(),
  });

  const handleDelete = (projectId: number) => {
    if (!confirm(t("pages:dashboard.card.confirmDelete"))) return;
    const token = localStorage.getItem("gitee_token");
    deleteMutation.mutate({ id: projectId, giteeToken: token ?? undefined });
  };

  return (
    <Card className="bg-neutral-900 border-neutral-800 hover:border-blue-500/30 transition-all group">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <FolderOpen className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-neutral-100 group-hover:text-blue-400 transition-colors">
                {project.name}
              </CardTitle>
              <CardDescription className="text-xs mt-0.5 line-clamp-1">
                {project.description || t("pages:dashboard.card.noDescription")}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button variant="ghost" size="icon" className="w-7 h-7 text-neutral-500 hover:text-blue-400" onClick={(e) => { e.stopPropagation(); navigate(`/projects/${project.id}/settings`); }}>
              <Settings className="w-3.5 h-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="w-7 h-7 text-neutral-500 hover:text-red-400" onClick={(e) => { e.stopPropagation(); handleDelete(project.id); }}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center gap-4 text-xs text-neutral-500">
          {project.giteeOwner && project.giteeRepo && (
            <span className="flex items-center gap-1">
              <GitBranch className="w-3 h-3" />
              {project.giteeOwner}/{project.giteeRepo}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {project.createdAt ? new Date(project.createdAt).toLocaleDateString() : "N/A"}
          </span>
        </div>
        <Button variant="ghost" className="w-full mt-3 text-xs text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800" onClick={() => navigate(`/projects/${project.id}`)}>
          <Bot className="w-3.5 h-3.5 mr-1" />
          {t("pages:dashboard.card.openWorkspace")}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Main Dashboard ────────────────────────────────────────────────

export default function Dashboard() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { user, isAuthenticated, isLoading } = useAuth();
  const { data: projects, isLoading: projectsLoading } = trpc.project.list.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );
  const [searchParams] = useSearchParams();
  const [showCreate, setShowCreate] = useState(searchParams.get("new") === "true");

  // Show auth form when not logged in
  if (!isAuthenticated && !isLoading) {
    return <AuthForm />;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-neutral-950">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <AppShell>
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-neutral-100">{t("pages:dashboard.title")}</h1>
            <p className="text-sm text-neutral-500 mt-1">{t("pages:dashboard.subtitle")}</p>
            {user?.name && (
              <p className="text-xs text-blue-400 mt-1">Welcome, {user.name}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => setShowCreate(true)} className="bg-blue-600 hover:bg-blue-700 text-white">
              <Plus className="w-4 h-4 mr-2" />
              {t("pages:dashboard.newProjectButton")}
            </Button>
          </div>
        </div>

        {projectsLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        ) : projects && projects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-4">
              <FolderOpen className="w-8 h-8 text-neutral-600" />
            </div>
            <h3 className="text-lg font-medium text-neutral-300 mb-2">{t("pages:dashboard.emptyState.title")}</h3>
            <p className="text-sm text-neutral-500 max-w-sm mb-6">{t("pages:dashboard.emptyState.description")}</p>
            <Button onClick={() => setShowCreate(true)} className="bg-blue-600 hover:bg-blue-700 text-white">
              <Plus className="w-4 h-4 mr-2" />
              {t("pages:dashboard.emptyState.button")}
            </Button>
          </div>
        )}
      </div>

      <CreateProjectModal open={showCreate} onClose={() => setShowCreate(false)} />
    </AppShell>
  );
}
