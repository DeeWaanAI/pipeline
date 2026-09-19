import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router";
import { useCapabilities } from "@/hooks/useCapabilities";
import { TIERS } from "@/lib/tiers";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Workflow, ArrowLeft, Save, Plus, Trash2, Copy,
  Bot, GitBranch, RefreshCw, UserCheck, Lock, Zap, Loader2,
} from "lucide-react";

interface EditableStep {
  id: number;
  name: string;
  role: string;
  systemPrompt: string;
  stepType: string;
  ifConfig?: { options: string[]; mappings: Record<string, number> } | null;
  whileConfig?: { targetStep: number; maxIterations: number } | null;
  providerId?: number | null;
  model?: string | null;
  temperature?: string;
  maxTokens?: number;
}

const STEP_ICONS: Record<string, { icon: typeof Bot; color: string }> = {
  agent:    { icon: Bot,       color: "text-blue-400" },
  if:       { icon: GitBranch, color: "text-amber-400" },
  while:    { icon: RefreshCw, color: "text-purple-400" },
  approval: { icon: UserCheck, color: "text-green-400" },
};

const AGENT_ROLES = [
  { name: "Builder",  slug: "builder",  sp: "Create comprehensive initial drafts based on the request. Produce complete, well-structured content.", color: "text-blue-400" },
  { name: "Critic",   slug: "critic",   sp: "Review and critique the output. Identify weaknesses, factual errors, and suggest specific improvements. Be thorough and honest.", color: "text-amber-400" },
  { name: "Refiner",  slug: "refiner",  sp: "Improve the previous output based on feedback. Fix all identified issues and produce a polished, improved version. Output the improved content directly — do NOT summarize or wrap in JSON.", color: "text-purple-400" },
  { name: "Polisher", slug: "polisher", sp: "Final quality check. Ensure consistency, clarity, and completeness. Output the polished content directly.", color: "text-green-400" },
  { name: "Expert",   slug: "expert",   sp: "Provide domain-specific expertise and deep analysis. Enrich the content with professional knowledge.", color: "text-cyan-400" },
  { name: "Translator", slug: "translator", sp: "Translate the previous output from its current language to the target language. Output ONLY the translated text — do NOT wrap in JSON, do NOT add summaries, do NOT explain your translation. Produce natural, fluent prose.", color: "text-teal-400" },
];

