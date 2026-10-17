import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/hooks/useAuth";
import {
  Key,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Sparkles,
  Plug,
  GitBranch,
  Save,
  RefreshCw,
  Database,
  Download,
  Upload,
  FileJson,
  FolderOpen,
  Unlink,
  HardDrive,
  Calculator,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  requestFolderAccess,
  requestFolderAccessFallback,
  restoreFolderAccess,
  unlinkFolder,
  isLocalFolderSupported,
  storeFallbackFolderName,
  getStoredFallbackFolder,
  clearFallbackFolder,
  type LocalFolderState,
} from "@/lib/localFolder";

// ─── Provider Setup Flow ───
// Step 1: Pick preset → Step 2: Enter API key → Step 3: Fetch models → Step 4: Pick model → Save

const PRESETS = [
  { slug: "openai", name: "OpenAI", url: "https://api.openai.com/v1" },
  { slug: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { slug: "kimi", name: "Moonshot Kimi", url: "https://api.moonshot.cn/v1" },
  { slug: "together", name: "Together.ai", url: "https://api.together.xyz/v1" },
  { slug: "anthropic", name: "Anthropic", url: "https://api.anthropic.com/v1" },
  { slug: "gemini", name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { slug: "aliyun", name: "Aliyun (Qwen / DeepSeek)", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { slug: "custom", name: "Custom (OpenAI-compatible)", url: "" },
];

function AddProviderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(["settings", "common", "pages"]);
  const utils = trpc.useUtils();

  // Step 1: Provider selection
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  // Step 2: API key
  const [apiKey, setApiKey] = useState("");

  // Step 3: Fetched models
  const [models, setModels] = useState<string[]>([]);
  const [fetchSource, setFetchSource] = useState<"" | "api" | "static">("");

  // Step 4: Selected model
  const [defaultModel, setDefaultModel] = useState("");

  const fetchMutation = trpc.llm.fetchModelsPreview.useMutation({
    onSuccess: (data) => {
      setModels(data.models);
      setFetchSource(data.source);
      if (data.models.length > 0 && !defaultModel) {
        setDefaultModel(data.models[0]);
      }
    },
    onError: () => {
      // Fall back to static defaults
      const preset = PRESETS.find((p) => p.slug === slug);
      if (preset) {
        const staticModels: Record<string, string[]> = {
          openai: ["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini"],
          deepseek: ["deepseek-chat", "deepseek-reasoner"],
          kimi: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
          together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3"],
          anthropic: ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-haiku-20240307"],
          gemini: ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash"],
          aliyun: ["qwen-max", "qwen-plus", "qwen-turbo", "deepseek-r1", "deepseek-v3"],
          custom: ["gpt-4o", "gpt-3.5-turbo"],
        };
        const fallback = staticModels[slug] ?? ["gpt-4o"];
        setModels(fallback);
        setFetchSource("static");
        if (!defaultModel) setDefaultModel(fallback[0]);
      }
    },
  });

  const createMutation = trpc.llm.createProvider.useMutation({
    onSuccess: () => {
      utils.llm.listProviders.invalidate();
      resetForm();
      onClose();
      toast.success(t("pages:settingsExtra.provider.addSuccess"));
    },
    onError: (err) => {
      console.error("Provider creation error:", err);
      toast.error(t("pages:settingsExtra.provider.addFailed", { error: err.message }));
    },
  });

  const resetForm = () => {
    setSlug(""); setName(""); setBaseUrl(""); setApiKey("");
    setModels([]); setFetchSource(""); setDefaultModel("");
  };

  const handlePresetChange = (value: string) => {
    const preset = PRESETS.find((p) => p.slug === value);
    if (preset) {
      setSlug(preset.slug);
      setName(preset.name);
      setBaseUrl(preset.url);
      setModels([]);
      setFetchSource("");
      setDefaultModel("");
    }
  };

  const handleFetchModels = () => {
    if (!apiKey.trim() || !baseUrl.trim()) return;
    fetchMutation.mutate({ slug: slug || "openai", baseUrl, apiKey });
  };

  const handleSubmit = () => {
    if (!name.trim() || !slug.trim() || !apiKey.trim() || !defaultModel.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      slug: slug.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      defaultModel: defaultModel.trim(),
      models: models.length > 0 ? models : [defaultModel.trim()],
    });
  };

  const canFetch = apiKey.trim().length > 0 && baseUrl.trim().length > 0;
  const canSave = name.trim() && slug.trim() && apiKey.trim() && defaultModel.trim();

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !createMutation.isPending) { resetForm(); onClose(); } }} modal>
      <DialogContent
        className="bg-neutral-900 border-neutral-700 text-neutral-100 max-w-lg"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={() => { if (!createMutation.isPending) { resetForm(); onClose(); } }}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{t("settings:providers.dialog.title")}</DialogTitle>
          <DialogDescription className="text-neutral-400">
            {t("settings:providers.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Step 1: Provider Preset */}
          <div>
            <label className="text-sm font-medium text-neutral-300 mb-1.5 block">{t("pages:settingsExtra.provider.providerPlatform")}</label>
            <Select value={slug} onValueChange={handlePresetChange}>
              <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100">
                <SelectValue placeholder={t("pages:settingsExtra.provider.selectPlatform")} />
              </SelectTrigger>
              <SelectContent className="bg-neutral-800 border-neutral-700">
                {PRESETS.map((p) => (
                  <SelectItem key={p.slug} value={p.slug} className="text-neutral-100">{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Base URL */}
          <div>
            <label className="text-sm font-medium text-neutral-300 mb-1.5 block">{t("pages:settingsExtra.provider.baseUrl")}</label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("pages:settingsExtra.provider.baseUrlPlaceholder")}
              className="bg-neutral-800 border-neutral-700 text-neutral-100"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="text-sm font-medium text-neutral-300 mb-1.5 block">{t("pages:settingsExtra.provider.apiKey")}</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("pages:settingsExtra.provider.apiKeyPlaceholder")}
              className="bg-neutral-800 border-neutral-700 text-neutral-100"
            />
            <p className="text-xs text-neutral-500 mt-1">{t("pages:settingsExtra.provider.apiKeyHelp")}</p>
          </div>

          {/* Fetch Models Button */}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleFetchModels}
              disabled={!canFetch || fetchMutation.isPending}
              className="border-neutral-600 text-neutral-300 hover:bg-neutral-800"
            >
              {fetchMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              )}
              {fetchMutation.isPending ? t("pages:settingsExtra.provider.fetching") : t("pages:settingsExtra.provider.fetchModels")}
            </Button>
            {fetchSource && (
              <span className="ml-2 text-xs text-neutral-500">
                {fetchSource === "api" ? t("pages:settingsExtra.provider.liveFromApi") : t("pages:settingsExtra.provider.staticFallback")} — {t("pages:settingsExtra.provider.modelsFound", { count: models.length })}
              </span>
            )}
          </div>

          {/* Step 4: Model Dropdown */}
          {models.length > 0 && (
            <div>
              <label className="text-sm font-medium text-neutral-300 mb-1.5 block">
                {t("pages:settingsExtra.provider.defaultModel")} <span className="text-red-400">*</span>
              </label>
              <Select value={defaultModel} onValueChange={setDefaultModel}>
                <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100">
                  <SelectValue placeholder={t("pages:settingsExtra.provider.selectModel")} />
                </SelectTrigger>
                <SelectContent className="bg-neutral-800 border-neutral-700 max-h-60">
                  {models.map((m) => (
                    <SelectItem key={m} value={m} className="text-neutral-100 font-mono text-xs">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-neutral-500 mt-1">
                {t("pages:settingsExtra.provider.modelHelp")}
              </p>
            </div>
          )}

          {/* Fallback: manual model entry if fetch failed and no presets */}
          {models.length === 0 && slug && (
            <div>
              <label className="text-sm font-medium text-neutral-300 mb-1.5 block">
                {t("pages:settingsExtra.provider.defaultModel")} <span className="text-red-400">*</span>
              </label>
              <Input
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder={t("pages:settingsExtra.provider.modelManualPlaceholder")}
                className="bg-neutral-800 border-neutral-700 text-neutral-100 font-mono text-sm"
              />
            </div>
          )}

          {/* Validation hints */}
          {!canSave && (
            <div className="text-xs text-neutral-500 space-y-1">
              {!slug && <p className="text-red-400">{t("pages:settingsExtra.provider.validationSelectPlatform")}</p>}
              {!apiKey && <p className="text-red-400">{t("pages:settingsExtra.provider.validationEnterApiKey")}</p>}
              {!defaultModel && <p className="text-red-400">{t("pages:settingsExtra.provider.validationSelectModel")}</p>}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
            <Button type="button" variant="ghost" onClick={() => { resetForm(); onClose(); }} className="text-neutral-400">
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!canSave || createMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("common:actions.add")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({ provider }: { provider: { id: number; name: string; slug: string; baseUrl: string; defaultModel: string; models: string[] | null; isEnabled: boolean | null } }) {
  const { t } = useTranslation(["settings", "common", "pages"]);
  const utils = trpc.useUtils();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; latency?: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editModel, setEditModel] = useState(provider.defaultModel);
  const [editApiKey, setEditApiKey] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>(provider.models ?? []);

  const deleteMutation = trpc.llm.deleteProvider.useMutation({
    onSuccess: () => utils.llm.listProviders.invalidate(),
    onError: (err) => toast.error(t("pages:settingsExtra.provider.deleteFailed", { error: err.message })),
  });
  const testMutation = trpc.llm.testConnection.useMutation();
  const fetchModels = trpc.llm.fetchModels.useQuery({ providerId: provider.id }, { enabled: false });
  const updateMutation = trpc.llm.updateProvider.useMutation({
    onSuccess: () => { utils.llm.listProviders.invalidate(); setEditing(false); setEditApiKey(""); },
  });

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try { const r = await testMutation.mutateAsync({ providerId: provider.id }); setTestResult(r); }
    catch (e) { setTestResult({ success: false, error: (e as Error).message }); }
    finally { setTesting(false); }
  };

  const handleRefreshModels = async () => {
    const result = await fetchModels.refetch();
    if (result.data?.models) {
      setAvailableModels(result.data.models);
    }
  };

  const handleSaveEdit = () => {
    updateMutation.mutate({
      id: provider.id,
      defaultModel: editModel,
      models: availableModels.length > 0 ? availableModels : undefined,
      apiKey: editApiKey.trim() || undefined,
    });
  };

  return (
    <Card className="bg-neutral-900 border-neutral-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Plug className="w-5 h-5 text-blue-400" />
            <div>
              <CardTitle className="text-sm font-semibold text-neutral-100">{provider.name}</CardTitle>
              <CardDescription className="text-xs">
                {provider.slug} | <span className="font-mono text-blue-400">{provider.defaultModel}</span>
                {(availableModels.length ?? 0) > 0 && (
                  <span className="text-neutral-600 ml-1">({availableModels.length} models)</span>
                )}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {testResult && (
              <div className="mr-2">
                {testResult.success ? (
                  <span className="flex items-center gap-1 text-xs text-blue-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />{testResult.latency}ms
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-red-400">
                    <XCircle className="w-3.5 h-3.5" />{t("common:status.failed")}
                  </span>
                )}
              </div>
            )}
            <Button variant="ghost" size="sm" className="text-neutral-500 hover:text-blue-400 h-7 text-xs" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("common:actions.test")}
            </Button>
            <Button variant="ghost" size="sm" className="text-neutral-500 hover:text-blue-400 h-7 text-xs" onClick={() => setEditing(!editing)}>
              {editing ? t("pages:settingsExtra.provider.close") : t("pages:settingsExtra.provider.edit")}
            </Button>
            <Button variant="ghost" size="icon" className="w-7 h-7 text-neutral-500 hover:text-red-400" onClick={() => { if (confirm(`${t("common:actions.delete")} ${provider.name}?`)) deleteMutation.mutate({ id: provider.id }); }}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Edit panel */}
        {editing && (
          <div className="mt-3 pt-3 border-t border-neutral-800 space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="text-xs text-neutral-500 block mb-1">{t("pages:settingsExtra.provider.defaultModel")}</label>
                {availableModels.length > 0 ? (
                  <select
                    value={editModel}
                    onChange={(e) => setEditModel(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 text-xs rounded px-2 py-1.5 font-mono"
                  >
                    {availableModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    value={editModel}
                    onChange={(e) => setEditModel(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 text-xs rounded px-2 py-1.5 font-mono"
                  />
                )}
              </div>
              <Button variant="outline" size="sm" className="mt-5 border-neutral-600 text-neutral-300 hover:bg-neutral-800 text-xs" onClick={handleRefreshModels} disabled={fetchModels.isFetching}>
                {fetchModels.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </Button>
            </div>
            <div>
              <label className="text-xs text-neutral-500 block mb-1">{t("pages:settingsExtra.provider.newApiKey")}</label>
              <input
                type="password"
                value={editApiKey}
                onChange={(e) => setEditApiKey(e.target.value)}
                placeholder={t("pages:settingsExtra.provider.newApiKeyPlaceholder")}
                className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 text-xs rounded px-2 py-1.5 font-mono"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="text-neutral-400 h-7 text-xs" onClick={() => { setEditing(false); setEditApiKey(""); }}>{t("pages:settingsExtra.provider.cancel")}</Button>
              <Button size="sm" className="bg-blue-600 hover:bg-blue-700 h-7 text-xs" onClick={handleSaveEdit} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t("pages:settingsExtra.provider.saveChanges")}
              </Button>
            </div>
          </div>
        )}
      </CardHeader>
    </Card>
  );
}

// ─── Declared model prices ───
// The third pricing route, and deliberately the LAST one tried: live provider
// list, then the configured price vector, then this. A declared 0 is a real
// zero, not an unknown — that is how a locally-run model is recorded as free
// instead of unpriced.
function DeclaredPricesSection() {
  const { t } = useTranslation(["settings", "common", "pages"]);
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const { data: providers } = trpc.llm.listProviders.useQuery(undefined, { enabled: !!user });
  const { data: rows } = trpc.llm.listDeclaredPrices.useQuery(undefined, { enabled: !!user });

  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");

  const reset = () => {
    setModelId("");
    setInputPrice("");
    setOutputPrice("");
  };

  const invalidate = () => utils.llm.listDeclaredPrices.invalidate();

  const setPrice = trpc.llm.setDeclaredPrice.useMutation({
    onSuccess: () => {
      invalidate();
      reset();
      toast.success(t("settings:modelPrices.saved"));
    },
    onError: (err) => toast.error(err.message),
  });

  const removePrice = trpc.llm.deleteDeclaredPrice.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t("settings:modelPrices.deleted"));
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const inNum = Number(inputPrice);
    const outNum = Number(outputPrice);
    if (!providerId || !modelId.trim()) {
      toast.error(t("settings:modelPrices.required"));
      return;
    }
    if (![inNum, outNum].every((n) => Number.isFinite(n) && n >= 0)) {
      toast.error(t("settings:modelPrices.invalidNumber"));
      return;
    }
    setPrice.mutate({
      providerId: Number(providerId),
      modelId: modelId.trim(),
      inputUsdPerMillion: inNum,
      outputUsdPerMillion: outNum,
    });
  };

  const money = (value: string | number) =>
    Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });

  return (
    <div>
      <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2 mb-2">
        <Calculator className="w-5 h-5 text-blue-400" />
        {t("settings:modelPrices.title")}
      </h2>
      <p className="text-sm text-neutral-500 mb-4">{t("settings:modelPrices.description")}</p>

      <Card className="bg-neutral-900 border-neutral-800 mb-4">
        <CardContent className="py-4">
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1.2fr_1.4fr_0.8fr_0.8fr_auto] items-end">
            <label className="block">
              <span className="text-xs text-neutral-500">{t("settings:modelPrices.provider")}</span>
              <select
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="mt-1 w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">—</option>
                {(providers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">{t("settings:modelPrices.model")}</span>
              <Input
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="qwen3-32b"
                className="mt-1 bg-neutral-800 border-neutral-700 text-xs"
              />
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">{t("settings:modelPrices.input")}</span>
              <Input
                type="number" min="0" step="any" inputMode="decimal"
                value={inputPrice}
                onChange={(e) => setInputPrice(e.target.value)}
                placeholder="0.10"
                className="mt-1 bg-neutral-800 border-neutral-700 text-xs"
              />
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">{t("settings:modelPrices.output")}</span>
              <Input
                type="number" min="0" step="any" inputMode="decimal"
                value={outputPrice}
                onChange={(e) => setOutputPrice(e.target.value)}
                placeholder="0.30"
                className="mt-1 bg-neutral-800 border-neutral-700 text-xs"
              />
            </label>
            <Button
              type="submit" size="sm"
              disabled={setPrice.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {setPrice.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
              {t("settings:modelPrices.save")}
            </Button>
          </form>

          <div className="mt-3 space-y-1">
            <p className="text-xs text-neutral-500 flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
              {t("settings:modelPrices.zeroHint")}
            </p>
            <p className="text-xs text-neutral-500 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              {t("settings:modelPrices.priorityHint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {rows && rows.length > 0 ? (
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="py-3">
            <div className="grid gap-1 text-xs">
              <div className="grid grid-cols-[1.2fr_1.6fr_0.8fr_0.8fr_auto] gap-3 text-neutral-500 border-b border-neutral-800 pb-2">
                <span>{t("settings:modelPrices.colProvider")}</span>
                <span>{t("settings:modelPrices.colModel")}</span>
                <span className="text-right">{t("settings:modelPrices.colInput")}</span>
                <span className="text-right">{t("settings:modelPrices.colOutput")}</span>
                <span />
              </div>
              {rows.map((r) => (
                <div key={r.id} className="grid grid-cols-[1.2fr_1.6fr_0.8fr_0.8fr_auto] gap-3 items-center py-1.5 text-neutral-300">
                  <span className="truncate">{r.providerName}</span>
                  <span className="truncate font-mono">{r.modelId}</span>
                  <span className="text-right">{money(r.inputUsdPerMillion)}</span>
                  <span className="text-right">{money(r.outputUsdPerMillion)}</span>
                  <button
                    type="button"
                    onClick={() => removePrice.mutate({ id: r.id })}
                    className="text-neutral-600 hover:text-red-400 flex items-center gap-1"
                    aria-label={`${t("settings:modelPrices.delete")} ${r.providerName} ${r.modelId}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-neutral-600 mt-2">{t("settings:modelPrices.unit")}</p>
          </CardContent>
        </Card>
      ) : (
        <p className="text-xs text-neutral-600">{t("settings:modelPrices.empty")}</p>
      )}
    </div>
  );
}

function GiteeTokenSection() {
  const { t } = useTranslation("pages");
  const [token, setToken] = useState(localStorage.getItem("gitee_token") ?? "");
  const [username, setUsername] = useState(localStorage.getItem("gitee_username") ?? "");
  const [input, setInput] = useState("");
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const validateMutation = trpc.gitee.validateToken.useMutation();

  const handleSave = async () => {
    if (!input.trim()) return;
    setTesting(true); setTestResult(null);
    try {
      const result = await validateMutation.mutateAsync({ token: input.trim() });
      if (result.valid && result.user) {
        localStorage.setItem("gitee_token", input.trim());
        localStorage.setItem("gitee_username", result.user.login);
        setToken(input.trim());
        setUsername(result.user.login);
        setSaved(true);
        setTestResult({ ok: true, msg: t("pages:settingsExtra.gitee.connectedAs", { username: `${result.user.name} (${result.user.login})` }) });
        setTimeout(() => setSaved(false), 3000);
      } else {
        setTestResult({ ok: false, msg: t("pages:settingsExtra.gitee.invalidToken") });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: `Error: ${(e as Error).message}` });
    } finally { setTesting(false); }
  };

  const handleClear = () => {
    localStorage.removeItem("gitee_token");
    localStorage.removeItem("gitee_username");
    setToken(""); setUsername(""); setInput(""); setTestResult(null);
  };

  return (
    <Card className="bg-neutral-900 border-neutral-800">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-neutral-200 flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-blue-400" />
          {t("pages:settingsExtra.gitee.title")}
        </CardTitle>
        <CardDescription className="text-xs text-neutral-500">
          {t("pages:settingsExtra.gitee.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {token && username ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-blue-400" />
              <span className="text-neutral-300">{t("pages:settingsExtra.gitee.connectedAs", { username })}</span>
            </div>
            <Button variant="outline" size="sm" onClick={handleClear} className="border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-400/30">
              <Trash2 className="w-3.5 h-3.5 mr-1" /> {t("pages:settingsExtra.gitee.disconnect")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("pages:settingsExtra.gitee.tokenPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" />
            {testResult && (
              <p className={`text-xs px-3 py-2 rounded ${testResult.ok ? "text-blue-400 bg-blue-500/10" : "text-red-400 bg-red-500/10"}`}>{testResult.msg}</p>
            )}
            <Button size="sm" onClick={handleSave} disabled={!input.trim() || testing} className="bg-blue-600 hover:bg-blue-700 text-white">
              {testing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4 mr-1" /> : <Save className="w-4 h-4 mr-1" />}
              {testing ? t("pages:settingsExtra.gitee.testing") : saved ? t("pages:settingsExtra.gitee.connected") : t("pages:settingsExtra.gitee.connectButton")}
            </Button>
            <p className="text-xs text-neutral-600">{t("pages:settingsExtra.gitee.tokenHelp")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Local Data Folder Section ───────────────────────────────────────
function MarketplaceLinkSection() {
  const { t } = useTranslation("settings");
  const utils = trpc.useUtils();
  const [linking, setLinking] = useState(false);
  const statusQ = trpc.hostedLink.status.useQuery(undefined, {
    refetchInterval: linking ? 3000 : false,
  });
  const begin = trpc.hostedLink.begin.useMutation({
    onSuccess: () => setLinking(true),
    onError: () => toast.error(t("marketplaceLink.linkFailed")),
  });
  const unlink = trpc.hostedLink.unlink.useMutation({
    onSuccess: () => { setLinking(false); utils.hostedLink.status.invalidate(); },
  });

  const status = statusQ.data;
  const waiting = linking && status?.state === "waiting";

  // Stop polling once linked.
  if (linking && status?.state === "linked") setLinking(false);

  return (
    <Card className="bg-neutral-900 border-neutral-800">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-neutral-200 flex items-center gap-2">
          <Plug className="w-5 h-5 text-blue-400" />
          {t("marketplaceLink.title")}
        </CardTitle>
        <CardDescription className="text-xs text-neutral-500">
          {t("marketplaceLink.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status?.state === "linked" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              {t("marketplaceLink.linked")}
            </div>
            <div className="text-xs text-neutral-500">
              {status.hostedUrl} · {t("marketplaceLink.linkedAt")} {new Date(status.linkedAt).toLocaleString()}
            </div>
            <Button
              variant="outline" size="sm"
              className="border-neutral-700 text-neutral-300"
              onClick={() => unlink.mutate()}
              disabled={unlink.isPending}
            >
              <Unlink className="w-4 h-4 mr-1" />
              {t("marketplaceLink.unlink")}
            </Button>
          </div>
        ) : waiting ? (
          <div className="space-y-3">
            <p className="text-sm text-neutral-400">{t("marketplaceLink.codeInstruction")}</p>
            {begin.data && (
              <>
                <div className="text-2xl font-mono font-bold tracking-widest text-neutral-100">
                  {begin.data.userCode}
                </div>
                <a
                  href={begin.data.verificationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-blue-400 underline break-all"
                >
                  {begin.data.verificationUrl}
                </a>
              </>
            )}
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("marketplaceLink.waiting")}
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            onClick={() => begin.mutate()}
            disabled={begin.isPending}
            className="bg-blue-600 hover:bg-blue-500 text-white"
          >
            {begin.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plug className="w-4 h-4 mr-1" />}
            {t("marketplaceLink.linkButton")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function LocalDataFolderSection() {
  const { t } = useTranslation("settings");
  const [localFolder, setLocalFolder] = useState<LocalFolderState | null>(null);
  const [fallbackFolder, setFallbackFolder] = useState<{ name: string; fileCount: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isLocalFolderSupported()) {
      restoreFolderAccess()
        .then((state) => { if (state) setLocalFolder(state); })
        .catch(() => { /* no stored handle */ })
        .finally(() => setLoading(false));
    } else {
      const stored = getStoredFallbackFolder();
      if (stored) setFallbackFolder({ name: stored.name, fileCount: stored.fileCount });
      setLoading(false);
    }
  }, []);

  const handleLinkFolder = async () => {
    if (isLocalFolderSupported()) {
      try {
        const state = await requestFolderAccess();
        if (state) setLocalFolder(state);
      } catch {
        toast.error(t("projectSettings.localFolder.linkFailed"));
      }
    } else {
      try {
        const result = await requestFolderAccessFallback();
        if (result) {
          storeFallbackFolderName(result.name, result.files.length, result.files);
          setFallbackFolder({ name: result.name, fileCount: result.files.length });
          toast.success(t("projectSettings.localFolder.linkSuccess"));
        }
      } catch {
        toast.error(t("projectSettings.localFolder.linkFailed"));
      }
    }
  };

  const handleUnlinkFolder = async () => {
    if (localFolder) {
      await unlinkFolder();
      setLocalFolder(null);
    }
    if (fallbackFolder) {
      clearFallbackFolder();
      setFallbackFolder(null);
    }
    toast.success(t("projectSettings.localFolder.unlinkSuccess"));
  };

  const isConnected = !!localFolder || !!fallbackFolder;

  return (
    <Card className="bg-neutral-900 border-neutral-800">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-neutral-200 flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-emerald-400" />
          {t("projectSettings.localFolder.title")}
        </CardTitle>
        <CardDescription className="text-xs text-neutral-500">
          {t("projectSettings.localFolder.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t("projectSettings.localFolder.checking")}
          </div>
        ) : isConnected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span className="text-neutral-300">
                {t("projectSettings.localFolder.connectedTo")}{" "}
                <strong>{localFolder?.path ?? fallbackFolder?.name}</strong>
              </span>
            </div>
            {fallbackFolder && (
              <p className="text-xs text-neutral-500">
                {t("projectSettings.localFolder.filesLinked", { count: fallbackFolder.fileCount, name: fallbackFolder.name })}
              </p>
            )}
            {!localFolder && fallbackFolder && (
              <p className="text-xs text-amber-400/80">
                {t("projectSettings.localFolder.fallbackNote")}
              </p>
            )}
            <p className="text-xs text-neutral-500">
              {t("projectSettings.localFolder.linked")}
            </p>
            <Button variant="outline" size="sm" onClick={handleUnlinkFolder} className="border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-400/30">
              <Unlink className="w-3.5 h-3.5 mr-1" /> {t("projectSettings.localFolder.unlink")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Button size="sm" onClick={handleLinkFolder} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <FolderOpen className="w-4 h-4 mr-1" /> {t("projectSettings.localFolder.linkButton")}
            </Button>
            <p className="text-xs text-neutral-600">{t("projectSettings.localFolder.apiNote")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DataBackupSection() {
  const { t } = useTranslation(["settings", "common"]);
  const utils = trpc.useUtils();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const importMutation = trpc.export.importAllUserData.useMutation({
    onSuccess: (data) => {
      const r = data.restored;
      toast.success(t("settings:projectSettings.dataManagement.restoreSuccess", {
        agents: r.agents,
        templates: r.templates,
        preferences: r.preferences ? ", preferences" : "",
      }));
      utils.llm.loadPreferences.invalidate();
    },
    onError: (err) => {
      toast.error(t("settings:projectSettings.dataManagement.restoreFailed", { error: err.message }));
    },
  });

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const data = await utils.export.exportAllUserData.fetch();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `swarm-studio-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const sizeKB = (blob.size / 1024).toFixed(1);
      toast.success(t("settings:projectSettings.dataManagement.backupDownloaded", { size: sizeKB }));
    } catch (err) {
      toast.error(t("settings:projectSettings.dataManagement.downloadFailed", { error: (err as Error).message }));
    } finally {
      setDownloading(false);
    }
  };

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so same file can be selected again

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.version || data.type !== "full_backup") {
        toast.error(t("settings:projectSettings.dataManagement.invalidBackup"));
        return;
      }

      if (!confirm(t("settings:projectSettings.dataManagement.restoreConfirm", {
        date: data.exportedAt ? new Date(data.exportedAt).toLocaleString() : "unknown date",
      }))) {
        return;
      }

      setRestoring(true);
      importMutation.mutate(data);
    } catch (err) {
      toast.error(t("settings:projectSettings.dataManagement.restoreFailed", { error: (err as Error).message }));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Card className="bg-neutral-900 border-neutral-800">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-neutral-200 flex items-center gap-2">
          <Database className="w-5 h-5 text-blue-400" />
          {t("settings:projectSettings.dataManagement.title")}
        </CardTitle>
        <CardDescription className="text-xs text-neutral-500">
          {t("settings:projectSettings.dataManagement.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Section 1: Full Backup Download */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-medium text-neutral-200">{t("settings:projectSettings.dataManagement.fullBackup")}</span>
          </div>
          <p className="text-xs text-neutral-500">
            {t("settings:projectSettings.dataManagement.fullBackupDesc")}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownload}
            disabled={downloading}
            className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
          >
            {downloading ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Download className="w-4 h-4 mr-1.5" />
            )}
            {downloading ? t("settings:projectSettings.dataManagement.downloading") : t("settings:projectSettings.dataManagement.downloadBackup")}
          </Button>
        </div>

        <div className="border-t border-neutral-800" />

        {/* Section 3: Restore */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-medium text-neutral-200">{t("settings:projectSettings.dataManagement.restore")}</span>
          </div>
          <p className="text-xs text-neutral-500">
            {t("settings:projectSettings.dataManagement.restoreDesc")}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleRestore}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={restoring || importMutation.isPending}
            className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
          >
            {restoring || importMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <FileJson className="w-4 h-4 mr-1.5" />
            )}
            {restoring || importMutation.isPending ? t("settings:projectSettings.dataManagement.restoring") : t("settings:projectSettings.dataManagement.restoreButton")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation(["settings", "common", "pages"]);
  const { user } = useAuth();
  const { data: providers, isLoading } = trpc.llm.listProviders.useQuery(undefined, { enabled: !!user });
  const { data: defaultProvider, refetch: refetchDefault } = trpc.llm.getDefaultProvider.useQuery();
  const setDefaultMutation = trpc.llm.setDefaultProvider.useMutation({
    onSuccess: () => {
      refetchDefault();
      toast.success(t("pages:settingsExtra.provider.defaultUpdated"));
    },
    onError: (err) => toast.error(err.message),
  });
  const [showAdd, setShowAdd] = useState(false);

  return (
    <AppShell>
      <div className="p-6 max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-neutral-100">{t("settings:title")}</h1>
          <p className="text-sm text-neutral-500 mt-1">{t("settings:subtitle")}</p>
        </div>

        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2">
                <Key className="w-5 h-5 text-blue-400" />
                {t("settings:providers.title")}
              </h2>
              <p className="text-xs text-neutral-500 mt-1">{t("settings:providers.description")}</p>
            </div>
            <Button onClick={() => setShowAdd(true)} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">
              <Plus className="w-4 h-4 mr-1" />{t("settings:providers.addButton")}
            </Button>
          </div>

          {/* Default LLM Provider Selector */}
          {!isLoading && providers && providers.length > 0 && (
            <Card className="bg-neutral-900/60 border-neutral-800 mb-4">
              <CardContent className="py-3 px-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-neutral-300 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    {t("pages:settingsExtra.provider.defaultLlmProvider")}
                  </p>
                  <p className="text-[11px] text-neutral-500 mt-0.5">
                    {t("pages:settingsExtra.provider.defaultLlmDesc")}
                  </p>
                </div>
                <select
                  value={defaultProvider?.providerId ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") {
                      setDefaultMutation.mutate({ providerId: null });
                    } else {
                      const prov = providers.find((p) => p.id === Number(v));
                      setDefaultMutation.mutate({
                        providerId: Number(v),
                        model: prov?.defaultModel ?? null,
                      });
                    }
                  }}
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-blue-500 max-w-[260px]"
                >
                  <option value="">— {t("pages:settingsExtra.provider.autoPerProject")} —</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.defaultModel})
                    </option>
                  ))}
                </select>
              </CardContent>
            </Card>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
          ) : providers && providers.length > 0 ? (
            <div className="grid gap-3">{providers.map((p) => <ProviderCard key={p.id} provider={p as typeof p & { models: string[] | null }} />)}</div>
          ) : (
            <Card className="bg-neutral-900 border-neutral-800 border-dashed">
              <CardContent className="flex flex-col items-center py-10 text-center">
                <Sparkles className="w-8 h-8 text-neutral-600 mb-3" />
                <p className="text-sm text-neutral-500 mb-1">{t("common:emptyStates.noProviders")}</p>
                <p className="text-xs text-neutral-600 mb-4">{t("common:emptyStates.noProvidersDesc")}</p>
                <Button onClick={() => setShowAdd(true)} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">
                  <Plus className="w-4 h-4 mr-1" />{t("settings:providers.addFirstButton")}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        <Separator className="bg-neutral-800 my-6" />
        <DeclaredPricesSection />
        <Separator className="bg-neutral-800 my-6" />
        <GiteeTokenSection />
        <div className="mt-4">
          <LocalDataFolderSection />
          <MarketplaceLinkSection />
        </div>
        <div className="mt-4">
          <DataBackupSection />
        </div>
        <Separator className="bg-neutral-800 my-6" />


        <div>
          <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2 mb-4">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            {t("common:security.title")}
          </h2>
          <Card className="bg-neutral-900 border-neutral-800">
            <CardContent className="py-4 space-y-3">
              {[
                { text: t("common:security.encrypted"), detail: t("common:security.keyDetail") },
                { text: t("common:security.keysNeverLeave"), detail: t("common:security.keysDesc") },
                { text: t("common:security.ownStorage"), detail: t("common:security.ownData") },
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3">
                  <CheckCircle2 className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm text-neutral-300">{item.text}</p>
                    <p className="text-xs text-neutral-500">{item.detail}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <AddProviderModal open={showAdd} onClose={() => setShowAdd(false)} />
    </AppShell>
  );
}
