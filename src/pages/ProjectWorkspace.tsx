import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useCapabilities } from "@/hooks/useCapabilities";
import ProjectFilesPanel from "@/components/project/ProjectFilesPanel";
import {
  Send, Bot, Loader2, CheckCircle2, AlertCircle,
  ChevronRight, User, Sparkles, Settings,
  Octagon, ThumbsUp, ThumbsDown, MessageSquarePlus,
  Wand2, Zap, Lock, Workflow, ChevronDown, Check,
  Paperclip, X, FileText, Image, FolderOpen, Bug, FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AuditContent } from "@/pages/Audit";
import { toast } from "sonner";

interface PipelineStepInfo {
  stepOrder: number;
  name: string;
  role: string;
  status: "pending" | "running" | "completed" | "error";
  stepType?: string;
}

interface StreamEvent {
  type: "step_start" | "step_complete" | "step_error" | "pipeline_complete" | "pipeline_error" | "awaiting_approval";
  step?: number;
  agentRole?: string;
  agentName?: string;
  lastOutput?: string;
  error?: string;
  totalTokens?: number;
  totalLatencyMs?: number;
  finalResponse?: string;
}

const STEP_PILL = {
  pending: "border-neutral-700 text-neutral-500 bg-neutral-900",
  running: "border-blue-500 text-blue-300 bg-blue-500/10",
  completed: "border-blue-500/30 text-blue-400 bg-blue-500/5",
  error: "border-red-500/50 text-red-300 bg-red-500/10",
};

const STEP_ICON: Record<string, string> = {
  if: "◆",
  while: "↻",
  approval: "👤",
  agent: "●",
};

