// My Pipelines page - reusable pipeline templates
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Workflow,
  Plus,
  Copy,
  Trash2,
  Wand2,
  GitBranch,
  RefreshCw,
  UserCheck,
  ChevronRight,
  Bot,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";

const STEP_TYPE_ICONS: Record<string, { icon: typeof Bot; color: string; label: string }> = {
  agent:    { icon: Bot,         color: "text-blue-400",   label: "Agent" },
  if:       { icon: GitBranch,   color: "text-amber-400",  label: "IF" },
  while:    { icon: RefreshCw,   color: "text-purple-400", label: "WHILE" },
  approval: { icon: UserCheck,   color: "text-green-400",  label: "Approval" },
};

export default function MyPipelines() {
  const { t } = useTranslation("pages");
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { data: templates, isLoading } = trpc.template.list.useQuery();
  const { data: userProjects } = trpc.project.list.useQuery();

  const [createName, setCreateName] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const createEmptyTemplate = trpc.template.createEmpty.useMutation({
    onSuccess: (data) => {
      toast.success(t("pages:myPipelines.toasts.created"));
      setShowCreateDialog(false);
      setCreateName("");
      navigate(`/pipelines/${data.id}/edit`);
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.template.delete.useMutation({
    onSuccess: () => { utils.template.list.invalidate(); toast.success(t("pages:myPipelines.toasts.deleted")); },
  });
  const duplicateMutation = trpc.template.duplicate.useMutation({
    onSuccess: () => { utils.template.list.invalidate(); toast.success(t("pages:myPipelines.toasts.duplicated")); },
  });
  const applyMutation = trpc.template.useInProject.useMutation({
    onSuccess: () => {
      toast.success(t("pages:myPipelines.toasts.applied"));
      utils.template.list.invalidate();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Workflow className="w-8 h-8 text-blue-400 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <Link to="/" className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 mb-2">
            <ArrowLeft className="w-3 h-3" /> {t("pages:myPipelines.backToDashboard")}
          </Link>
          <h1 className="text-2xl font-bold text-neutral-100 flex items-center gap-2">
            <Workflow className="w-6 h-6 text-blue-400" />
            {t("pages:myPipelines.title")}
          </h1>
          <p className="text-sm text-neutral-500 mt-1">
            {t("pages:myPipelines.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                {t("pages:myPipelines.createPipeline")}
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-neutral-900 border-neutral-800">
              <DialogHeader>
                <DialogTitle className="text-neutral-100">{t("pages:myPipelines.createNewPipeline")}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 mt-2">
                <p className="text-sm text-neutral-400">
                  {t("pages:myPipelines.createDesc")}
                </p>
                <Input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder={t("pages:myPipelines.namePlaceholder")}
                  className="bg-neutral-800 border-neutral-700 text-neutral-100"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && createName.trim()) {
                      createEmptyTemplate.mutate({ name: createName.trim() });
                    }
                  }}
                />
                <Button
                  className="w-full bg-blue-600 hover:bg-blue-700"
                  disabled={createEmptyTemplate.isPending || !createName.trim()}
                  onClick={() => createEmptyTemplate.mutate({ name: createName.trim() })}
                >
                  {createEmptyTemplate.isPending ? t("pages:myPipelines.creating") : t("pages:myPipelines.createAndDesign")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Templates Grid */}
      {templates && templates.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((template) => {
            const steps = template.steps ?? [];
            const stepTypes = steps.map((s: { stepType?: string }) => s.stepType ?? "agent");
            const uniqueTypes = [...new Set(stepTypes)];

            return (
              <Card key={template.id} className="bg-neutral-900 border-neutral-800 hover:border-neutral-700 transition-colors">
                <CardContent className="p-4">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-neutral-200 truncate">{template.name}</h3>
                        {template.isAuto && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 flex items-center gap-1">
                            <Wand2 className="w-3 h-3" /> {t("pages:myPipelines.card.autoDesignBadge")}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-500 mt-0.5 truncate">
                        {template.description ?? t("pages:myPipelines.card.steps", { count: steps.length })}
                      </p>
                    </div>
                  </div>

                  {/* Step type icons */}
                  <div className="flex items-center gap-2 mb-3">
                    {uniqueTypes.map((type) => {
                      const cfg = STEP_TYPE_ICONS[type as string] ?? STEP_TYPE_ICONS.agent;
                      const count = stepTypes.filter((t) => t === type).length;
                      const Icon = cfg.icon;
                      return (
                        <div key={type} className={`flex items-center gap-1 text-xs ${cfg.color}`} title={`${count} ${cfg.label}${count > 1 ? "s" : ""}`}>
                          <Icon className="w-3.5 h-3.5" />
                          <span>{count}</span>
                        </div>
                      );
                    })}
                    <span className="text-xs text-neutral-600 ml-auto">
                      {t("pages:myPipelines.card.chats", { count: template.usageCount })}
                    </span>
                  </div>

                  {/* Step names preview */}
                  <div className="flex flex-wrap gap-1 mb-3">
                    {steps.slice(0, 5).map((s: { name: string; stepType?: string }, i: number) => {
                      const typeColor = STEP_TYPE_ICONS[s.stepType ?? "agent"]?.color.replace("text-", "bg-").replace("400", "500/10") ?? "bg-blue-500/10";
                      return (
                        <span key={i} className={`text-xs px-1.5 py-0.5 rounded ${typeColor} text-neutral-400`}>
                          {s.name}
                        </span>
                      );
                    })}
                    {steps.length > 5 && (
                      <span className="text-xs text-neutral-600">{t("pages:myPipelines.card.more", { count: steps.length - 5 })}</span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-3 border-t border-neutral-800">
                    {/* Edit pipeline */}
                    <Link to={`/pipelines/${template.id}/edit`}>
                      <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 h-7 text-xs px-2">
                        <Workflow className="w-3 h-3 mr-1" />{t("pages:myPipelines.card.edit")}
                      </Button>
                    </Link>

                    {/* Apply to chat */}
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 h-7 text-xs px-2">
                          <ChevronRight className="w-3 h-3 mr-1" />{t("pages:myPipelines.card.useInChat")}
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="bg-neutral-900 border-neutral-800">
                        <DialogHeader>
                          <DialogTitle className="text-neutral-100">{t("pages:myPipelines.applyDialog.title")}</DialogTitle>
                        </DialogHeader>
                        <div className="mt-2 space-y-1 max-h-60 overflow-y-auto">
                          {userProjects && userProjects.length > 0 ? (
                            userProjects.map((p) => (
                              <button
                                key={p.id}
                                onClick={() => {
                                  applyMutation.mutate({ templateId: template.id, projectId: p.id });
                                }}
                                className="flex items-center gap-2 w-full px-3 py-2 rounded text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors text-left"
                              >
                                <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                                <span className="truncate">{p.name}</span>
                              </button>
                            ))
                          ) : (
                            <p className="text-sm text-neutral-500 px-3">{t("pages:myPipelines.applyDialog.noChats")}</p>
                          )}
                        </div>
                      </DialogContent>
                    </Dialog>

                    <div className="flex-1" />

                    <Button
                      variant="ghost" size="sm"
                      onClick={() => duplicateMutation.mutate({ id: template.id })}
                      className="text-neutral-500 hover:text-neutral-300 h-7 w-7 p-0"
                      title={t("pages:myPipelines.card.duplicate")}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        if (confirm(t("pages:myPipelines.card.deleteConfirm"))) {
                          deleteMutation.mutate({ id: template.id });
                        }
                      }}
                      className="text-neutral-500 hover:text-red-400 h-7 w-7 p-0"
                      title={t("pages:myPipelines.card.delete")}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16">
          <Workflow className="w-12 h-12 text-neutral-700 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-neutral-400 mb-2">{t("pages:myPipelines.empty.title")}</h3>
          <p className="text-sm text-neutral-600 mb-6 max-w-md mx-auto">
            {t("pages:myPipelines.empty.desc")}
          </p>
          <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setShowCreateDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            {t("pages:myPipelines.empty.createFirst")}
          </Button>
        </div>
      )}
    </div>
  );
}
