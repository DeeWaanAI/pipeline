import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useCapabilities } from "@/hooks/useCapabilities";
import {
  Loader2, ChevronUp, ChevronDown, Trash2, Plus,
  Cpu, Lock, Zap, Brain, Save, RotateCcw, Sparkles, Workflow,
  GitBranch, RefreshCw, UserCheck,
} from "lucide-react";

interface Step {
  id: number;
  stepOrder: number;
  name: string;
  role: string;
  systemPrompt: string;
  isEnabled: boolean;
  providerId: number | null;
  model: string | null;
  temperature: string | null;
  maxTokens: number | null;
  stepType?: string;
  ifConfig?: { options: string[]; mappings: Record<string, number> } | null;
  whileConfig?: { targetStep: number; maxIterations: number } | null;
}

type MemMode = "conservative" | "balanced" | "aggressive";

interface Props { projectId: number; }

export default function PipelineConfigurator({ projectId }: Props) {
  const { t } = useTranslation(["pipeline", "common"]);
  const { toast } = useToast();
  const { has } = useCapabilities();
  const isPro = has("pipeline:custom");
  const utils = trpc.useUtils();

  const { data: config, isLoading } = trpc.project.getPipelineConfig.useQuery({ projectId });
  const { data: agentsData } = trpc.customAgent.list.useQuery(undefined, { enabled: isPro });
  const { data: providers } = trpc.pipeline.availableProviders.useQuery(undefined, { enabled: isPro });

  const updateConfig = trpc.project.updatePipelineConfig.useMutation({
    onSuccess: () => { utils.project.getPipelineConfig.invalidate({ projectId }); toast({ title: t("pages:pipeline.save.success") }); },
    onError: (err) => toast({ title: err.message, variant: "destructive" }),
  });
  const saveAsTemplate = trpc.template.createFromPipeline.useMutation({
    onSuccess: (data) => { toast({ title: `Saved as "${data.name}"` }); utils.template.list.invalidate(); },
    onError: (err) => toast({ title: err.message, variant: "destructive" }),
  });
  const savePipeline = trpc.pipeline.set.useMutation({
    onSuccess: (data) => {
      utils.project.getPipelineConfig.invalidate({ projectId });
      toast({ title: t("pages:pipeline.save.success") });
      // Sync returned steps to get proper IDs
      if (data && data.length > 0) {
        setSteps(data.map((s) => ({
          id: s.id,
          stepOrder: s.stepOrder,
          name: s.name,
          role: s.role,
          systemPrompt: s.systemPrompt,
          isEnabled: s.isEnabled ?? true,
          providerId: s.providerId,
          model: s.model,
          temperature: s.temperature,
          maxTokens: s.maxTokens,
          stepType: (s.stepType as string) ?? "agent",
          ifConfig: (s.ifConfig as Step["ifConfig"]) ?? null,
          whileConfig: (s.whileConfig as Step["whileConfig"]) ?? null,
        })));
      }
    },
    onError: (err) => toast({ title: err.message, variant: "destructive" }),
  });

  const [steps, setSteps] = useState<Step[]>([]);
  const [memoryMode, setMemoryMode] = useState<MemMode>("balanced");
  const [addOpen, setAddOpen] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editPrompt, setEditPrompt] = useState("");

  useEffect(() => {
    if (config?.steps) {
      setSteps(config.steps.map((s) => ({
        id: s.id,
        stepOrder: s.stepOrder,
        name: s.name,
        role: s.role,
        systemPrompt: s.systemPrompt,
        isEnabled: s.isEnabled ?? true,
        providerId: s.providerId,
        model: s.model as string | null ?? null,
        temperature: s.temperature,
        maxTokens: s.maxTokens,
        stepType: (s.stepType as string) ?? "agent",
        ifConfig: (s.ifConfig as Step["ifConfig"]) ?? null,
        whileConfig: (s.whileConfig as Step["whileConfig"]) ?? null,
      })));
    }
  }, [config]);

  useEffect(() => {
    const saved = localStorage.getItem(`memory-mode-${projectId}`);
    if (saved === "conservative" || saved === "balanced" || saved === "aggressive") setMemoryMode(saved);
  }, [projectId]);

  const saveMem = (mode: MemMode) => { setMemoryMode(mode); localStorage.setItem(`memory-mode-${projectId}`, mode); toast({ title: t("pages:pipeline.memory.saved", { mode }) }); };

  const moveStep = (idx: number, dir: -1 | 1) => {
    if (!isPro) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= steps.length) return;
    const next = [...steps];
    [next[idx], next[ni]] = [next[ni], next[idx]];
    next.forEach((s, i) => { s.stepOrder = i + 1; });
    setSteps(next);
  };

  const toggleStep = (idx: number) => {
    const next = steps.map((s, i) => i === idx ? { ...s, isEnabled: !s.isEnabled } : s);
    setSteps(next);
  };

  const removeStep = (idx: number) => {
    if (!isPro) return;
    if (!confirm(t("pages:pipeline.remove.confirm"))) return;
    const next = steps.filter((_, i) => i !== idx);
    next.forEach((s, i) => { s.stepOrder = i + 1; });
    setSteps(next);
  };

  const addFromTemplate = (opts: {
    name: string; role: string; systemPrompt: string;
    providerId?: number | null; model?: string | null;
    temperature?: string; maxTokens?: number;
  }) => {
    setSteps([...steps, {
      id: -(Date.now()), stepOrder: steps.length + 1,
      name: opts.name, role: opts.role, systemPrompt: opts.systemPrompt,
      isEnabled: true,
      providerId: opts.providerId ?? null,
      model: opts.model ?? null,
      temperature: opts.temperature ?? "0.7",
      maxTokens: opts.maxTokens ?? 4096,
      stepType: "agent",
    }]);
    setAddOpen(false);
  };

  const addSpecialStep = (type: "if" | "while" | "approval") => {
    const nextOrder = steps.length + 1;
    if (type === "if") {
      setSteps([...steps, {
        id: -(Date.now()), stepOrder: nextOrder,
        name: "IF Gate", role: "critic",
        systemPrompt: "You are a quality gate reviewer. Analyze the previous output carefully. Provide your FULL assessment — strengths, weaknesses, specific issues, and detailed reasoning.\n\nThen on the VERY LAST LINE, output EXACTLY ONE of these keywords: pass, revise\n\nThe keyword on the last line determines pipeline routing. The full analysis above is saved for audit.",
        isEnabled: true, providerId: null, model: null,
        temperature: "0.3", maxTokens: 2048,
        stepType: "if",
        ifConfig: { options: ["pass", "revise"], mappings: { pass: nextOrder + 1, revise: Math.max(1, nextOrder - 1) } },
      }]);
    } else if (type === "while") {
      setSteps([...steps, {
        id: -(Date.now()), stepOrder: nextOrder,
        name: "WHILE Loop", role: "critic",
        systemPrompt: "You are a quality checker. Review the previous output carefully. Provide your FULL assessment — does it meet quality standards? What specific improvements are needed? Be thorough.\n\nThen on the VERY LAST LINE, output EXACTLY \"retry\" (to loop back and improve) or \"pass\" (to continue).\n\nThe keyword on the last line determines pipeline routing. The full analysis above is saved for audit.",
        isEnabled: true, providerId: null, model: null,
        temperature: "0.3", maxTokens: 2048,
        stepType: "while",
        whileConfig: { targetStep: Math.max(1, nextOrder - 1), maxIterations: 3 },
      }]);
    } else {
      setSteps([...steps, {
        id: -(Date.now()), stepOrder: nextOrder,
        name: "Human Review", role: "approval",
        systemPrompt: "Human review required before continuing.",
        isEnabled: true, providerId: null, model: null,
        temperature: "0.7", maxTokens: 4096,
        stepType: "approval",
      }]);
    }
    setAddOpen(false);
  };

  const handleSave = () => {
    if (!steps.length) { toast({ title: t("pages:pipeline.errors.noSteps"), variant: "destructive" }); return; }

    // Build payload WITHOUT agentId — backend resolves/creates agents
    const payload = steps.map((s) => ({
      name: s.name,
      role: s.role,
      systemPrompt: s.systemPrompt,
      providerId: s.providerId,
      model: s.model,
      temperature: s.temperature ?? undefined,
      maxTokens: s.maxTokens ?? undefined,
      isEnabled: s.isEnabled,
      stepType: s.stepType ?? "agent",
      ifConfig: s.ifConfig ?? undefined,
      whileConfig: s.whileConfig ?? undefined,
    }));

    if (isPro) {
      const enabledSteps = steps.filter((s) => s.isEnabled);
      const pids = enabledSteps.map((s) => s.providerId).filter((p): p is number => p != null);
      if (new Set(pids).size > 3) { toast({ title: t("pages:pipeline.errors.maxLLMs"), variant: "destructive" }); return; }
      savePipeline.mutate({ projectId, steps: payload });
    } else {
      // Standard: only toggle + prompt edits (send steps with IDs)
      updateConfig.mutate({
        projectId,
        steps: steps.map((s) => ({
          id: s.id,
          isEnabled: s.isEnabled,
          systemPrompt: s.systemPrompt,
          providerId: s.providerId,
          model: s.model,
          temperature: s.temperature ?? undefined,
          maxTokens: s.maxTokens ?? undefined,
        })),
      });
    }
  };

  const handleReset = () => {
    if (!confirm(t("pages:pipeline.reset.confirm"))) return;
    const defs = [
      { name: t("common:agentRoles.builder"), role: "builder", sp: "You are a Builder agent. Create an initial, comprehensive response to the user's request. Focus on completeness and accuracy. Produce a well-structured draft." },
      { name: t("common:agentRoles.critic"), role: "critic", sp: "You are a Critic agent. Review the provided output and identify weaknesses, errors, or areas for improvement. Be specific. End with Overall Assessment: PASS, NEEDS_WORK, or MAJOR_REVISIONS." },
      { name: t("common:agentRoles.refiner"), role: "refiner", sp: "You are a Refiner agent. Improve the provided output based on the feedback. Address each criticism systematically. Produce a significantly improved version." },
      { name: t("common:agentRoles.polisher"), role: "polisher", sp: "You are a Polisher agent. Take the refined output and make it presentation-ready. Improve clarity, flow, formatting, and tone. This is the final quality check." },
    ];
    setSteps(defs.map((d, i) => ({ id: -(i + 1), stepOrder: i + 1, name: d.name, role: d.role, systemPrompt: d.sp, isEnabled: true, providerId: null, model: null, temperature: "0.7", maxTokens: 4096, stepType: "agent" as const })));
  };

  const provModels = (pid: number | null) => providers?.find((p) => p.id === pid)?.models ?? [];
  const usedLLMs = new Set(steps.filter((s) => s.isEnabled).map((s) => s.providerId).filter(Boolean));

  // ─── Free user upgrade prompt ───
  const showUpgrade = () => {
    if (confirm("This feature requires Master tier. Upgrade now? (Demo: click OK to upgrade)")) {
      window.location.reload();
    }
  };

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-neutral-200 flex items-center gap-2"><Cpu className="w-4 h-4 text-blue-400" />{t("pages:pipeline.title")}</h2>
          <p className="text-xs text-neutral-500 mt-0.5">{t("pages:pipeline.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {isPro && <Badge variant="outline" className="text-xs">{usedLLMs.size}/3 LLMs</Badge>}
          {isPro ? <Badge className="bg-blue-600/20 text-blue-300 border-blue-500/30 text-xs"><Zap className="w-3 h-3 mr-1" />{t("pages:pipeline.tier.pro")}</Badge> : <Badge variant="outline" className="text-neutral-400 border-neutral-700 text-xs"><Lock className="w-3 h-3 mr-1" />{t("pages:pipeline.tier.standard")}</Badge>}
        </div>
      </div>

      {/* Memory Mode */}
      <Card className="bg-neutral-900 border-neutral-800"><CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-blue-400" />
            <div><h3 className="text-sm font-medium text-neutral-200">{t("pages:pipeline.memory.title")}</h3><p className="text-xs text-neutral-500">{t("pages:pipeline.memory.description")}</p></div>
          </div>
          <div className="flex items-center gap-1 bg-neutral-800 rounded-lg p-0.5">
            {(["conservative", "balanced", "aggressive"] as MemMode[]).map((m) => (
              <button key={m} onClick={() => saveMem(m)} className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${memoryMode === m ? "bg-blue-600 text-white" : "text-neutral-400 hover:text-neutral-200"}`}>{t(`pipeline:memory.modes.${m}`)}</button>
            ))}
          </div>
        </div>
        <p className="text-xs text-neutral-600 mt-2">{t(`pipeline:memory.hint.${memoryMode}`)}</p>
      </CardContent></Card>

      {/* Steps — read-only overlay for free users */}
      <div className={`relative ${!isPro ? "pointer-events-none opacity-60" : ""}`}>
        {!isPro && (
          <div className="absolute inset-0 z-10 flex items-center justify-center" onClick={showUpgrade}>
            <div className="bg-neutral-900/90 border border-blue-500/30 rounded-lg px-4 py-3 flex items-center gap-2 cursor-pointer hover:bg-neutral-900 transition-colors">
              <Lock className="w-4 h-4 text-blue-400" />
              <span className="text-sm text-blue-300">Upgrade to Master to customize pipeline</span>
              <Zap className="w-4 h-4 text-blue-400" />
            </div>
          </div>
        )}

        <div className="space-y-2">
          {steps.map((step, idx) => (
            <Card key={`${step.id}-${idx}`} className={`bg-neutral-900 border-neutral-800 ${!step.isEnabled ? "opacity-50" : ""}`}>
              <CardContent className="p-3">
                <div className="flex items-start gap-2">
                  {/* Order + Reorder */}
                  <div className="flex flex-col items-center gap-0.5 pt-1">
                    <span className="text-xs font-mono text-neutral-600 w-5 text-center">{String(idx + 1).padStart(2, "0")}</span>
                    {isPro && <><button onClick={() => moveStep(idx, -1)} disabled={idx === 0} className="text-neutral-600 hover:text-neutral-300 disabled:opacity-20"><ChevronUp className="w-3.5 h-3.5" /></button><button onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1} className="text-neutral-600 hover:text-neutral-300 disabled:opacity-20"><ChevronDown className="w-3.5 h-3.5" /></button></>}
                  </div>
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className="text-sm font-medium text-neutral-200">{step.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">{t("common:agentRoles." + step.role, step.role)}</span>
                      {step.stepType && step.stepType !== "agent" && (
                        <span className={`text-xs px-1.5 py-0.5 rounded capitalize font-medium ${
                          step.stepType === "if" ? "bg-amber-500/10 text-amber-400" :
                          step.stepType === "while" ? "bg-purple-500/10 text-purple-400" :
                          step.stepType === "approval" ? "bg-green-500/10 text-green-400" : ""
                        }`}>
                          {step.stepType === "if" && "◆ IF"}
                          {step.stepType === "while" && "↻ WHILE"}
                          {step.stepType === "approval" && "👤 Approval"}
                        </span>
                      )}
                      {step.providerId && providers && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">{providers.find((p) => p.id === step.providerId)?.name ?? "LLM"}{step.model && ` / ${step.model}`}</span>}
                      <label className="ml-auto flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={step.isEnabled} onChange={() => toggleStep(idx)} className="w-3.5 h-3.5 rounded border-neutral-600 bg-neutral-800 text-blue-600" />
                        <span className="text-xs text-neutral-500">{step.isEnabled ? t("pages:pipeline.enabled") : t("pages:pipeline.disabled")}</span>
                      </label>
                      {isPro && <button onClick={() => removeStep(idx)} className="text-neutral-600 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </div>

                    {/* Prompt - editable */}
                    {editIdx === idx ? (
                      <div className="space-y-2">
                        <Textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={3} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs resize-none" />
                        <div className="flex items-center gap-2">
                          <Button size="sm" className="h-7 text-xs bg-blue-600 hover:bg-blue-700" onClick={() => { const n = [...steps]; n[idx] = { ...n[idx], systemPrompt: editPrompt }; setSteps(n); setEditIdx(null); }}>{t("common:actions.save")}</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-neutral-400" onClick={() => setEditIdx(null)}>{t("common:actions.cancel")}</Button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setEditIdx(idx); setEditPrompt(step.systemPrompt); }} className="text-left w-full">
                        <p className="text-xs text-neutral-500 line-clamp-2 font-mono hover:text-neutral-400 transition-colors">{step.systemPrompt}</p>
                      </button>
                    )}

                    {/* Pro: Provider + Model + Params */}
                    {isPro && editIdx === idx && (
                      <div className="space-y-2 mt-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs text-neutral-500">{t("pages:pipeline.llm")}</Label>
                            <Select value={step.providerId ? String(step.providerId) : "default"} onValueChange={(v) => { const n = [...steps]; n[idx] = { ...n[idx], providerId: v === "default" ? null : parseInt(v), model: null }; setSteps(n); }}>
                              <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5"><SelectValue /></SelectTrigger>
                              <SelectContent className="bg-neutral-800 border-neutral-700">
                                <SelectItem value="default" className="text-neutral-200 text-xs">{t("pages:pipeline.useProjectDefault")}</SelectItem>
                                {providers?.map((p) => <SelectItem key={p.id} value={String(p.id)} className="text-neutral-200 text-xs">{p.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs text-neutral-500">Model</Label>
                            <Select value={step.model ?? "default"} onValueChange={(v) => { const n = [...steps]; n[idx] = { ...n[idx], model: v === "default" ? null : v }; setSteps(n); }} disabled={!step.providerId}>
                              <SelectTrigger className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5"><SelectValue placeholder={step.providerId ? "Select model" : "Pick provider"} /></SelectTrigger>
                              <SelectContent className="bg-neutral-800 border-neutral-700">
                                <SelectItem value="default" className="text-neutral-200 text-xs">Provider default</SelectItem>
                                {provModels(step.providerId).map((m) => <SelectItem key={m} value={m} className="text-neutral-200 text-xs font-mono">{m}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs text-neutral-500">{t("pages:pipeline.temperature")}</Label>
                            <Input type="number" min={0} max={2} step={0.1} value={step.temperature ?? "0.7"} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], temperature: e.target.value }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5" />
                          </div>
                          <div>
                            <Label className="text-xs text-neutral-500">{t("pages:pipeline.maxTokens")}</Label>
                            <Input type="number" min={256} max={128000} step={256} value={step.maxTokens ?? 4096} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], maxTokens: parseInt(e.target.value) || 4096 }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5" />
                          </div>
                        </div>

                        {/* IF Step Config */}
                        {step.stepType === "if" && (
                          <div className="mt-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10 space-y-2">
                            <p className="text-xs font-medium text-amber-400">IF Condition Configuration</p>
                            <div>
                              <Label className="text-xs text-neutral-500">Options (comma-separated keywords)</Label>
                              <Input
                                value={step.ifConfig?.options?.join(", ") ?? ""}
                                onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], ifConfig: { ...(n[idx].ifConfig ?? { options: [], mappings: {} }), options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) } }; setSteps(n); }}
                                placeholder="pass, revise, reject"
                                className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-neutral-500">Mappings (keyword → step order)</Label>
                              <div className="space-y-1">
                                {(step.ifConfig?.options ?? []).map((opt) => (
                                  <div key={opt} className="flex items-center gap-2">
                                    <span className="text-xs text-neutral-400 w-20 truncate">{opt}</span>
                                    <span className="text-xs text-neutral-600">→</span>
                                    <Input
                                      type="number"
                                      min={1}
                                      max={steps.length}
                                      value={step.ifConfig?.mappings?.[opt] ?? ""}
                                      onChange={(e) => {
                                        const n = [...steps];
                                        const newMappings = { ...(n[idx].ifConfig?.mappings ?? {}), [opt]: parseInt(e.target.value) || 1 };
                                        n[idx] = { ...n[idx], ifConfig: { ...(n[idx].ifConfig ?? { options: [] }), mappings: newMappings } };
                                        setSteps(n);
                                      }}
                                      className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-7 w-20"
                                    />
                                    <span className="text-xs text-neutral-600">step</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* WHILE Step Config */}
                        {step.stepType === "while" && (
                          <div className="mt-3 p-3 rounded-lg bg-purple-500/5 border border-purple-500/10 space-y-2">
                            <p className="text-xs font-medium text-purple-400">WHILE Loop Configuration</p>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <Label className="text-xs text-neutral-500">Target Step (to loop back to)</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  max={steps.length}
                                  value={step.whileConfig?.targetStep ?? 1}
                                  onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], whileConfig: { ...(n[idx].whileConfig ?? { targetStep: 1, maxIterations: 3 }), targetStep: parseInt(e.target.value) || 1 } }; setSteps(n); }}
                                  className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5"
                                />
                              </div>
                              <div>
                                <Label className="text-xs text-neutral-500">Max Iterations</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  max={10}
                                  value={step.whileConfig?.maxIterations ?? 3}
                                  onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], whileConfig: { ...(n[idx].whileConfig ?? { targetStep: 1, maxIterations: 3 }), maxIterations: parseInt(e.target.value) || 3 } }; setSteps(n); }}
                                  className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5"
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {isPro && <Button variant="outline" className="w-full border-dashed border-neutral-700 text-neutral-400 hover:text-neutral-200 mt-2" onClick={() => setAddOpen(true)}><Plus className="w-4 h-4 mr-1.5" />{t("pages:pipeline.addStep")}</Button>}

        {/* Save / Reset */}
        <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-neutral-800">
          {isPro && <Button variant="ghost" size="sm" className="text-neutral-500" onClick={handleReset}><RotateCcw className="w-3.5 h-3.5 mr-1.5" />{t("pages:pipeline.reset.label")}</Button>}
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={handleSave} disabled={updateConfig.isPending || savePipeline.isPending}>
            {updateConfig.isPending || savePipeline.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}{t("common:actions.save")}
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => {
              const name = prompt("Pipeline name:", steps.map((s) => s.name).join(" → "));
              if (name) saveAsTemplate.mutate({ name, projectId });
            }}
            disabled={saveAsTemplate.isPending || steps.length === 0}
            className="border-neutral-700 text-neutral-400 hover:bg-neutral-800 text-xs"
          >
            <Workflow className="w-3.5 h-3.5 mr-1" /> Save to My Pipelines
          </Button>
        </div>
      </div>

      {/* Add Step Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-neutral-900 border-neutral-800 text-neutral-100 max-w-md">
          <DialogHeader><DialogTitle className="text-neutral-100">{t("pages:pipeline.addDialog.title")}</DialogTitle></DialogHeader>
          <div className="space-y-1 max-h-[50vh] overflow-y-auto">
            {/* User's agents */}
            {agentsData?.userAgents.map((a) => {
              const added = steps.some((s) => s.role === a.role && s.name === a.name);
              return (
                <button key={a.id} onClick={() => { if (!added) addFromTemplate({ name: a.name, role: a.role, systemPrompt: a.systemPrompt, providerId: a.defaultProviderId, model: a.defaultModel }); }} disabled={added} className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors ${added ? "opacity-40 cursor-not-allowed bg-neutral-800/50" : "hover:bg-neutral-800 bg-neutral-900"}`}>
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0"><Cpu className="w-4 h-4 text-blue-400" /></div>
                  <div className="flex-1 min-w-0"><div className="flex items-center gap-2"><span className="text-sm font-medium text-neutral-200">{a.name}</span><span className="text-xs text-neutral-500">{t("common:agentRoles." + a.role, a.role)}</span>{added && <Badge variant="outline" className="text-xs border-neutral-700 text-neutral-500">{t("pages:pipeline.added")}</Badge>}</div><p className="text-xs text-neutral-500 truncate">{a.description}</p></div>
                </button>
              );
            })}
            {/* Templates */}
            {agentsData?.templates.filter((tmpl) => !agentsData.userAgents.some((a) => a.slug === tmpl.slug)).map((tmpl) => (
              <button key={tmpl.slug} onClick={() => addFromTemplate({ name: tmpl.name, role: tmpl.role, systemPrompt: tmpl.systemPrompt })} className="w-full flex items-center gap-3 p-3 rounded-lg text-left hover:bg-neutral-800 bg-neutral-900 transition-colors">
                <div className="w-8 h-8 rounded-lg bg-neutral-800 flex items-center justify-center flex-shrink-0"><Sparkles className="w-4 h-4 text-neutral-400" /></div>
                <div className="flex-1 min-w-0"><div className="flex items-center gap-2"><span className="text-sm font-medium text-neutral-200">{tmpl.name}</span><Badge variant="outline" className="text-xs border-neutral-700 text-neutral-400">{t("pages:pipeline.template")}</Badge></div><p className="text-xs text-neutral-500 truncate">{tmpl.description}</p></div>
              </button>
            ))}
            {/* Special Step Types */}
            <div className="pt-2 border-t border-neutral-800 mt-2">
              <p className="text-xs text-neutral-500 px-3 mb-1">{t("pages:pipeline.specialSteps")}</p>
              <button onClick={() => addSpecialStep("if")} className="w-full flex items-center gap-3 p-3 rounded-lg text-left hover:bg-neutral-800 bg-neutral-900 transition-colors">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0"><GitBranch className="w-4 h-4 text-amber-400" /></div>
                <div className="flex-1 min-w-0"><span className="text-sm font-medium text-neutral-200">{t("pages:pipeline.ifGate")}</span><p className="text-xs text-neutral-500">{t("pages:pipeline.ifDesc")}</p></div>
              </button>
              <button onClick={() => addSpecialStep("while")} className="w-full flex items-center gap-3 p-3 rounded-lg text-left hover:bg-neutral-800 bg-neutral-900 transition-colors mt-1">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center flex-shrink-0"><RefreshCw className="w-4 h-4 text-purple-400" /></div>
                <div className="flex-1 min-w-0"><span className="text-sm font-medium text-neutral-200">{t("pages:pipeline.whileLoop")}</span><p className="text-xs text-neutral-500">{t("pages:pipeline.whileDesc")}</p></div>
              </button>
              <button onClick={() => addSpecialStep("approval")} className="w-full flex items-center gap-3 p-3 rounded-lg text-left hover:bg-neutral-800 bg-neutral-900 transition-colors mt-1">
                <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center flex-shrink-0"><UserCheck className="w-4 h-4 text-green-400" /></div>
                <div className="flex-1 min-w-0"><span className="text-sm font-medium text-neutral-200">{t("pages:pipeline.humanReview")}</span><p className="text-xs text-neutral-500">{t("pages:pipeline.humanReviewDesc")}</p></div>
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
