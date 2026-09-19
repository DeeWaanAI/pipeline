import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
  textContent?: string;
  url?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  agentName?: string;
  pipelineStep?: string;
  attachments?: ChatAttachment[];
}

interface ApprovalState {
  awaiting: boolean;
  output: string;
  runId: number | null;
}

interface RunState {
  runId: number;
  isRunning: boolean;
  currentStepName?: string;
}

interface WorkspaceState {
  sidebarOpen: boolean;
  activePanel: "chat" | "agents" | "files" | "debug";
  // Per-project chat messages (key: projectId string)
  projectMessages: Record<string, ChatMessage[]>;
  // Per-project approval state (key: projectId string) — persists across navigation
  projectApproval: Record<string, ApprovalState>;
  // Per-project pending auto-design prompt — persists across navigation
  projectPendingPrompt: Record<string, string>;
  // Per-project active run state — persists across navigation
  projectRunState: Record<string, RunState>;

  setSidebarOpen: (open: boolean) => void;
  setActivePanel: (panel: "chat" | "agents" | "files" | "debug") => void;
  addMessage: (projectId: number, message: ChatMessage) => void;
  mergeMessages: (projectId: number, messages: ChatMessage[]) => void;
  getMessages: (projectId: number) => ChatMessage[];
  clearMessages: (projectId: number) => void;

  setApproval: (projectId: number, state: ApprovalState) => void;
  getApproval: (projectId: number) => ApprovalState;
  clearApproval: (projectId: number) => void;

  setPendingPrompt: (projectId: number, prompt: string) => void;
  getPendingPrompt: (projectId: number) => string | null;
  clearPendingPrompt: (projectId: number) => void;

  setRunState: (projectId: number, state: RunState) => void;
  getRunState: (projectId: number) => RunState | null;
  clearRunState: (projectId: number) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      activePanel: "chat",
      projectMessages: {},
      projectApproval: {},
      projectPendingPrompt: {},
      projectRunState: {},

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setActivePanel: (panel) => set({ activePanel: panel }),

      addMessage: (projectId, message) => {
        const key = String(projectId);
        set((state) => ({
          projectMessages: {
            ...state.projectMessages,
            [key]: [...(state.projectMessages[key] ?? []), message],
          },
        }));
      },

      mergeMessages: (projectId, messages) => {
        if (!messages || messages.length === 0) return;
        const key = String(projectId);
        set((state) => {
          const existing = state.projectMessages[key] ?? [];
          const existingIds = new Set(existing.map((m) => m.id));
          const newOnes = messages.filter((m) => !existingIds.has(m.id));
          if (newOnes.length === 0) return state;
          return {
            projectMessages: {
              ...state.projectMessages,
              [key]: [...existing, ...newOnes],
            },
          };
        });
      },

      getMessages: (projectId) => {
        return get().projectMessages[String(projectId)] ?? [];
      },

      clearMessages: (projectId) => {
        const key = String(projectId);
        set((state) => {
          const next = { ...state.projectMessages };
          delete next[key];
          return { projectMessages: next };
        });
      },

      setApproval: (projectId, approvalState) => {
        const key = String(projectId);
        set((state) => ({
          projectApproval: { ...state.projectApproval, [key]: approvalState },
        }));
      },

      getApproval: (projectId) => {
        return get().projectApproval[String(projectId)] ?? { awaiting: false, output: "", runId: null };
      },

      clearApproval: (projectId) => {
        const key = String(projectId);
        set((state) => {
          const next = { ...state.projectApproval };
          delete next[key];
          return { projectApproval: next };
        });
      },

      setPendingPrompt: (projectId, prompt) => {
        const key = String(projectId);
        set((state) => ({
          projectPendingPrompt: { ...state.projectPendingPrompt, [key]: prompt },
        }));
      },

      getPendingPrompt: (projectId) => {
        return get().projectPendingPrompt[String(projectId)] ?? null;
      },

      clearPendingPrompt: (projectId) => {
        const key = String(projectId);
        set((state) => {
          const next = { ...state.projectPendingPrompt };
          delete next[key];
          return { projectPendingPrompt: next };
        });
      },

      setRunState: (projectId, state) => {
        const key = String(projectId);
        set((s) => ({
          projectRunState: { ...s.projectRunState, [key]: state },
        }));
      },

      getRunState: (projectId) => {
        return get().projectRunState[String(projectId)] ?? null;
      },

      clearRunState: (projectId) => {
        const key = String(projectId);
        set((state) => {
          const next = { ...state.projectRunState };
          delete next[key];
          return { projectRunState: next };
        });
      },
    }),
    {
      name: "swarm-workspace-storage",
      partialize: (state) => ({
        // Strip large base64 dataUrls from attachments before persisting to localStorage
        // (dataUrls can be 5MB+ each and exceed localStorage quota of ~5-10MB)
        projectMessages: Object.fromEntries(
          Object.entries(state.projectMessages).map(([key, messages]) => [
            key,
            messages.map((msg) => ({
              ...msg,
              attachments: msg.attachments?.map((att) => {
                const { dataUrl, ...rest } = att;
                // Only keep dataUrl if it's tiny (<1KB), otherwise strip it
                return dataUrl && dataUrl.length < 1400 ? { ...rest, dataUrl } : rest;
              }),
            })),
          ])
        ),
        projectApproval: state.projectApproval,
        projectPendingPrompt: state.projectPendingPrompt,
        // NOTE: projectRunState is intentionally excluded — run state should
        // always come from the server, not from localStorage. This prevents
        // stale SSE/run state from persisting across page reloads.
      }),
    }
  )
);