export default function PipelineEditor() {
  const { t } = useTranslation(["pages", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { has } = useCapabilities();
  const utils = trpc.useUtils();
  const templateId = parseInt(id ?? "0");

  const isNew = templateId === 0;
  const isMaster = has("pipeline:custom");
  const isSage = has("pipeline:autodesign");

  const { data: template, isLoading } = trpc.template.getById.useQuery(
    { id: templateId },
    { enabled: !isNew && templateId > 0 }
  );
  const { data: agentsData } = trpc.customAgent.list.useQuery();
  const { data: userProjects } = trpc.project.list.useQuery();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<EditableStep[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [editPrompt, setEditPrompt] = useState("");

  // Load template
  useEffect(() => {
    if (template) {
      setName(template.name);
      setDescription(template.description ?? "");
      setSteps((template.steps ?? []).map((s: Record<string, unknown>, i: number) => ({
        id: -(i + 1),
        name: s.name as string,
        role: s.role as string,
        systemPrompt: s.systemPrompt as string,
        stepType: (s.stepType as string) ?? "agent",
        ifConfig: (s.ifConfig ?? null) as EditableStep["ifConfig"],
        whileConfig: (s.whileConfig ?? null) as EditableStep["whileConfig"],
        temperature: (s.temperature as string) ?? "0.7",
        maxTokens: (s.maxTokens as number) ?? 4096,
      })));
    }
  }, [template]);

  // For new template, start with a basic builder
  useEffect(() => {
    if (isNew && steps.length === 0) {
      setSteps([{ id: -1, name: t("common:agentRoles.builder"), role: "builder", systemPrompt: "Create comprehensive initial drafts based on the request.", stepType: "agent", temperature: "0.7", maxTokens: 4096 }]);
    }
  }, [isNew]);

  const updateMutation = trpc.template.update.useMutation({
    onSuccess: () => { toast.success(t("pages:pipeline.saved")); utils.template.list.invalidate(); },
    onError: (err) => toast.error(err.message),
  });
  const createEmpty = trpc.template.createEmpty.useMutation({
    onSuccess: (data) => { navigate(`/pipelines/${data.id}/edit`); toast.success(t("pages:pipeline.created")); },
    onError: (err) => toast.error(err.message),
  });
  const applyMutation = trpc.template.useInProject.useMutation({
    onSuccess: () => toast.success(t("pages:pipeline.applied")),
    onError: (err) => toast.error(err.message),
  });
  const duplicateTemplate = trpc.template.duplicate.useMutation({
    onSuccess: () => { toast.success(t("pages:pipeline.duplicated")); utils.template.list.invalidate(); },
  });

  const addStep = (role: string, type: string = "agent") => {
    const roleDef = AGENT_ROLES.find((r) => r.slug === role);
    const nextOrder = steps.length + 1;
    const newStep: EditableStep = {
      id: -(Date.now()),
      name: type === "if" ? t("pages:pipeline.ifGate") : type === "while" ? t("pages:pipeline.whileLoop") : type === "approval" ? t("pages:pipeline.humanReview") : (roleDef ? t("common:agentRoles." + roleDef.slug) : t("pages:pipeline.defaultStepName")),
      role: type === "approval" ? "custom" : (roleDef?.slug ?? "custom"),
      systemPrompt: type === "if"
        ? "You are a quality gate reviewer. Analyze the previous output carefully. Provide your FULL assessment. Then on the VERY LAST LINE output EXACTLY ONE of these keywords: pass, revise"
        : type === "while"
        ? "You are a quality checker. Review the previous output carefully. Provide your FULL assessment. Then on the VERY LAST LINE output EXACTLY 'retry' or 'pass'."
        : type === "approval"
        ? "Human-in-the-loop approval step. Pipeline pauses for user review."
        : (roleDef?.sp ?? "Process the previous output."),
      stepType: type,
      temperature: "0.7",
      maxTokens: type === "if" || type === "while" ? 2048 : 4096,
      ifConfig: type === "if" ? { options: ["pass", "revise"], mappings: { pass: nextOrder + 1, revise: Math.max(1, nextOrder - 1) } } : null,
      whileConfig: type === "while" ? { targetStep: Math.max(1, nextOrder - 1), maxIterations: 3 } : null,
    };
    setSteps([...steps, newStep]);
    setExpandedIdx(steps.length);
  };

  const removeStep = (idx: number) => {
    const n = steps.filter((_, i) => i !== idx);
    setSteps(n);
    if (expandedIdx === idx) setExpandedIdx(null);
  };

  const moveStep = (idx: number, dir: number) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= steps.length) return;
    const n = [...steps];
    [n[idx], n[newIdx]] = [n[newIdx], n[idx]];
    setSteps(n);
  };

  const duplicateStep = (idx: number) => {
    const n = [...steps];
    n.splice(idx + 1, 0, { ...steps[idx], id: -(Date.now()) });
    setSteps(n);
  };

  const handleSave = () => {
    if (!name.trim()) { toast.error(t("pages:pipeline.nameRequired")); return; }
    if (isNew) {
      // Create and save
      createEmpty.mutate({ name: name.trim() }, {
        onSuccess: (data) => {
          // After creation, update with actual steps
          setTimeout(() => {
            utils.client.template.update.mutate({
              id: data.id, name: name.trim(), description,
              steps: steps.map((s) => ({ name: s.name, role: s.role, systemPrompt: s.systemPrompt, stepType: s.stepType, ifConfig: s.ifConfig, whileConfig: s.whileConfig, temperature: s.temperature, maxTokens: s.maxTokens })),
            });
          }, 100);
        },
      });
    } else {
      updateMutation.mutate({
        id: templateId, name: name.trim(), description,
        steps: steps.map((s) => ({ name: s.name, role: s.role, systemPrompt: s.systemPrompt, stepType: s.stepType, ifConfig: s.ifConfig, whileConfig: s.whileConfig, temperature: s.temperature, maxTokens: s.maxTokens })),
      });
    }
  };

  if (!isNew && isLoading) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="w-8 h-8 text-blue-400 animate-spin" /></div>;
  }

  if (!isMaster) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <Lock className="w-12 h-12 text-amber-400" />
        <h2 className="text-xl font-bold text-neutral-200">{t("pages:pipeline.tierRequired", { tier: TIERS.pro_designer.label })}</h2>
        <p className="text-sm text-neutral-500">{t("pages:pipeline.tierRequiredMsg")}</p>
        <Link to="/pipelines" className="text-sm text-blue-400 hover:underline">{t("pages:pipeline.backToPipelines")}</Link>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-neutral-950">
      {/* Header */}
      <div className="shrink-0 border-b border-neutral-800 bg-neutral-900 px-4 py-2 flex items-center gap-3">
        <Link to="/pipelines" className="text-neutral-500 hover:text-neutral-300"><ArrowLeft className="w-4 h-4" /></Link>
        <Workflow className="w-5 h-5 text-blue-400" />
        <div className="flex-1 flex items-center gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("pages:pipeline.namePlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-sm w-64 h-8" />
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("pages:pipeline.descriptionPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-sm flex-1 h-8" />
        </div>
        <div className="flex items-center gap-2">
          {/* Use in Chat */}
          <div className="relative group">
            <Button variant="outline" size="sm" className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 h-8 text-xs">
              <Zap className="w-3 h-3 mr-1" /> {t("pages:pipeline.useInChat")}
            </Button>
            <div className="absolute right-0 top-8 z-50 w-48 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl py-1 hidden group-hover:block">
              {userProjects?.map((p) => (
                <button key={p.id} onClick={() => applyMutation.mutate({ templateId, projectId: p.id })}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 text-left">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />{p.name}
                </button>
              )) ?? <p className="text-xs text-neutral-600 px-3 py-1">{t("pages:pipeline.noChats")}</p>}
            </div>
          </div>
          {!isNew && (
            <Button size="sm" variant="outline" className="border-neutral-700 text-neutral-400 hover:bg-neutral-800 h-8 text-xs" onClick={() => duplicateTemplate.mutate({ id: templateId })} disabled={duplicateTemplate.isPending}>
              <Copy className="w-3 h-3 mr-1" /> {t("pages:pipeline.duplicate")}
            </Button>
          )}
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700 h-8 text-xs" onClick={handleSave} disabled={updateMutation.isPending || createEmpty.isPending}>
            {updateMutation.isPending || createEmpty.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
            {t("pages:pipeline.save")}
          </Button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Agent Library */}
        <div className="w-56 border-r border-neutral-800 bg-neutral-900 overflow-y-auto p-3 space-y-4">
          <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">{t("pages:pipeline.agentRoles")}</h3>
          {AGENT_ROLES.map((role) => (
            <button key={role.slug} onClick={() => addStep(role.slug, "agent")}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors text-left">
              <Plus className="w-3 h-3" /><span className={role.color}>{t("common:agentRoles." + role.slug)}</span>
            </button>
          ))}

          <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider pt-2 border-t border-neutral-800">{t("pages:pipeline.specialSteps")}</h3>
          <button onClick={() => addStep("critic", "if")} className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-amber-400 hover:bg-neutral-800 transition-colors text-left">
            <GitBranch className="w-3 h-3" /> {t("pages:pipeline.ifGate")}
          </button>
          <button onClick={() => addStep("critic", "while")} className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-purple-400 hover:bg-neutral-800 transition-colors text-left">
            <RefreshCw className="w-3 h-3" /> {t("pages:pipeline.whileLoop")}
          </button>
          {isSage && (
            <button onClick={() => addStep("custom", "approval")} className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-green-400 hover:bg-neutral-800 transition-colors text-left">
              <UserCheck className="w-3 h-3" /> {t("pages:pipeline.humanReview")}
            </button>
          )}

          {agentsData?.userAgents && agentsData.userAgents.length > 0 && (
            <>
              <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider pt-2 border-t border-neutral-800">{t("pages:pipeline.myAgents")}</h3>
              {agentsData.userAgents.map((agent) => (
                <button key={agent.id} onClick={() => {
                  const newStep: EditableStep = { id: -(Date.now()), name: agent.name, role: agent.role, systemPrompt: agent.systemPrompt, stepType: "agent", providerId: agent.defaultProviderId, model: agent.defaultModel, temperature: agent.temperature ?? "0.7", maxTokens: agent.maxTokens ?? 4096 };
                  setSteps([...steps, newStep]);
                }} className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-neutral-300 hover:bg-neutral-800 text-left truncate">
                  <Bot className="w-3 h-3 text-blue-400" />{agent.name}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Right: Steps */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-2 max-w-2xl">
            {steps.length === 0 && (
              <div className="text-center py-12 text-neutral-600">
                <Workflow className="w-10 h-10 mx-auto mb-3" />
                <p className="text-sm">{t("pages:pipeline.emptyPrompt")}</p>
              </div>
            )}
            {steps.map((step, idx) => {
              const cfg = STEP_ICONS[step.stepType] ?? STEP_ICONS.agent;
              const Icon = cfg.icon;
              const isOpen = expandedIdx === idx;
              return (
                <div key={step.id} className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
                  {/* Header */}
                  <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-neutral-800/50" onClick={() => { setExpandedIdx(isOpen ? null : idx); setEditPrompt(step.systemPrompt); }}>
                    <span className="text-xs text-neutral-600 w-5">{idx + 1}</span>
                    <Icon className={`w-4 h-4 ${cfg.color}`} />
                    <span className="text-sm font-medium text-neutral-200 flex-1">{step.name}</span>
                    <span className="text-xs text-neutral-600 capitalize">{step.stepType}</span>
                    <div className="flex items-center gap-1">
                      <button onClick={(e) => { e.stopPropagation(); moveStep(idx, -1); }} className="text-neutral-600 hover:text-neutral-300 px-1" disabled={idx === 0}>↑</button>
                      <button onClick={(e) => { e.stopPropagation(); moveStep(idx, 1); }} className="text-neutral-600 hover:text-neutral-300 px-1" disabled={idx === steps.length - 1}>↓</button>
                      <button onClick={(e) => { e.stopPropagation(); duplicateStep(idx); }} className="text-neutral-600 hover:text-neutral-300 px-1"><Copy className="w-3 h-3" /></button>
                      <button onClick={(e) => { e.stopPropagation(); removeStep(idx); }} className="text-neutral-600 hover:text-red-400 px-1"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  </div>
                  {/* Collapsed preview of system prompt (issue #6 — prevent user thinking prompt was truncated) */}
                  {!isOpen && step.systemPrompt && (
                    <div
                      className="px-3 pb-2 pt-0 cursor-pointer"
                      onClick={() => { setExpandedIdx(idx); setEditPrompt(step.systemPrompt); }}
                    >
                      <p className="text-[11px] text-neutral-500 font-mono leading-snug">
                        <span className="text-neutral-600 mr-1">›</span>
                        {step.systemPrompt.length > 250
                          ? `${step.systemPrompt.substring(0, 250).replace(/\s+/g, " ")}…`
                          : step.systemPrompt.replace(/\s+/g, " ")}
                        {step.systemPrompt.length > 250 && (
                          <span className="text-blue-400/70 ml-1">({step.systemPrompt.length} chars)</span>
                        )}
                      </p>
                      {step.systemPrompt.length > 250 && (
                        <p className="text-[10px] text-blue-400/60 mt-0.5 italic">{t("pages:pipeline.expandPrompt")}</p>
                      )}
                    </div>
                  )}
                  {/* Expanded */}
                  {isOpen && (
                    <div className="px-3 pb-3 border-t border-neutral-800 pt-2 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.stepName")}</Label><Input value={step.name} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], name: e.target.value }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5" /></div>
                        <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.stepRole")}</Label><Input value={step.role} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], role: e.target.value }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5" /></div>
                      </div>
                      <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.systemPrompt")}</Label>
                        <Textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} onBlur={() => { const n = [...steps]; n[idx] = { ...n[idx], systemPrompt: editPrompt }; setSteps(n); }} rows={4} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs mt-0.5 resize-none" />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.temperatureShort")}</Label><Input type="number" min={0} max={2} step={0.1} value={step.temperature ?? "0.7"} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], temperature: e.target.value }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5" /></div>
                        <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.maxTokens")}</Label><Input type="number" value={step.maxTokens ?? 4096} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], maxTokens: parseInt(e.target.value) || 4096 }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-8 mt-0.5" /></div>
                        <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.stepType")}</Label>
                          <select value={step.stepType} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], stepType: e.target.value }; setSteps(n); }} className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 text-xs h-8 rounded px-2 mt-0.5">
                            <option value="agent">{t("pages:pipeline.agentOption")}</option><option value="if">{t("pages:pipeline.ifGateOption")}</option><option value="while">{t("pages:pipeline.whileOption")}</option><option value="approval">{t("pages:pipeline.humanReviewOption")}</option>
                          </select>
                        </div>
                      </div>
                      {/* IF config */}
                      {step.stepType === "if" && (
                        <div className="p-2 rounded bg-amber-500/5 border border-amber-500/10 space-y-1">
                          <p className="text-xs font-medium text-amber-400">{t("pages:pipeline.ifConfig")}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-neutral-500">{t("pages:pipeline.options")}</span>
                            <Input value={step.ifConfig?.options?.join(", ") ?? ""} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], ifConfig: { ...(n[idx].ifConfig ?? { options: [], mappings: {} }), options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) } }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-7 flex-1" placeholder={t("pages:pipeline.optionsPlaceholder")} />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-neutral-500">{t("pages:pipeline.reviseTarget")}</span>
                            <Input type="number" min={1} max={steps.length} value={step.ifConfig?.mappings?.revise ?? 1} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], ifConfig: { ...(n[idx].ifConfig ?? { options: ["pass", "revise"], mappings: {} }), mappings: { ...(n[idx].ifConfig?.mappings ?? {}), revise: parseInt(e.target.value) || 1 } } }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-7 w-20" />
                          </div>
                        </div>
                      )}
                      {/* WHILE config */}
                      {step.stepType === "while" && (
                        <div className="p-2 rounded bg-purple-500/5 border border-purple-500/10 space-y-1">
                          <p className="text-xs font-medium text-purple-400">{t("pages:pipeline.whileConfig")}</p>
                          <div className="grid grid-cols-2 gap-2">
                            <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.targetStep")}</Label><Input type="number" min={1} max={steps.length} value={step.whileConfig?.targetStep ?? 1} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], whileConfig: { ...(n[idx].whileConfig ?? { targetStep: 1, maxIterations: 3 }), targetStep: parseInt(e.target.value) || 1 } }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-7 mt-0.5" /></div>
                            <div><Label className="text-xs text-neutral-500">{t("pages:pipeline.maxIterations")}</Label><Input type="number" min={1} max={5} value={step.whileConfig?.maxIterations ?? 3} onChange={(e) => { const n = [...steps]; n[idx] = { ...n[idx], whileConfig: { ...(n[idx].whileConfig ?? { targetStep: 1, maxIterations: 3 }), maxIterations: parseInt(e.target.value) || 3 } }; setSteps(n); }} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs h-7 mt-0.5" /></div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
