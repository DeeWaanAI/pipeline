import { useState, useEffect } from "react";
import { useParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import {
  Bot,
  Loader2,
  Save,
  ArrowLeft,
  GitBranch,
  CheckCircle2,
  Workflow,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Unlink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  requestFolderAccess,
  createAndLinkFolder,
  restoreFolderAccess,
  unlinkFolder,
  isLocalFolderSupported,
  getStoredFallbackFolder,
  clearFallbackFolder,
  type LocalFolderState,
} from "@/lib/localFolder";

function PipelineSelector({ projectId }: { projectId: number }) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: templates } = trpc.template.list.useQuery();
  const { data: project } = trpc.project.getById.useQuery({ id: projectId });
  const { data: pipelineConfig } = trpc.swarm.getPipeline.useQuery({ projectId });
  const utils = trpc.useUtils();

  const applyMutation = trpc.template.useInProject.useMutation({
    onSuccess: () => {
      utils.swarm.getPipeline.invalidate({ projectId });
      toast.success(t("settings:projectSettings.pipeline.applied"));
    },
  });
  const saveAsTemplate = trpc.template.createFromPipeline.useMutation({
    onSuccess: () => { toast.success(t("settings:projectSettings.pipeline.savedToMyPipelines")); utils.template.list.invalidate(); },
  });

  const currentTemplateId = project?.pipelineTemplateId;
  const currentName = currentTemplateId
    ? templates?.find((t) => t.id === currentTemplateId)?.name
    : (pipelineConfig?.isCustom ? t("settings:projectSettings.pipeline.custom") : t("settings:projectSettings.pipeline.standard"));

  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2 mb-4">
        <Workflow className="w-5 h-5 text-blue-400" />
        {t("settings:projectSettings.pipeline.title")}
      </h2>
      <Card className="bg-neutral-900 border-neutral-800">
        <CardContent className="py-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-400">{t("settings:projectSettings.pipeline.current")}</span>
            <span className="text-sm font-medium text-blue-400">{currentName ?? t("settings:projectSettings.pipeline.standard")}</span>
            <span className="text-xs text-neutral-600">({t("settings:projectSettings.pipeline.steps", { count: pipelineConfig?.steps.length ?? 4 })})</span>
          </div>
          <div className="relative">
            <select
              className="w-full bg-neutral-800 border border-neutral-700 text-neutral-100 text-sm rounded px-3 py-2 appearance-none cursor-pointer"
              onChange={(e) => {
                const tid = parseInt(e.target.value);
                if (tid > 0) applyMutation.mutate({ templateId: tid, projectId });
              }}
              value={currentTemplateId ?? ""}
            >
              <option value="">{t("settings:projectSettings.pipeline.standardOption")}</option>
              {templates?.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name} ({t("settings:projectSettings.pipeline.steps", { count: tpl.steps.length })})</option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-neutral-500 absolute right-3 top-2.5 pointer-events-none" />
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-neutral-800">
            {pipelineConfig?.isCustom && (
              <Button size="sm" variant="outline" onClick={() => saveAsTemplate.mutate({ name: `${project?.name ?? t("settings:projectSettings.pipeline.custom")} Pipeline`, projectId })} disabled={saveAsTemplate.isPending} className="border-neutral-700 text-neutral-400 hover:bg-neutral-800 text-xs h-8">
                <Save className="w-3 h-3 mr-1" /> {t("settings:projectSettings.pipeline.saveToMyPipelines")}
              </Button>
            )}
            <Link to="/pipelines">
              <Button size="sm" variant="ghost" className="text-neutral-500 hover:text-neutral-300 text-xs h-8">
                <ExternalLink className="w-3 h-3 mr-1" /> {t("settings:projectSettings.pipeline.managePipelines")}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AgentEditor({ agent, onUpdate }: { agent: { id: number; name: string; slug: string; role: string; systemPrompt: string; temperature: string | null; model: string | null; isEnabled: boolean | null }; onUpdate: (id: number, data: Record<string, unknown>) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const [prompt, setPrompt] = useState(agent.systemPrompt);
  const [temp, setTemp] = useState(agent.temperature ?? "0.7");
  const [model, setModel] = useState(agent.model ?? "");
  const roleColors: Record<string, string> = { builder: "bg-blue-500", critic: "bg-amber-500", refiner: "bg-violet-500", polisher: "bg-blue-500", custom: "bg-neutral-500" };
  return (
    <Card className="bg-neutral-900 border-neutral-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${roleColors[agent.role] ?? "bg-neutral-500"}`} />
            <div>
              <CardTitle className="text-sm font-semibold text-neutral-100">{agent.name}</CardTitle>
              <CardDescription className="text-xs">{t("settings:projectSettings.agents.roleLabel", "Role")}: {t(`common:agentRoles.${agent.role}`, agent.role)} | Slug: {agent.slug}</CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <label className="text-xs font-medium text-neutral-400 mb-1 block">{t("settings:projectSettings.agents.systemPromptLabel")}</label>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs font-mono" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-neutral-400 mb-1 block">{t("settings:projectSettings.agents.temperatureLabel")}</label>
            <Input value={temp} onChange={(e) => setTemp(e.target.value)} className="bg-neutral-800 border-neutral-700 text-neutral-100" />
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-400 mb-1 block">{t("settings:projectSettings.agents.modelLabel")}</label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("settings:projectSettings.agents.modelPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" />
          </div>
        </div>
        <Button size="sm" onClick={() => onUpdate(agent.id, { systemPrompt: prompt, temperature: temp, model: model || null })} className="bg-blue-600 hover:bg-blue-700 text-white">
          <Save className="w-3.5 h-3.5 mr-1" />{t("settings:projectSettings.agents.saveChanges")}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function ProjectSettings() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id ?? "0");
  const { t } = useTranslation(["settings", "common"]);

  const { data: project, isLoading: projectLoading } = trpc.project.getById.useQuery({ id: projectId });
  const { data: agents, isLoading: agentsLoading } = trpc.agent.list.useQuery({ projectId });

  const utils = trpc.useUtils();
  const updateProject = trpc.project.update.useMutation({
    onSuccess: () => utils.project.getById.invalidate({ id: projectId }),
  });
  const updateAgent = trpc.agent.update.useMutation({
    onSuccess: () => utils.agent.list.invalidate({ projectId }),
  });
  const [saved, setSaved] = useState(false);

  const [giteeOwner, setGiteeOwner] = useState(project?.giteeOwner ?? "");
  const [giteeRepo, setGiteeRepo] = useState(project?.giteeRepo ?? "");
  const [githubOwner, setGithubOwner] = useState(project?.githubOwner ?? "");
  const [githubRepo, setGithubRepo] = useState(project?.githubRepo ?? "");
  const [localFolder, setLocalFolder] = useState<LocalFolderState | null>(null);
  const [fallbackFolder, setFallbackFolder] = useState<{ name: string; fileCount: number } | null>(null);
  const [localFolderLoading, setLocalFolderLoading] = useState(true);
  const [newFolderName, setNewFolderName] = useState("");
  const [showCreateInput, setShowCreateInput] = useState(false);

  useEffect(() => {
    if (!projectId) { setLocalFolderLoading(false); return; }
    if (isLocalFolderSupported()) {
      restoreFolderAccess(projectId)
        .then((state) => { if (state) setLocalFolder(state); })
        .catch(() => {})
        .finally(() => setLocalFolderLoading(false));
    } else {
      const stored = getStoredFallbackFolder();
      if (stored) setFallbackFolder({ name: stored.name, fileCount: stored.fileCount });
      setLocalFolderLoading(false);
    }
  }, [projectId]);

  const handleLinkFolder = async () => {
    if (!projectId) return;
    try {
      const state = await requestFolderAccess(projectId);
      setLocalFolder(state);
      updateProject.mutate({ id: projectId, localFolderName: state.path });
    } catch {
      toast.error(t("settings:projectSettings.localFolder.linkFailed"));
    }
  };

  const handleCreateFolder = async () => {
    if (!projectId || !newFolderName.trim()) return;
    try {
      const state = await createAndLinkFolder(projectId, newFolderName.trim());
      setLocalFolder(state);
      setShowCreateInput(false);
      setNewFolderName("");
      updateProject.mutate({ id: projectId, localFolderName: state.path });
      toast.success(t("settings:projectSettings.localFolder.createSuccess", { path: state.path }));
    } catch (err) {
      toast.error(`${t("settings:projectSettings.localFolder.createFailed")}: ${(err as Error).message}`);
    }
  };

  const handleUnlinkFolder = async () => {
    if (!projectId) return;
    if (localFolder) { await unlinkFolder(projectId); setLocalFolder(null); }
    if (fallbackFolder) { clearFallbackFolder(); setFallbackFolder(null); }
    updateProject.mutate({ id: projectId, localFolderName: "" });
    toast.success(t("settings:projectSettings.localFolder.unlinkSuccess"));
  };

  const isFolderConnected = !!localFolder || !!fallbackFolder || !!project?.localFolderName;

  const handleUpdateGitee = () => {
    updateProject.mutate({ id: projectId, giteeOwner: giteeOwner || undefined, giteeRepo: giteeRepo || undefined });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const handleUpdateGithub = () => {
    updateProject.mutate({ id: projectId, githubOwner: githubOwner || undefined, githubRepo: githubRepo || undefined });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  if (projectLoading) return <AppShell><div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div></AppShell>;
  if (!project) return <AppShell><div className="flex items-center justify-center h-full text-neutral-500">{t("common:errors.projectNotFound")}</div></AppShell>;

  return (
    <AppShell>
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <Link to={`/projects/${projectId}`} className="text-neutral-500 hover:text-neutral-300 transition-colors"><ArrowLeft className="w-5 h-5" /></Link>
          <div>
            <h1 className="text-2xl font-bold text-neutral-100">{project.name}</h1>
            <p className="text-sm text-neutral-500">{t("settings:projectSettings.title")}</p>
          </div>
        </div>

        {/* Gitee */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2 mb-4"><GitBranch className="w-5 h-5 text-blue-400" />{t("settings:projectSettings.gitee.title")}</h2>
          <Card className="bg-neutral-900 border-neutral-800">
            <CardContent className="py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-neutral-400 mb-1 block">{t("settings:projectSettings.gitee.ownerLabel")}</label><Input defaultValue={project.giteeOwner ?? ""} onChange={(e) => setGiteeOwner(e.target.value)} placeholder={t("settings:projectSettings.gitee.ownerPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" /></div>
                <div><label className="text-xs font-medium text-neutral-400 mb-1 block">{t("settings:projectSettings.gitee.repoLabel")}</label><Input defaultValue={project.giteeRepo ?? ""} onChange={(e) => setGiteeRepo(e.target.value)} placeholder={t("settings:projectSettings.gitee.repoPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" /></div>
              </div>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={handleUpdateGitee} className="bg-blue-600 hover:bg-blue-700 text-white">{saved ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />{t("common:status.saved")}</> : <><Save className="w-3.5 h-3.5 mr-1" />{t("common:actions.save")}</>}</Button>
                {project.giteeOwner && project.giteeRepo && <span className="flex items-center gap-1 text-xs text-blue-400"><CheckCircle2 className="w-3.5 h-3.5" />{t("settings:projectSettings.gitee.connected", { owner: project.giteeOwner, repo: project.giteeRepo })}</span>}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* GitHub */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2 mb-4"><GitBranch className="w-5 h-5 text-neutral-400" />{t("settings:projectSettings.github.title")}</h2>
          <Card className="bg-neutral-900 border-neutral-800">
            <CardContent className="py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-neutral-400 mb-1 block">{t("settings:projectSettings.github.ownerLabel")}</label><Input defaultValue={project.githubOwner ?? ""} onChange={(e) => setGithubOwner(e.target.value)} placeholder={t("settings:projectSettings.github.ownerPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" /></div>
                <div><label className="text-xs font-medium text-neutral-400 mb-1 block">{t("settings:projectSettings.github.repoLabel")}</label><Input defaultValue={project.githubRepo ?? ""} onChange={(e) => setGithubRepo(e.target.value)} placeholder={t("settings:projectSettings.github.repoPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100" /></div>
              </div>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={handleUpdateGithub} className="bg-neutral-700 hover:bg-neutral-600 text-white">{saved ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />{t("common:status.saved")}</> : <><Save className="w-3.5 h-3.5 mr-1" />{t("common:actions.save")}</>}</Button>
                {project.githubOwner && project.githubRepo && <span className="flex items-center gap-1 text-xs text-neutral-400"><CheckCircle2 className="w-3.5 h-3.5" />{t("settings:projectSettings.github.connected", { owner: project.githubOwner, repo: project.githubRepo })}</span>}
              </div>
              <p className="text-xs text-neutral-600">{t("settings:projectSettings.github.tokenNote")}</p>
            </CardContent>
          </Card>
        </div>

        {/* Local Folder */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2 mb-4"><FolderOpen className="w-5 h-5 text-emerald-400" />{t("settings:projectSettings.localFolder.title")}</h2>
          <Card className="bg-neutral-900 border-neutral-800">
            <CardContent className="py-4 space-y-3">
              {localFolderLoading ? (
                <div className="flex items-center gap-2 text-xs text-neutral-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("settings:projectSettings.localFolder.checking")}</div>
              ) : isFolderConnected ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <div>
                      <p className="text-sm text-neutral-200 font-medium">{localFolder?.path ?? fallbackFolder?.name ?? project?.localFolderName}</p>
                      <p className="text-xs text-neutral-500">{t("settings:projectSettings.localFolder.linked")}</p>
                      {fallbackFolder && <p className="text-xs text-amber-400/80 mt-0.5">{t("settings:projectSettings.localFolder.fallbackNote")}</p>}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={handleUnlinkFolder} className="border-neutral-700 text-red-400 hover:bg-red-500/10 text-xs"><Unlink className="w-3.5 h-3.5 mr-1" />{t("settings:projectSettings.localFolder.unlink")}</Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-neutral-500">{t("settings:projectSettings.localFolder.description")}</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" onClick={handleLinkFolder} className="bg-emerald-600 hover:bg-emerald-700 text-white"><FolderOpen className="w-3.5 h-3.5 mr-1" />{t("settings:projectSettings.localFolder.linkButton")}</Button>
                    <Button size="sm" variant="outline" onClick={() => setShowCreateInput(!showCreateInput)} className="border-emerald-700/50 text-emerald-400 hover:bg-emerald-500/10">{t("settings:projectSettings.localFolder.createButton")}</Button>
                  </div>
                  {showCreateInput && (
                    <div className="flex items-center gap-2">
                      <Input value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder={t("settings:projectSettings.localFolder.newFolderPlaceholder")} className="bg-neutral-800 border-neutral-700 text-neutral-100 text-sm h-8" onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); }} />
                      <Button size="sm" onClick={handleCreateFolder} disabled={!newFolderName.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8">{t("common:actions.create")}</Button>
                    </div>
                  )}
                </div>
              )}
              <p className="text-xs text-neutral-600">{t("settings:projectSettings.localFolder.apiNote")}</p>
            </CardContent>
          </Card>
        </div>

        <PipelineSelector projectId={projectId} />

        <div>
          <h2 className="text-lg font-semibold text-neutral-200 flex items-center gap-2 mb-4"><Bot className="w-5 h-5 text-blue-400" />{t("settings:projectSettings.agents.title")}</h2>
          <p className="text-sm text-neutral-500 mb-4">{t("settings:projectSettings.agents.description")}</p>
          {agentsLoading ? <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
            : agents && agents.length > 0 ? <div className="space-y-4">{agents.map((agent) => <AgentEditor key={agent.id} agent={agent} onUpdate={(id, data) => updateAgent.mutate({ id, ...data })} />)}</div>
            : <Card className="bg-neutral-900 border-neutral-800 border-dashed"><CardContent className="flex flex-col items-center py-10 text-center"><Bot className="w-8 h-8 text-neutral-600 mb-3" /><p className="text-sm text-neutral-500">{t("common:emptyStates.noData")}</p></CardContent></Card>}
        </div>
      </div>
    </AppShell>
  );
}
