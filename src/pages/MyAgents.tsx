import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useCapabilities } from "@/hooks/useCapabilities";
import {
  Bot,
  Loader2,
  Plus,
  Trash2,
  Pencil,
  Wand2,
  Sparkles,
  AlertCircle,
  ArrowLeft,
  Zap,
  Shield,
  Lock,
  GitBranch,
  RefreshCw,
  UserCheck,
} from "lucide-react";

interface AgentForm {
  name: string;
  slug: string;
  role: string;
  systemPrompt: string;
  description: string;
  temperature: string;
  maxTokens: number;
  defaultProviderId?: number;
  defaultModel: string;
}

const EMPTY_FORM: AgentForm = {
  name: "",
  slug: "",
  role: "custom",
  systemPrompt: "",
  description: "",
  temperature: "0.7",
  maxTokens: 4096,
  defaultProviderId: undefined,
  defaultModel: "",
};

const ROLE_OPTIONS = [
  { value: "builder" },
  { value: "critic" },
  { value: "refiner" },
  { value: "polisher" },
  { value: "reviewer" },
  { value: "translator" },
  { value: "summarizer" },
  { value: "custom" },
];

export default function MyAgents() {
  const { t } = useTranslation(["agents", "common"]);
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const { has } = useCapabilities();
  const isPro = has("pipeline:custom");
  const isAuto = has("pipeline:autodesign");

  const { data, isLoading } = trpc.customAgent.list.useQuery();
  const { data: providers } = trpc.pipeline.availableProviders.useQuery();

  const createMutation = trpc.customAgent.create.useMutation({
    onSuccess: () => {
      utils.customAgent.list.invalidate();
      toast({ title: t("agents:create.success") });
      setDialogOpen(false);
      setForm(EMPTY_FORM);
    },
    onError: (err) => toast({ title: err.message, variant: "destructive" }),
  });

  const updateMutation = trpc.customAgent.update.useMutation({
    onSuccess: () => {
      utils.customAgent.list.invalidate();
      toast({ title: t("agents:update.success") });
      setDialogOpen(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
    },
    onError: (err) => toast({ title: err.message, variant: "destructive" }),
  });

  const deleteMutation = trpc.customAgent.delete.useMutation({
    onSuccess: () => {
      utils.customAgent.list.invalidate();
      toast({ title: t("agents:delete.success") });
    },
    onError: (err) => toast({ title: err.message, variant: "destructive" }),
  });

  const setTierMutation = trpc.localAuth.devTierSwitch.useMutation({
    onSuccess: () => {
      utils.localAuth.me.invalidate();
      utils.billing.myCapabilities.invalidate();
      toast({ title: "Tier updated — refresh the page to see changes" });
    },
    onError: (err) => toast({ title: err.message, variant: "destructive" }),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (agent: NonNullable<typeof data>["userAgents"][number]) => {
    setEditingId(agent.id);
    setForm({
      name: agent.name,
      slug: agent.slug,
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      description: agent.description ?? "",
      temperature: agent.temperature ?? "0.7",
      maxTokens: agent.maxTokens ?? 4096,
      defaultProviderId: agent.defaultProviderId ?? undefined,
      defaultModel: agent.defaultModel ?? "",
    });
    setDialogOpen(true);
  };

  const useTemplate = (template: NonNullable<typeof data>["templates"][number]) => {
    setEditingId(null);
    setForm({
      name: template.name,
      slug: template.slug,
      role: template.role,
      systemPrompt: template.systemPrompt,
      description: template.description ?? "",
      temperature: "0.7",
      maxTokens: 4096,
      defaultProviderId: undefined,
      defaultModel: "",
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim() || !form.slug.trim() || !form.systemPrompt.trim()) {
      toast({ title: t("agents:errors.required"), variant: "destructive" });
      return;
    }
    const payload = {
      ...form,
      description: form.description || undefined,
      defaultProviderId: form.defaultProviderId,
      defaultModel: form.defaultModel || undefined,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link to="/" className="text-neutral-500 hover:text-neutral-300 transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <h1 className="text-xl font-semibold text-neutral-100">{t("agents:title")}</h1>
            </div>
            <p className="text-sm text-neutral-500">{t("agents:subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Tier badge for demo */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs border ${
              isAuto
                ? "bg-amber-600/20 text-amber-300 border-amber-500/30"
                : isPro
                ? "bg-blue-600/20 text-blue-300 border-blue-500/30"
                : "bg-neutral-800 text-neutral-400 border-neutral-700"
            }`}>
              {isAuto ? <Sparkles className="w-3.5 h-3.5" /> : isPro ? <Zap className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
              <span>{isAuto ? t("agents:tiers.sage") : isPro ? t("agents:tiers.master") : t("agents:tiers.artist")}</span>
              <button
                onClick={() => {
                  const nextTier = user?.tier === "standard" ? "pro_designer" : user?.tier === "pro_designer" ? "pro_auto" : "standard";
                  setTierMutation.mutate({ tier: nextTier });
                }}
                className="ml-2 underline hover:no-underline cursor-pointer"
                title={t("agents:tierBadge.cycleHint")}
              >
                {isAuto ? t("agents:tierBadge.reset") : t("agents:tierBadge.upgrade")}
              </button>
            </div>
            {isPro ? (
              <Button onClick={openCreate} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-1.5" />
                {t("agents:createAgent")}
              </Button>
            ) : (
              <Button variant="outline" className="border-neutral-700 text-neutral-400" onClick={() => { if (confirm(t("agents:upgradeRequired", { tier: isAuto ? t("agents:tiers.sage") : t("agents:tiers.master") }))) window.location.reload(); }}>
                <Lock className="w-4 h-4 mr-1.5" />
                {t("agents:createAgent")}
              </Button>
            )}
          </div>
        </div>

        {/* Templates Section */}
        <div className="mb-8">
          <h2 className="text-sm font-medium text-neutral-400 mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-400" />
            {t("agents:templates")}
          </h2>
          {isLoading ? (
            <div className="flex items-center gap-2 text-neutral-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("common:actions.loading")}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {data?.templates.map((tmpl) => (
                <Card
                  key={tmpl.slug}
                  className="bg-neutral-900 border-neutral-800 hover:border-blue-500/40 cursor-pointer transition-colors"
                  onClick={() => { isPro ? useTemplate(tmpl) : alert(t("agents:upgradeRequiredAlert", { tier: isAuto ? t("agents:tiers.sage") : t("agents:tiers.master") })); }}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Wand2 className="w-4 h-4 text-blue-400" />
                      <span className="text-sm font-medium text-neutral-200">{tmpl.name}</span>
                    </div>
                    <p className="text-xs text-neutral-500 line-clamp-2">{tmpl.description}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Special Agents (Sage tier) — IF, WHILE, Approval */}
        {isAuto && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-neutral-400 mb-3 flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-amber-400" />
              {t("agents:conditional.title")}
            </h2>
            <p className="text-xs text-neutral-500 mb-3">
              {t("agents:conditional.description")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card className="bg-neutral-900 border-amber-500/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                      <GitBranch className="w-4 h-4 text-amber-400" />
                    </div>
                    <span className="text-sm font-medium text-neutral-200">{t("agents:conditional.ifGate")}</span>
                  </div>
                  <p className="text-xs text-neutral-500">
                    {t("agents:conditional.ifGateDesc")}
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-neutral-900 border-purple-500/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                      <RefreshCw className="w-4 h-4 text-purple-400" />
                    </div>
                    <span className="text-sm font-medium text-neutral-200">{t("agents:conditional.whileLoop")}</span>
                  </div>
                  <p className="text-xs text-neutral-500">
                    {t("agents:conditional.whileLoopDesc")}
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-neutral-900 border-green-500/20">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                      <UserCheck className="w-4 h-4 text-green-400" />
                    </div>
                    <span className="text-sm font-medium text-neutral-200">{t("agents:conditional.humanReview")}</span>
                  </div>
                  <p className="text-xs text-neutral-500">
                    {t("agents:conditional.humanReviewDesc")}
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* My Agents List */}
        <div>
          <h2 className="text-sm font-medium text-neutral-400 mb-3 flex items-center gap-2">
            <Bot className="w-4 h-4 text-blue-400" />
            {t("agents:myAgents")}
          </h2>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : !data?.userAgents?.length ? (
            <div className="text-center py-12 bg-neutral-900/50 rounded-lg border border-neutral-800">
              <AlertCircle className="w-10 h-10 mx-auto text-neutral-600 mb-3" />
              <p className="text-sm text-neutral-500 mb-2">{t("agents:empty")}</p>
              <p className="text-xs text-neutral-600">{t("agents:emptyDesc")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.userAgents.map((agent) => (
                <Card
                  key={agent.id}
                  className="bg-neutral-900 border-neutral-800 hover:border-neutral-700 transition-colors"
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-neutral-200">{agent.name}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 capitalize">
                            {agent.role}
                          </span>
                        </div>
                        {agent.description && (
                          <p className="text-xs text-neutral-500 mb-2">{agent.description}</p>
                        )}
                        <p className="text-xs text-neutral-600 line-clamp-2 font-mono">
                          {agent.systemPrompt.substring(0, 120)}
                          {agent.systemPrompt.length > 120 ? "..." : ""}
                        </p>
                        <div className="flex items-center gap-3 mt-2 text-xs text-neutral-500">
                          <span>{t("agents:form.tempLabel")}: {agent.temperature ?? "0.7"}</span>
                          <span>{t("agents:form.tokensLabel")}: {agent.maxTokens ?? 4096}</span>
                          {agent.defaultProviderId && providers && (
                            <span className="text-blue-400">
                              LLM: {providers.find((p) => p.id === agent.defaultProviderId)?.name ?? "custom"}
                              {agent.defaultModel && ` / ${agent.defaultModel}`}
                            </span>
                          )}
                        </div>
                      </div>
                      {isPro && (
                        <div className="flex items-center gap-1 ml-3">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="w-7 h-7 text-neutral-500 hover:text-blue-400"
                            onClick={() => openEdit(agent)}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="w-7 h-7 text-neutral-500 hover:text-red-400"
                            onClick={() => {
                              if (confirm(t("agents:delete.confirm", { name: agent.name }))) {
                                deleteMutation.mutate({ id: agent.id });
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-neutral-900 border-neutral-800 text-neutral-100 max-w-lg max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="text-neutral-100">
              {editingId ? t("agents:edit.title") : t("agents:create.title")}
            </DialogTitle>
            <DialogDescription className="text-neutral-500">
              {editingId ? t("agents:edit.desc") : t("agents:create.desc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto pr-1" style={{ maxHeight: "60vh" }}>
            <div>
              <Label className="text-xs text-neutral-400">{t("agents:form.name")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("agents:form.namePlaceholder")}
                className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1"
              />
            </div>

            <div>
              <Label className="text-xs text-neutral-400">{t("agents:form.slug")}</Label>
              <Input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })}
                placeholder="my-agent"
                className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1 font-mono text-sm"
              />
            </div>

            <div>
              <Label className="text-xs text-neutral-400">{t("agents:form.role")}</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-neutral-800 border-neutral-700">
                  {ROLE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-neutral-200">
                      {t("common:agentRoles." + opt.value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs text-neutral-400">{t("agents:form.systemPrompt")}</Label>
              <Textarea
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                rows={6}
                placeholder={t("agents:form.promptPlaceholder")}
                className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1 resize-none"
              />
            </div>

            <div>
              <Label className="text-xs text-neutral-400">{t("agents:form.description")}</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={t("agents:form.descPlaceholder")}
                className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1"
              />
            </div>

            {/* LLM Provider + Model — Two Box Selection */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-neutral-400">{t("agents:form.providerLabel")}</Label>
                <Select
                  value={form.defaultProviderId ? String(form.defaultProviderId) : "none"}
                  onValueChange={(v) => {
                    const pid = v === "none" ? undefined : parseInt(v);
                    // Reset model when provider changes
                    setForm({ ...form, defaultProviderId: pid, defaultModel: "" });
                  }}
                >
                  <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1">
                    <SelectValue placeholder={t("agents:form.providerPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent className="bg-neutral-800 border-neutral-700">
                    <SelectItem value="none" className="text-neutral-400">
                      {t("agents:form.projectDefault")}
                    </SelectItem>
                    {providers?.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)} className="text-neutral-200">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs text-neutral-400">{t("agents:form.modelLabel")}</Label>
                <Select
                  value={form.defaultModel || "none"}
                  onValueChange={(v) => setForm({ ...form, defaultModel: v === "none" ? "" : v })}
                  disabled={!form.defaultProviderId}
                >
                  <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1">
                    <SelectValue placeholder={form.defaultProviderId ? t("agents:form.selectModel") : t("agents:form.pickProviderFirst")} />
                  </SelectTrigger>
                  <SelectContent className="bg-neutral-800 border-neutral-700">
                    <SelectItem value="none" className="text-neutral-400">
                      {t("agents:form.providerDefault")}
                    </SelectItem>
                    {form.defaultProviderId && providers?.find((p) => p.id === form.defaultProviderId)?.models?.map((m) => (
                      <SelectItem key={m} value={m} className="text-neutral-200 font-mono text-xs">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-neutral-400">{t("agents:form.temperature")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={form.temperature}
                  onChange={(e) => setForm({ ...form, temperature: e.target.value })}
                  className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1"
                />
              </div>
              <div>
                <Label className="text-xs text-neutral-400">{t("agents:form.maxTokens")}</Label>
                <Input
                  type="number"
                  min={256}
                  max={128000}
                  step={256}
                  value={form.maxTokens}
                  onChange={(e) => setForm({ ...form, maxTokens: parseInt(e.target.value) || 4096 })}
                  className="bg-neutral-800 border-neutral-700 text-neutral-100 mt-1"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-neutral-800">
            <Button
              variant="ghost"
              onClick={() => {
                setDialogOpen(false);
                setEditingId(null);
              }}
              className="text-neutral-400 hover:text-neutral-200"
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {createMutation.isPending || updateMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : null}
              {editingId ? t("common:actions.save") : t("common:actions.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