function PipelineVisualizer({ steps }: { steps: PipelineStepInfo[] }) {
  const { t } = useTranslation("pages");
  if (steps.length === 0) return null;
  return (
    <div className="border-b border-neutral-800 bg-neutral-900/50">
      <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto">
        <span className="text-xs font-medium text-neutral-500 whitespace-nowrap mr-1">{t("pages:workspace.toolbar.pipelineLabel")}</span>
        {steps.map((step, i) => (
          <div key={`${step.role}-${i}`} className="flex items-center gap-1 shrink-0">
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium border transition-all duration-500 ${STEP_PILL[step.status]}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${
                step.status === "completed" ? "bg-blue-400" : step.status === "running" ? "bg-blue-400" : step.status === "error" ? "bg-red-400" : "bg-neutral-600"
              }`} />
              {step.stepType && step.stepType !== "agent" && (
                <span className="text-[10px] opacity-60">{STEP_ICON[step.stepType] ?? "●"}</span>
              )}
              <span>{step.name}</span>
              {step.status === "completed" && <CheckCircle2 className="w-3 h-3 ml-0.5 opacity-60" />}
              {step.status === "running" && <Loader2 className="w-3 h-3 ml-0.5 animate-spin" />}
              {step.status === "error" && <AlertCircle className="w-3 h-3 ml-0.5" />}
            </div>
            {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-neutral-700" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ProjectWorkspace() {
  const { t } = useTranslation("pages");
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id ?? "0");
  const { has } = useCapabilities();
  const isProAuto = has("pipeline:autodesign");
  const isMaster = has("pipeline:custom");

  const { data: project, isLoading: projectLoading } = trpc.project.getById.useQuery({ id: projectId });
  const { data: pipelineConfig } = trpc.swarm.getPipeline.useQuery({ projectId }, { enabled: projectId > 0 });
  // Load server-saved preferences to merge chat messages (issue #2/#9)
  const { data: userPrefs } = trpc.llm.loadPreferences.useQuery();
  // Query run status on mount to recover state after navigation
  const { data: runStatus } = trpc.swarm.getRunStatus.useQuery(
    { projectId },
    { enabled: projectId > 0, refetchInterval: 5000 }
  );

  const { data: templateList } = trpc.template.list.useQuery();
  const applyTemplateMutation = trpc.template.useInProject.useMutation({
    onSuccess: () => {
      utils.swarm.getPipeline.invalidate({ projectId });
      toast.success(t("pages:workspace.pipelineApplied"));
    },
  });

  const addMessage = useWorkspaceStore((s) => s.addMessage);
  const mergeMessages = useWorkspaceStore((s) => s.mergeMessages);
  const getMessages = useWorkspaceStore((s) => s.getMessages);
  const projectMessagesMap = useWorkspaceStore((s) => s.projectMessages);
  const getApprovalFn = useWorkspaceStore((s) => s.getApproval);
  const setApprovalStore = useWorkspaceStore((s) => s.setApproval);
  const clearApprovalStore = useWorkspaceStore((s) => s.clearApproval);
  const setPendingPromptStore = useWorkspaceStore((s) => s.setPendingPrompt);
  const clearPendingPromptStore = useWorkspaceStore((s) => s.clearPendingPrompt);
  const setRunStateStore = useWorkspaceStore((s) => s.setRunState);
  const clearRunStateStore = useWorkspaceStore((s) => s.clearRunState);
  // Subscribe to the entire approval map (stable reference) — index in render
  const projectApproval = useWorkspaceStore((s) => s.projectApproval);
  const approvalState = projectApproval[String(projectId)];
  const projectPendingPrompt = useWorkspaceStore((s) => s.projectPendingPrompt);
  const pendingPromptStore = projectPendingPrompt[String(projectId)] ?? null;
  const projectRunState = useWorkspaceStore((s) => s.projectRunState);
  const storedRunState = projectRunState[String(projectId)] ?? null;
  const messages = getMessages(projectId);

  const [input, setInput] = useState("");
  // isRunning is local UI state — synced to store for navigation recovery
  const [isRunning, setIsRunning] = useState(storedRunState?.isRunning ?? false);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStepInfo[]>([]);
  const [currentStepName, setCurrentStepName] = useState<string>("");
  // runId restored from store on mount — survives navigation
  const [runId, setRunId] = useState<number | null>(storedRunState?.runId ?? null);

  // Approval state — synced with persistent store so it survives page navigation
  const awaitingApproval = approvalState?.awaiting ?? false;
  const approvalOutput = approvalState?.output ?? "";
  const [approvalInstructions, setApprovalInstructions] = useState("");
  const [showModifyInput, setShowModifyInput] = useState(false);
  // Prevent mount-recovery useEffect from re-showing approval banner while user action is in flight
  const processingApprovalRef = useRef(false);
  const sendingRef = useRef(false); // Prevents double-submit race condition

  // Auto design
  const [showAutoDesign, setShowAutoDesign] = useState(false);
  const [designTask, setDesignTask] = useState("");
  const [showPipelineMenu, setShowPipelineMenu] = useState(false);

  // Execution mode: "pipeline" (full multi-step) or "agent" (single LLM direct)
  const [executionMode, setExecutionMode] = useState<"pipeline" | "agent">("pipeline");
  // Test mode: when ON, runs are saved to test_data/ and HITL steps auto-approve
  const [isTestRun, setIsTestRun] = useState(false);
  // Project Intelligence Card panel
  const [showProjectPanel, setShowProjectPanel] = useState(true);
  const [showAudit, setShowAudit] = useState(false);
  const [includeProjectInContext, setIncludeProjectInContext] = useState(() => {
    const stored = localStorage.getItem(`include-project-files-${projectId}`);
    return stored !== null ? stored === "true" : true; // default ON
  });
  // Persist the toggle to localStorage
  useEffect(() => {
    localStorage.setItem(`include-project-files-${projectId}`, String(includeProjectInContext));
  }, [includeProjectInContext, projectId]);

  // File attachments for chat
  interface ChatAttachment {
    id: string;
    name: string;
    type: string;
    size: number;
    dataUrl?: string;
    textContent?: string;
  }
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    setUploading(true);

    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch("/api/upload-file", {
          method: "POST",
          headers: {
            "x-local-auth-token": localStorage.getItem("local_auth_token") || "",
          },
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          toast.error(`${t("pages:workspace.chat.uploadFailed")}: ${err.error || err.message || t("pages:workspace.chat.unknownError")}`);
          continue;
        }

        const data = await res.json();
        setAttachments((prev) => [...prev, {
          id: data.id,
          name: data.name,
          type: data.type,
          size: data.size,
          dataUrl: data.dataUrl,
          textContent: data.textContent,
        }]);
        toast.success(t("pages:workspace.chat.uploaded", { name: data.name }));
      } catch (err) {
        toast.error(`${t("pages:workspace.chat.uploadFailed")}: ${(err as Error).message}`);
      }
    }

    setUploading(false);
    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };
  // Pending design prompt — persisted in store so "Run Pipeline" banner survives navigation
  const pendingDesignPrompt = pendingPromptStore;

  const executeMutation = trpc.swarm.execute.useMutation();
  const agentMutation = trpc.swarm.executeAgent.useMutation();
  const prepareMutation = trpc.swarm.prepareRun.useMutation();
  const cancelMutation = trpc.swarm.cancelRun.useMutation();
  const approveMutation = trpc.swarm.approveStep.useMutation();
  const autoDesignMutation = trpc.swarm.autoDesign.useMutation();
  const setTierMutation = trpc.localAuth.devTierSwitch.useMutation({
    onSuccess: () => { window.location.reload(); },
  });
  const utils = trpc.useUtils();

  const eventSourceRef = useRef<EventSource | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync pipeline steps from config — comparison inside prevents re-render loops
  useEffect(() => {
    if (pipelineConfig?.steps) {
      const newSteps = pipelineConfig.steps.map((s) => ({
        stepOrder: s.stepOrder, name: s.name, role: s.role,
        status: "pending" as const, stepType: (s as unknown as Record<string, string>).stepType,
      }));
      setPipelineSteps((prev) => {
        // Only update if count or names changed — avoids re-render loops
        if (prev.length === newSteps.length && prev.every((p, i) => p.name === newSteps[i]?.name && p.role === newSteps[i]?.role)) {
          return prev;
        }
        return newSteps;
      });
    }
  }, [pipelineConfig]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Reset local state when switching projects — prevents stale chat/messages.
  // NOTE: We intentionally do NOT call clearMessagesStore here. Messages live
  // in Zustand persisted to localStorage, and wiping them on every project
  // switch would destroy the user's chat history (issue #2). Messages are
  // kept per-project and rendered from the store.
  useEffect(() => {
    setInput("");
    setIsRunning(false);
    setIsTestRun(false);
    setPipelineSteps([]);
    setCurrentStepName("");
    setApprovalInstructions("");
    setShowModifyInput(false);
    setShowAutoDesign(false);
    setDesignTask("");
    setShowPipelineMenu(false);
    clearApprovalStore(projectId);  // Clear stale HITL state from previous project
    // Note: runId is recovered from runStatus via mount-recovery effect below
  }, [projectId]);

  // ─── Server-side chat persistence (issue #9) ───────────────────
  // On load: merge server-saved messages into the store if localStorage is empty
  // for this project (e.g., after DB wipe + redeploy, or on a new device).
  // On unload: push current messages to server so they survive upgrades.
  useEffect(() => {
    if (!userPrefs?.savedMessages || !projectId) return;
    const key = String(projectId);
    const localCount = projectMessagesMap[key]?.length ?? 0;
    const serverMsgs = userPrefs.savedMessages[key];
    if (serverMsgs && serverMsgs.length > 0 && localCount === 0) {
      console.log(`[chat-persist] Restoring ${serverMsgs.length} messages from server for project ${projectId}`);
      mergeMessages(projectId, serverMsgs as Parameters<typeof mergeMessages>[1]);
    }
  }, [userPrefs, projectId]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!projectId) return;
      const msgs = projectMessagesMap[String(projectId)];
      if (!msgs || msgs.length === 0) return;
      // Build the updated savedMessages map (merge, don't replace other projects)
      const prev = userPrefs?.savedMessages ?? {};
      const next = {
        ...prev,
        [String(projectId)]: msgs.map((m) => ({
          id: m.id, role: m.role, content: m.content,
          agentName: m.agentName, pipelineStep: m.pipelineStep,
        })),
      };
      const payload = JSON.stringify({ preferences: { ...userPrefs, savedMessages: next } });
      const token = localStorage.getItem("local_auth_token") ?? "";
      // Use sendBeacon for reliable delivery during page unload
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        navigator.sendBeacon(`/api/beacon/save-preferences?token=${encodeURIComponent(token)}`, blob);
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [projectId, projectMessagesMap, userPrefs]);

  // ─── Mount-time recovery: restore state when user navigates back ───
  useEffect(() => {
    console.log(`[MOUNT-TRACE] project=${projectId} runId=${runId} isRunning=${isRunning} hasActiveRun=${runStatus?.hasActiveRun} activeRunId=${runStatus?.runId} storedRunId=${storedRunState?.runId} pendingPrompt=${!!pendingPromptStore}`);

    if (!runStatus?.hasActiveRun || !projectId) return;

    // If the backend says the run is no longer actually running (e.g., it
    // completed while we were away), do NOT reconnect — let the user see the
    // final state. This guards against any stale terminal events slipping
    // through the backend's own cleanup.
    if (!runStatus.isRunning && !runStatus.isAwaitingApproval) return;

    // If we have a stored runId that matches the active run, reconnect SSE
    const storedRunId = storedRunState?.runId;
    const activeRunId = runStatus.runId;

    if (storedRunId === activeRunId && !eventSourceRef.current) {
      console.log(`[mount-recovery] Reconnecting SSE for run ${activeRunId}`);
      setupSSE(activeRunId);
    } else if (!storedRunId && activeRunId && !eventSourceRef.current) {
      // No stored runId (e.g., after a reload where projectRunState was
      // excluded from persist), but backend has an active run — reconnect.
      console.log(`[mount-recovery] Reconnecting SSE for active run ${activeRunId} (no stored runId)`);
      setRunId(activeRunId);
      setupSSE(activeRunId);
    }

    // If the backend says we're awaiting approval but store doesn't reflect it,
    // sync the store (e.g., user navigated away during approval)
    // BUT: don't re-show if user just clicked approve/reject/modify (processingApprovalRef)
    if (runStatus.isAwaitingApproval && !approvalState?.awaiting && !processingApprovalRef.current) {
      console.log(`[mount-recovery] Syncing approval state for run ${activeRunId}`);
      setApprovalStore(projectId, {
        awaiting: true,
        output: runStatus.lastOutput ?? "",
        runId: activeRunId ?? null,
      });
    }

    // Ensure isRunning matches reality
    if (runStatus.isRunning && !isRunning) {
      setIsRunning(true);
    }
  }, [runStatus?.hasActiveRun, runStatus?.runId, runStatus?.isAwaitingApproval, runStatus?.isRunning, projectId]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const updateStepStatus = useCallback((stepNum: number, role: string | undefined, status: PipelineStepInfo["status"]) => {
    setPipelineSteps((prev) => {
      const idx = prev.findIndex((s) => s.stepOrder === stepNum);
      if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], status }; return u; }
      const ri = prev.findIndex((s) => s.role === role);
      if (ri >= 0) { const u = [...prev]; u[ri] = { ...u[ri], status }; return u; }
      return prev;
    });
  }, []);

  const finalizePipeline = () => {
    sendingRef.current = false;
    setIsRunning(false);
    clearApprovalStore(projectId);
    clearRunStateStore(projectId);
    setCurrentStepName("");
    setRunId(null);
    setApprovalInstructions("");
    setShowModifyInput(false);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    closeEventSource();
  };

  const setupSSE = useCallback((rid: number): Promise<void> => {
    return new Promise((resolve) => {
      closeEventSource();
      const es = new EventSource(`/api/stream/${rid}`);
      eventSourceRef.current = es;
      let resolved = false;
      const resolveOnce = () => { if (!resolved) { resolved = true; resolve(); } };

      es.onopen = () => resolveOnce();
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as StreamEvent;
          if (data.type === "step_start" && data.agentRole !== "system" && data.step) {
            updateStepStatus(data.step, data.agentRole, "running");
            setCurrentStepName(data.agentName ?? (data.agentRole ? t("common:agentRoles." + data.agentRole, data.agentRole) : ""));
            // Pipeline progressed to a new step — safe to reset approval guard
            // so that consecutive approval steps can show their banners
            processingApprovalRef.current = false;
          } else if (data.type === "step_complete" && data.step) {
            updateStepStatus(data.step, data.agentRole, "completed");
          } else if (data.type === "step_error" && data.step) {
            updateStepStatus(data.step, data.agentRole, "error");
          } else if (data.type === "awaiting_approval") {
            // Guard: don't re-show approval banner if user is actively processing
            // an approval action (SSE replay buffer may deliver stale events)
            if (!processingApprovalRef.current) {
              setApprovalStore(projectId, {
                awaiting: true,
                output: data.lastOutput ?? "",
                runId: rid,
              });
              setIsRunning(false);
              setCurrentStepName("");
            }
          } else if (data.type === "pipeline_complete") {
            if ((data as any).awaitingApproval) {
              // Pipeline paused for human approval — don't finalize, keep approval banner visible
              sendingRef.current = false;
              resolveOnce();
              return;
            }
            if (data.finalResponse) {
              addMessage(projectId, {
                id: `assistant-final-${Date.now()}`, role: "assistant",
                content: data.finalResponse, agentName: "Pipeline", pipelineStep: "final",
              });
            }
            processingApprovalRef.current = false;
            sendingRef.current = false;
            finalizePipeline();
            resolveOnce();
          } else if (data.type === "pipeline_error") {
            if (data.error) {
              addMessage(projectId, {
                id: `error-${Date.now()}`, role: "assistant",
                content: `**${t("pages:workspace.chat.pipelineError")}**: ${data.error}`,
              });
            }
            processingApprovalRef.current = false;
            sendingRef.current = false;
            finalizePipeline();
            resolveOnce();
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => resolveOnce();
      setTimeout(resolveOnce, 3000);
    });
  }, [closeEventSource, updateStepStatus, addMessage, finalizePipeline, projectId]);

  // Helper: sync run state to store whenever it changes
  const syncRunState = (rid: number | null, running: boolean) => {
    if (rid && running) {
      setRunStateStore(projectId, { runId: rid, isRunning: running, currentStepName });
    } else {
      clearRunStateStore(projectId);
    }
  };

  const handleStop = async () => {
    if (runId) { try { await cancelMutation.mutateAsync({ id: runId }); } catch { /* ignore */ } }
    finalizePipeline();
  };

  const handleApprovalAction = async (action: "approve" | "reject" | "modify") => {
    // Use runId from React state or from the persisted store (for after-navigation resume)
    const activeRunId = runId ?? approvalState?.runId ?? getApprovalFn(projectId).runId;
    if (!activeRunId) return;
    processingApprovalRef.current = true;       // Prevent mount-recovery from re-showing banner
    clearApprovalStore(projectId);              // Dismiss banner immediately
    setIsRunning(true);
    setRunId(activeRunId);
    syncRunState(activeRunId, true);

    console.log(`[handleApprovalAction] called. action=${action} runId=${activeRunId}`);

    try {
      await approveMutation.mutateAsync({
        runId: activeRunId, action,
        instructions: action === "modify" ? approvalInstructions : undefined,
      });

      await setupSSE(activeRunId);

      const memoryMode = localStorage.getItem(`memory-mode-${projectId}`) as "conservative" | "balanced" | "aggressive" | undefined;

      // Fire-and-forget: execute returns immediately, all progress via SSE
      await executeMutation.mutateAsync({
        projectId, prompt: "", // Backend uses stored userPrompt when resuming
        giteeToken: localStorage.getItem("gitee_token") ?? undefined,
        memoryMode: memoryMode ?? "balanced", runId: activeRunId,
        includeProjectFiles: includeProjectInContext,
        isTestRun: isTestRun || undefined,
        clientTraceId: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      });

      // Execute returned immediately - pipeline is running async
      // All completion is handled via SSE (pipeline_complete / pipeline_error)

    } catch (err) {
      processingApprovalRef.current = false;
      const errMsg = (err as Error).message;
      if (errMsg.includes("cancelled")) {
        addMessage(projectId, { id: `cancel-${Date.now()}`, role: "assistant", content: t("pages:workspace.chat.pipelineStopped") });
      } else {
        addMessage(projectId, { id: `error-${Date.now()}`, role: "assistant", content: `**${t("pages:workspace.chat.agentError")}**: ${errMsg}` });
      }
      finalizePipeline();
    }
  };

  const handleSend = async () => {
    console.log(`[handleSend] called. input="${input.substring(0, 50)}..." isRunning=${isRunning} runId=${runId} sendingRef=${sendingRef.current}`);
    if ((!input.trim() && attachments.length === 0) || isRunning || sendingRef.current) {
      console.log(`[handleSend] blocked: inputEmpty=${!input.trim()} noAttachments=${attachments.length === 0} isRunning=${isRunning} sendingRef=${sendingRef.current}`);
      return;
    }
    sendingRef.current = true;

    // NOTE: We intentionally do NOT clear messages here. Keeping the full
    // conversation history across runs is the desired UX (issue #2).
    const userContent = input.trim();

    // Add user message to chat
    addMessage(projectId, {
      id: `user-${Date.now()}`,
      role: "user",
      content: userContent,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setInput("");
    setIsRunning(true);
    setCurrentStepName("");
    clearApprovalStore(projectId);

    // ─── AGENT MODE: Single LLM direct call ─────────────────────────
    if (executionMode === "agent") {
      try {
        // Build conversation history from existing messages (last 10, excluding current user msg)
        const historyMessages = messages.slice(-10).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

        const result = await agentMutation.mutateAsync({
          projectId,
          prompt: userContent || t("pages:workspace.chat.seeAttachedFiles"),
          attachments: attachments.length > 0 ? attachments : undefined,
          includeProjectFiles: includeProjectInContext,
          conversationHistory: historyMessages.length > 0 ? historyMessages : undefined,
        });
        setAttachments([]);
        addMessage(projectId, {
          id: `assistant-agent-${Date.now()}`,
          role: "assistant",
          content: result.content,
          agentName: `${result.provider} (${result.model})`,
        });
      } catch (err) {
        const errMsg = (err as Error).message;
        addMessage(projectId, {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: `**${t("pages:workspace.chat.agentError")}**: ${errMsg}`,
        });
      } finally {
        // CRITICAL: Reset sendingRef so the user can send another message
        // (without this, the send button silently fails after the first agent call)
        sendingRef.current = false;
        setIsRunning(false);
      }
      return;
    }

    // ─── PIPELINE MODE: Full multi-step pipeline ────────────────────
    // Clear any stale run state before starting fresh
    clearRunStateStore(projectId);
    setRunId(null);

    if (pipelineConfig?.steps) {
      setPipelineSteps(pipelineConfig.steps.map((s) => ({
        stepOrder: s.stepOrder, name: s.name, role: s.role,
        status: "pending" as const, stepType: (s as unknown as Record<string, string>).stepType,
      })));
    }

    try {
      const { runId: rid } = await prepareMutation.mutateAsync({ projectId });
      setRunId(rid);
      syncRunState(rid, true);
      await setupSSE(rid);

      const memoryMode = localStorage.getItem(`memory-mode-${projectId}`) as "conservative" | "balanced" | "aggressive" | undefined;

      // Fire-and-forget: execute returns immediately, all progress via SSE
      await executeMutation.mutateAsync({
        projectId, prompt: userContent,
        giteeToken: localStorage.getItem("gitee_token") ?? undefined,
        memoryMode: memoryMode ?? "balanced", runId: rid,
        attachments: attachments.length > 0 ? attachments : undefined,
        executionMode: "pipeline",
        includeProjectFiles: includeProjectInContext,
        isTestRun: isTestRun || undefined,
        clientTraceId: `handleSend-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      });

      // Execute returned immediately - pipeline is now running async
      // All progress and completion are handled via SSE
      // Don't call finalizePipeline() here - SSE pipeline_complete/pipeline_error will handle it

      setAttachments([]);
    } catch (err) {
      sendingRef.current = false;
      const errMsg = (err as Error).message;
      console.error(`[FRONTEND-ERROR] Pipeline failed:`, err);

      if (errMsg.includes("cancelled")) {
        addMessage(projectId, { id: `cancel-${Date.now()}`, role: "assistant", content: t("pages:workspace.chat.pipelineStoppedPartial") });
      } else {
        addMessage(projectId, { id: `error-${Date.now()}`, role: "assistant", content: `**${t("pages:workspace.chat.pipelineError")}**: ${errMsg}\n\n${t("pages:workspace.chat.pipelineTimeout")}` });
      }
      finalizePipeline();
    }
  };

  const handleAutoDesign = async () => {
    if (!designTask.trim()) return;
    setShowAutoDesign(false);
    setIsRunning(true);

    try {
      const result = await autoDesignMutation.mutateAsync({ projectId, task: designTask });
      // Refresh pipeline config
      utils.swarm.getPipeline.invalidate({ projectId });
      // Store the prompt so user can run the pipeline immediately (persists across navigation)
      setPendingPromptStore(projectId, designTask.trim());

      addMessage(projectId, {
        id: `design-${Date.now()}`, role: "assistant",
        content: `${t("pages:workspace.chat.autoDesignCreated")}

${result.explanation}

${t("pages:workspace.chat.agentsLabel")} ${result.agentsCreated}
${t("pages:workspace.chat.stepsLabel")} ${result.stepsCreated}

Pipeline: ${result.pipeline?.map((s) => s.name).join(" → ") ?? ""}

---

${t("pages:workspace.chat.promptSavedHint")}`,
      });
    } catch (err) {
      addMessage(projectId, { id: `design-err-${Date.now()}`, role: "assistant", content: t("pages:workspace.chat.autoDesignFailed", { error: (err as Error).message }) });
    } finally {
      setIsRunning(false);
      setDesignTask("");
    }
  };

  const handleRunDesignedPipeline = () => {
    if (pendingDesignPrompt) {
      setInput(pendingDesignPrompt);
      clearPendingPromptStore(projectId);
      setTimeout(() => handleSend(), 50);
    }
  };

  if (projectLoading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
      </AppShell>
    );
  }
  if (!project) {
    return (
      <AppShell>
        <div className="flex flex-col items-center justify-center h-full text-neutral-500">
          <AlertCircle className="w-12 h-12 mb-4" />
          <p className="text-lg">{t("common:errors.projectNotFound")}</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-neutral-800 bg-neutral-900">
            <div className="flex items-center gap-3">
              <Bot className="w-5 h-5 text-blue-500" />
              <div>
                <h1 className="text-sm font-semibold text-neutral-100">{project.name}</h1>
                {/* Pipeline Selector Dropdown */}
                <div className="relative">
                  <button
                    onClick={() => setShowPipelineMenu(!showPipelineMenu)}
                    className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                  >
                    <Workflow className="w-3 h-3" />
                    {pipelineConfig?.isCustom ? (templateList?.find((tmpl) => tmpl.id === project?.pipelineTemplateId)?.name ?? t("pages:workspace.toolbar.customPipeline")) : t("pages:workspace.toolbar.standardPipeline")}
                    <span className="text-neutral-600">·</span>
                    {t("pages:workspace.toolbar.agentsCount", { count: pipelineConfig?.steps.length ?? 0 })}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showPipelineMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowPipelineMenu(false)} />
                      <div className="absolute left-0 top-5 z-50 w-56 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl py-1">
                        {/* Standard */}
                        <button
                          onClick={() => { setShowPipelineMenu(false); }}
                          className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-neutral-800 ${!pipelineConfig?.isCustom ? "text-blue-400" : "text-neutral-400"}`}
                        >
                          <Check className={`w-3 h-3 ${!pipelineConfig?.isCustom ? "opacity-100" : "opacity-0"}`} />
                          {t("pages:workspace.pipelineMenu.standardPipeline")}
                        </button>
                        {/* Saved Templates */}
                        {templateList && templateList.length > 0 && (
                          <>
                            <div className="border-t border-neutral-800 my-1" />
                            <p className="px-3 py-0.5 text-[10px] text-neutral-600 uppercase tracking-wider">{t("pages:workspace.pipelineMenu.myPipelines")}</p>
                            {templateList.map((t) => (
                              <button
                                key={t.id}
                                onClick={() => {
                                  applyTemplateMutation.mutate({ templateId: t.id, projectId });
                                  setShowPipelineMenu(false);
                                }}
                                className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-neutral-800 ${project?.pipelineTemplateId === t.id ? "text-blue-400" : "text-neutral-400"}`}
                              >
                                <Check className={`w-3 h-3 ${project?.pipelineTemplateId === t.id ? "opacity-100" : "opacity-0"}`} />
                                <span className="truncate">{t.name}</span>
                                {t.isAuto && <Wand2 className="w-2.5 h-2.5 text-amber-400 ml-auto flex-shrink-0" />}
                              </button>
                            ))}
                          </>
                        )}
                        <div className="border-t border-neutral-800 my-1" />
                        {/* Auto Design */}
                        {isProAuto ? (
                          <button
                            onClick={() => { setShowPipelineMenu(false); setShowAutoDesign(true); }}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-amber-400 hover:bg-neutral-800"
                          >
                            <Wand2 className="w-3 h-3" /> {t("pages:workspace.pipelineMenu.autoDesignNew")}
                          </button>
                        ) : (
                          <button
                            onClick={() => { setShowPipelineMenu(false); setTierMutation.mutate({ tier: "pro_auto" }); }}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-800"
                          >
                            <Lock className="w-3 h-3" /> {t("pages:workspace.pipelineMenu.autoDesignSage")}
                          </button>
                        )}
                        {/* Pipeline Editor */}
                        {isMaster ? (
                          <Link
                            to="/pipelines"
                            onClick={() => setShowPipelineMenu(false)}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-blue-400 hover:bg-neutral-800"
                          >
                            <Settings className="w-3 h-3" /> {t("pages:workspace.pipelineMenu.pipelineEditor")}
                          </Link>
                        ) : (
                          <button
                            onClick={() => { setShowPipelineMenu(false); setTierMutation.mutate({ tier: "pro_designer" }); }}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-800"
                          >
                            <Lock className="w-3 h-3" /> {t("pages:workspace.pipelineMenu.editorMaster")}
                          </button>
                        )}
                        <div className="border-t border-neutral-800 my-1" />
                        <Link
                          to="/pipelines"
                          onClick={() => setShowPipelineMenu(false)}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                        >
                          <Workflow className="w-3 h-3" /> {t("pages:workspace.pipelineMenu.managePipelines")}
                        </Link>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Test Mode Toggle */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsTestRun((v) => !v)}
                className={`h-7 text-xs ${isTestRun ? "text-emerald-400 bg-emerald-500/10" : "text-neutral-400 hover:text-neutral-200"}`}
                title={isTestRun ? t("pages:workspace.toolbar.testModeOn") : t("pages:workspace.toolbar.testModeOff")}
              >
                <FlaskConical className="w-3.5 h-3.5 mr-1" />
                {t("pages:workspace.toolbar.test")}
              </Button>

              {/* Execution Mode Toggle */}
              <div className="flex items-center bg-neutral-800 rounded-md border border-neutral-700 overflow-hidden">
                <button
                  onClick={() => setExecutionMode("pipeline")}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    executionMode === "pipeline"
                      ? "bg-blue-600 text-white"
                      : "text-neutral-400 hover:text-neutral-200"
                  }`}
                  title={t("pages:workspace.toolbar.pipelineMode")}
                >
                  <Workflow className="w-3 h-3 inline mr-1" />
                  {t("pages:workspace.toolbar.pipelineModeLabel")}
                </button>
                <button
                  onClick={() => setExecutionMode("agent")}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    executionMode === "agent"
                      ? "bg-emerald-600 text-white"
                      : "text-neutral-400 hover:text-neutral-200"
                  }`}
                  title={t("pages:workspace.toolbar.agentMode")}
                >
                  <Bot className="w-3 h-3 inline mr-1" />
                  {t("pages:workspace.toolbar.agentModeLabel")}
                </button>
              </div>

              {/* Project Files button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowProjectPanel(!showProjectPanel)}
                className={`h-7 text-xs ${showProjectPanel ? "text-amber-400 bg-amber-500/10" : "text-neutral-400 hover:text-neutral-200"}`}
              >
                <FolderOpen className="w-3.5 h-3.5 mr-1" />
                {t("pages:workspace.toolbar.project")}
              </Button>

              {/* Audit drawer button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAudit(!showAudit)}
                className={`h-7 text-xs ${showAudit ? "text-blue-400 bg-blue-500/10" : "text-neutral-400 hover:text-neutral-200"}`}
              >
                <Bug className="w-3.5 h-3.5 mr-1" />
                {t("pages:workspace.toolbar.audit")}
              </Button>

              {/* Auto Design button */}
              {isProAuto ? (
                <Button variant="ghost" size="sm" onClick={() => setShowAutoDesign(true)} className="text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 h-7 text-xs">
                  <Wand2 className="w-3.5 h-3.5 mr-1" />{t("pages:workspace.toolbar.autoDesign")}
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => {
                  if (confirm(t("pages:workspace.toolbar.autoDesignRequiresTier"))) {
                    setTierMutation.mutate({ tier: "pro_auto" });
                  }
                }} className="text-neutral-500 hover:text-neutral-300 h-7 text-xs">
                  <Lock className="w-3.5 h-3.5 mr-1" />{t("pages:workspace.toolbar.autoDesign")}
                </Button>
              )}
              {(isRunning || awaitingApproval) && (
                <Button variant="ghost" size="sm" onClick={handleStop} className="text-red-400 hover:text-red-300 hover:bg-red-500/10 h-7 text-xs">
                  <Octagon className="w-3.5 h-3.5 mr-1" />{t("pages:workspace.toolbar.stop")}
                </Button>
              )}
            </div>
          </div>

          {/* Pipeline Visualizer — only show for custom/auto-designed pipelines */}
          {pipelineConfig?.isCustom && <PipelineVisualizer steps={pipelineSteps} />}

          {/* Current step indicator */}
          {isRunning && currentStepName && (
            <div className="px-4 py-1.5 bg-blue-500/5 border-b border-blue-500/10">
              <div className="flex items-center gap-2 text-xs text-blue-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span><strong>{currentStepName}</strong> {t("pages:workspace.chat.processing")}</span>
              </div>
            </div>
          )}

          {/* Approval Banner */}
          {awaitingApproval && (
            <div className="px-4 py-3 bg-amber-500/10 border-b border-amber-500/20">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-medium text-amber-300">{t("pages:workspace.approval.title")}</span>
              </div>
              <div className="bg-neutral-900/50 rounded-lg p-3 mb-3 max-h-32 overflow-y-auto">
                <p className="text-xs text-neutral-400 whitespace-pre-wrap">{approvalOutput}</p>
              </div>
              {showModifyInput && (
                <Textarea
                  value={approvalInstructions}
                  onChange={(e) => setApprovalInstructions(e.target.value)}
                  placeholder={t("pages:workspace.approval.modifyPlaceholder")}
                  rows={2}
                  className="bg-neutral-800 border-neutral-700 text-neutral-100 text-xs mb-2 resize-none"
                  autoFocus
                />
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => handleApprovalAction("approve")}
                  disabled={approveMutation.isPending}
                  className="bg-green-600 hover:bg-green-700 text-white h-7 text-xs"
                >
                  {approveMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ThumbsUp className="w-3 h-3 mr-1" />}
                  {approveMutation.isPending ? t("pages:workspace.approval.processing") : t("pages:workspace.approval.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleApprovalAction("reject")}
                  disabled={approveMutation.isPending}
                  className="border-red-500/30 text-red-400 hover:bg-red-500/10 h-7 text-xs"
                >
                  <ThumbsDown className="w-3 h-3 mr-1" />{t("pages:workspace.approval.reject")}
                </Button>
                {!showModifyInput ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowModifyInput(true)}
                    disabled={approveMutation.isPending}
                    className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 h-7 text-xs"
                  >
                    <MessageSquarePlus className="w-3 h-3 mr-1" />{t("pages:workspace.approval.modify")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleApprovalAction("modify")}
                    disabled={approveMutation.isPending}
                    className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 h-7 text-xs"
                  >
                    {approveMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <MessageSquarePlus className="w-3 h-3 mr-1" />}
                    {t("pages:workspace.approval.submit")}
                  </Button>
                )}
              </div>
            </div>
          )}

          <ScrollArea className="flex-1 px-6 py-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-neutral-600">
                <Sparkles className="w-12 h-12 mb-4 text-neutral-700" />
                <p className="text-lg font-medium text-neutral-500 mb-2">{t("pages:workspace.emptyState.title")}</p>
                <p className="text-sm max-w-md">{t("pages:workspace.emptyState.description")}</p>
              </div>
            ) : (
              <div className="space-y-4 max-w-3xl mx-auto">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && (
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 mt-1">
                        <Bot className="w-4 h-4 text-blue-400" />
                      </div>
                    )}
                    <div className={`rounded-lg px-4 py-3 max-w-[85%] ${msg.role === "user" ? "bg-blue-600 text-white" : "bg-neutral-800 border border-neutral-700 text-neutral-200"}`}>
                      {msg.agentName && (
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="text-xs font-medium text-blue-400 capitalize">{msg.agentName}</span>
                        </div>
                      )}
                      {/* Attachments */}
                      {(msg as any).attachments && (msg as any).attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-2">
                          {(msg as any).attachments.map((att: ChatAttachment) => (
                            <div key={att.id} className="flex items-center gap-1.5 bg-white/10 rounded px-2 py-1 text-xs">
                              {att.type.startsWith("image/") ? <Image className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                              <span className="truncate max-w-[120px]">{att.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="text-sm whitespace-pre-wrap break-words overflow-y-auto max-h-[50vh]">{msg.content}</div>
                    </div>
                    {msg.role === "user" && (
                      <div className="w-8 h-8 rounded-lg bg-neutral-700 flex items-center justify-center flex-shrink-0 mt-1">
                        <User className="w-4 h-4 text-neutral-300" />
                      </div>
                    )}
                  </div>
                ))}
                {isRunning && !currentStepName && !awaitingApproval && (
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                      <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                    </div>
                    <div className="bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-3">
                      <span className="text-sm text-neutral-400">{t("pages:workspace.status.working")}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          {/* Pending Auto-Design Prompt Banner */}
          {pendingDesignPrompt && (
            <div className="border-t border-amber-500/20 bg-amber-500/5 px-6 py-3">
              <div className="flex items-center justify-between max-w-3xl mx-auto">
                <div className="flex-1 min-w-0 mr-3">
                  <p className="text-xs text-amber-400 font-medium mb-0.5">{t("pages:workspace.pendingDesign.readyToRun")}</p>
                  <p className="text-xs text-neutral-500 truncate">{pendingDesignPrompt}</p>
                </div>
                <Button size="sm" onClick={handleRunDesignedPipeline} className="bg-amber-600 hover:bg-amber-700 text-white h-8 text-xs shrink-0">
                  <Wand2 className="w-3.5 h-3.5 mr-1.5" />{t("pages:workspace.pendingDesign.runPipeline")}
                </Button>
              </div>
            </div>
          )}

          <div className="border-t border-neutral-800 px-6 py-4 bg-neutral-900">
            <div className="flex flex-col gap-2 max-w-3xl mx-auto">
              {/* Attachments preview */}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {attachments.map((att) => (
                    <div key={att.id} className="flex items-center gap-1.5 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1 text-xs">
                      {att.type.startsWith("image/") ? (
                        <Image className="w-3 h-3 text-blue-400" />
                      ) : (
                        <FileText className="w-3 h-3 text-amber-400" />
                      )}
                      <span className="text-neutral-300 max-w-[150px] truncate">{att.name}</span>
                      <span className="text-neutral-500">({(att.size / 1024).toFixed(1)}KB)</span>
                      <button
                        onClick={() => removeAttachment(att.id)}
                        className="ml-1 text-neutral-500 hover:text-red-400 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {uploading && (
                    <div className="flex items-center gap-1.5 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1 text-xs">
                      <Loader2 className="w-3 h-3 animate-spin text-neutral-400" />
                      <span className="text-neutral-400">{t("pages:workspace.chat.uploading")}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,text/*,application/json,application/pdf,.py,.js,.ts,.java,.go,.rs,.md,.csv,.xml,.html,.css"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <div className="flex-1 flex flex-col gap-2">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                    placeholder={t("pages:workspace.placeholder")}
                    rows={2}
                    className="bg-neutral-800 border-neutral-700 text-neutral-100 placeholder:text-neutral-600 resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || isRunning}
                      className="text-neutral-400 hover:text-neutral-200 h-7 px-2"
                      title={t("pages:workspace.chat.attachFilesTitle")}
                    >
                      <Paperclip className="w-4 h-4 mr-1" />
                      <span className="text-xs">{t("pages:workspace.chat.attachFiles")}</span>
                    </Button>
                    <span className="text-xs text-neutral-600">{t("pages:workspace.chat.attachFileTypes")}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Button
                    onClick={handleSend}
                    disabled={(!input.trim() && attachments.length === 0) || isRunning || awaitingApproval}
                    className="bg-blue-600 hover:bg-blue-700 text-white self-end"
                  >
                    {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                  {(isRunning || awaitingApproval) && (
                    <Button variant="ghost" size="sm" onClick={handleStop} className="text-red-400 hover:text-red-300 hover:bg-red-500/10 self-end h-7 px-2">
                      <Octagon className="w-3 h-3 mr-1" />{t("pages:workspace.toolbar.stop")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Project Files Panel — Right Sidebar */}
        {showProjectPanel && (
          <div className="w-72 border-l border-neutral-800 bg-neutral-900 flex flex-col">
            <ProjectFilesPanel
              projectId={projectId}
              includeInContext={includeProjectInContext}
              onToggleInclude={setIncludeProjectInContext}
            />
          </div>
        )}
      </div>

      {/* Auto Design Dialog */}
      <Dialog open={showAutoDesign} onOpenChange={setShowAutoDesign}>
        <DialogContent className="bg-neutral-900 border-neutral-800 text-neutral-100 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-neutral-100 flex items-center gap-2">
              <Wand2 className="w-5 h-5 text-amber-400" />{t("pages:workspace.autoDesign.title")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-neutral-400">
              {t("pages:workspace.autoDesign.description")}
            </p>
            <Textarea
              value={designTask}
              onChange={(e) => setDesignTask(e.target.value)}
              rows={4}
              placeholder={t("pages:workspace.autoDesign.placeholder")}
              className="bg-neutral-800 border-neutral-700 text-neutral-100 resize-none"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowAutoDesign(false)} className="text-neutral-400">{t("pages:workspace.autoDesign.cancel")}</Button>
              <Button onClick={handleAutoDesign} disabled={!designTask.trim() || autoDesignMutation.isPending} className="bg-amber-600 hover:bg-amber-700 text-white">
                {autoDesignMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                {t("pages:workspace.autoDesign.designPipeline")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Audit Drawer — right-side Sheet with full audit panel */}
      <Sheet open={showAudit} onOpenChange={setShowAudit}>
        <SheetContent
          side="right"
          className="sm:max-w-5xl w-[85vw] p-0 bg-neutral-950 border-neutral-800"
        >
          <SheetTitle className="sr-only">{t("pages:workspace.toolbar.auditPanel")}</SheetTitle>
          <div className="h-full">
            <AuditContent projectId={projectId} />
          </div>
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}
