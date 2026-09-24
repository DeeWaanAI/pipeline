/**
 * Floating Feedback Button
 * Always-visible pill button for submitting feedback.
 * Captures DOM screenshot, console logs, and page context.
 *
 * Layout: fixed header, scrollable body, fixed footer — never overlaps.
 */

import { useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import {
  MessageSquarePlus, X, Bug, Lightbulb,
  ThumbsUp, HelpCircle, Camera, Loader2, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";

interface Props {
  projectId?: number;
}

/** One ticked attachment, in the shape `feedback.submit` expects. `consent` is
 *  always the literal `true` here: the checkbox IS the consent, per item, and
 *  an unticked object is never sent (D11, ticket #22). */
type AttachmentChoice = { kind: "pipeline" | "run" | "benchmark"; refId: number; consent: true };
const choiceKey = (kind: string, refId: number) => `${kind}:${refId}`;

export default function FloatingFeedbackButton({ projectId: propProjectId }: Props) {
  const { t } = useTranslation("pages");
  const location = useLocation();

  // Auto-detect projectId from URL (/projects/:id/*)
  const urlProjectId = useMemo(() => {
    const match = location.pathname.match(/\/projects\/(\d+)/);
    return match ? parseInt(match[1], 10) : undefined;
  }, [location.pathname]);

  const projectId = propProjectId ?? urlProjectId;

  const [isOpen, setIsOpen] = useState(false);
  const [type, setType] = useState<"bug" | "suggestion" | "praise" | "confusion">("bug");
  const [severity, setSeverity] = useState<"critical" | "major" | "minor" | "cosmetic">("minor");
  const [content, setContent] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // D11: the per-item opt-ins. Keyed by `kind:refId`, and only the ticked ones
  // are ever sent — nothing is harvested because nothing is selected by
  // default and an unticked object has no entry here at all.
  const [consented, setConsented] = useState<Record<string, boolean>>({});

  const utils = trpc.useUtils();

  // What this account could attach: its own pipelines, runs and benchmarks (plus
  // what someone shared onto it), as LABELS only. The server builds the actual
  // snapshot from this account's own read projections at submit time, so this
  // list is a picker and not a data channel.
  const {
    data: attachable, isError: attachableFailed, isPending: attachableLoading, refetch: refetchAttachable,
  } = trpc.feedback.attachable.useQuery(
    { projectId },
    { enabled: isOpen },
  );

  const attachableItems = useMemo(() => {
    if (!attachable) return [] as Array<{ kind: AttachmentChoice["kind"]; refId: number; title: string }>;
    return [
      ...attachable.pipelines.map((p) => ({ kind: "pipeline" as const, refId: p.refId, title: p.title })),
      ...attachable.runs.map((r) => ({ kind: "run" as const, refId: r.refId, title: r.title })),
      ...attachable.benchmarks.map((b) => ({ kind: "benchmark" as const, refId: b.refId, title: b.title })),
    ];
  }, [attachable]);

  // The cap is the SERVER's number, read off the same response that lists the
  // objects: a second copy of the limit here is a second rule to drift from.
  const maxAttachments = attachable?.maxPerFeedback ?? null;

  const chosenAttachments = useMemo<AttachmentChoice[]>(
    () => attachableItems
      .filter((i) => consented[choiceKey(i.kind, i.refId)])
      .map((i) => ({ kind: i.kind, refId: i.refId, consent: true as const })),
    [attachableItems, consented],
  );

  // Submission awaits the screenshot upload, so the list read from the render
  // closure would be the one the user saw when they clicked — and unticking a
  // box during the upload would not have stopped that attachment being sent.
  // The ref is what is true AT the moment the report goes out.
  const chosenRef = useRef(chosenAttachments);
  chosenRef.current = chosenAttachments;

  const submitMutation = trpc.feedback.submit.useMutation({
    onSuccess: () => {
      toast.success(t("pages:workspace.feedback.floating.sent"));
      // Invalidate feedback queries so the lists refresh
      utils.feedback.list.invalidate();
      utils.feedback.stats.invalidate();
      utils.feedback.attachments.invalidate();
      resetForm();
      setIsOpen(false);
    },
    onError: (err) => {
      toast.error(`${t("pages:workspace.feedback.floating.submitFailed")}: ${err.message}`);
      setSubmitting(false);
    },
  });

  const resetForm = () => {
    setContent("");
    setScreenshot(null);
    setType("bug");
    setSeverity("minor");
    setSubmitting(false);
    setConsented({});
  };

  const captureScreenshot = useCallback(async () => {
    setCapturing(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const maxDim = 1200;
      const scale = Math.min(1, maxDim / window.innerWidth, maxDim / window.innerHeight);

      const canvas = await html2canvas(document.body, {
        logging: false,
        useCORS: true,
        allowTaint: true,
        scale,
        width: window.innerWidth,
        height: window.innerHeight,
        x: window.scrollX,
        y: window.scrollY,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        ignoreElements: (el) => el.classList.contains("feedback-floating-container"),
      });

      // JPEG 60% quality — good balance of size/quality
      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      setScreenshot(dataUrl);
    } catch {
      toast.error(t("pages:workspace.feedback.floating.screenshotFailed"));
    }
    setCapturing(false);
  }, []);

  const handleSubmit = async () => {
    if (!content.trim()) {
      toast.error(t("pages:workspace.feedback.floating.describeRequired"));
      return;
    }
    setSubmitting(true);

    // Upload screenshot via raw HTTP POST
    let screenshotUrl: string | undefined;
    if (screenshot) {
      try {
        const token = localStorage.getItem("local_auth_token") || "";
        const res = await fetch("/api/upload-screenshot", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-local-auth-token": token,
          },
          body: JSON.stringify({ image: screenshot }),
        });
        const data = await res.json();
        if (res.ok && data.url) screenshotUrl = data.url;
      } catch {
        /* ignore upload failure, continue without screenshot */
      }
    }

    // Submit feedback via tRPC
    const consoleLogs: string[] = [];
    try {
      consoleLogs.push(`User Agent: ${navigator.userAgent.slice(0, 100)}`);
      consoleLogs.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);
    } catch { /* ignore */ }

    // Re-read at the point of sending: `consent` is only meaningful if it is
    // the consent the user still holds.
    const attachments = chosenRef.current;
    if (maxAttachments !== null && attachments.length > maxAttachments) {
      toast.error(t("pages:workspace.feedback.floating.tooManySelected", { max: maxAttachments }));
      setSubmitting(false);
      return;
    }

    submitMutation.mutate({
      projectId,
      targetType: "ui",
      feedbackType: type,
      severity,
      content: content.trim(),
      screenshotUrl,
      context: {
        url: window.location.href,
        browser: navigator.userAgent,
        os: navigator.platform,
        consoleLogs,
      },
      tags: [type, severity],
      // D11: exactly the objects this account still has ticked, each carrying its
      // own consent. An empty list is the normal case, not an error.
      attachments,
    });
  };

  return (
    <>
      {/* Floating Button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="feedback-floating-container fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg shadow-blue-900/30 transition-all hover:scale-105 active:scale-95"
        >
          <MessageSquarePlus className="w-4 h-4" />
          <span className="text-sm font-medium">{t("pages:workspace.feedback.floating.buttonLabel")}</span>
        </button>
      )}

      {/* Feedback Panel — flex column: header + scrollable body + fixed footer */}
      {isOpen && (
        <div
          className="feedback-floating-container fixed bottom-6 right-6 z-50 w-80 bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl flex flex-col"
          style={{ maxHeight: "min(600px, calc(100vh - 48px))" }}
        >
          {/* ─── Fixed Header ─── */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 shrink-0">
            <h3 className="text-sm font-semibold text-neutral-200">{t("pages:workspace.feedback.floating.title")}</h3>
            <button
              onClick={() => {
                // Closing mid-send would reset the consent the report is about
                // to carry, so it is not a cancel and must not look like one.
                if (submitting) { toast.info(t("pages:workspace.feedback.floating.submitInProgress")); return; }
                setIsOpen(false); resetForm();
              }}
              className="text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* ─── Scrollable Body ─── */}
          <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-3">

            {/* Type selector */}
            <div>
              <p className="text-[11px] text-neutral-500 mb-1.5 uppercase tracking-wide">{t("pages:workspace.feedback.floating.typeLabel")}</p>
              <div className="grid grid-cols-4 gap-1">
                <TypeBtn active={type === "bug"} onClick={() => setType("bug")} icon={<Bug className="w-3.5 h-3.5" />} label={t("pages:workspace.feedback.floating.types.bug")} />
                <TypeBtn active={type === "suggestion"} onClick={() => setType("suggestion")} icon={<Lightbulb className="w-3.5 h-3.5" />} label={t("pages:workspace.feedback.floating.types.idea")} />
                <TypeBtn active={type === "praise"} onClick={() => setType("praise")} icon={<ThumbsUp className="w-3.5 h-3.5" />} label={t("pages:workspace.feedback.floating.types.praise")} />
                <TypeBtn active={type === "confusion"} onClick={() => setType("confusion")} icon={<HelpCircle className="w-3.5 h-3.5" />} label={t("pages:workspace.feedback.floating.types.confused")} />
              </div>
            </div>

            {/* Severity (bugs only) */}
            {type === "bug" && (
              <div>
                <p className="text-[11px] text-neutral-500 mb-1.5 uppercase tracking-wide">{t("pages:workspace.feedback.floating.severityLabel")}</p>
                <div className="flex gap-1">
                  {(["critical", "major", "minor", "cosmetic"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSeverity(s)}
                      className={`flex-1 text-[10px] py-1 rounded border transition-colors ${
                        severity === s
                          ? s === "critical" ? "bg-red-500/20 border-red-500/50 text-red-400"
                          : s === "major" ? "bg-orange-500/20 border-orange-500/50 text-orange-400"
                          : s === "minor" ? "bg-yellow-500/20 border-yellow-500/50 text-yellow-400"
                          : "bg-neutral-500/20 border-neutral-500/50 text-neutral-400"
                          : "border-neutral-700 text-neutral-500 hover:border-neutral-600"
                      }`}
                    >
                      {t(`workspace.feedback.floating.severities.${s}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Description */}
            <div>
              <p className="text-[11px] text-neutral-500 mb-1.5 uppercase tracking-wide">{t("pages:workspace.feedback.floating.descriptionLabel")}</p>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t("pages:workspace.feedback.floating.descriptionPlaceholder")}
                className="w-full h-20 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200 placeholder:text-neutral-600 resize-none focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Attach — D11 consented feedback attachments.
                One checkbox per object, all unticked by default: this is the
                opt-in itself, not a preference and not a global setting. What
                gets stored is decided server-side from what THIS account can
                already read, so a shared or purchased workflow arrives
                redacted exactly as it looks in its own status view. */}
            <div>
              <p className="text-[11px] text-neutral-500 mb-1.5 uppercase tracking-wide">{t("pages:workspace.feedback.floating.attachLabel")}</p>
              <p className="text-[10px] text-neutral-600 mb-2 leading-snug">{t("pages:workspace.feedback.floating.consentNotice")}</p>
              {attachableFailed ? (
                // A failed read is not an empty list: saying "nothing to attach"
                // here would hide the one thing the user needs to act on.
                <p className="text-[11px] text-amber-400/90">
                  {t("pages:workspace.feedback.floating.attachLookupFailed")}{" "}
                  <button type="button" onClick={() => refetchAttachable()} className="underline underline-offset-2">
                    {t("pages:workspace.feedback.floating.retry")}
                  </button>
                </p>
              ) : attachableLoading ? (
                <p className="text-[11px] text-neutral-600">{t("pages:workspace.feedback.floating.attachLoading")}</p>
              ) : attachableItems.length === 0 ? (
                <p className="text-[11px] text-neutral-600">{t("pages:workspace.feedback.floating.nothingAttachable")}</p>
              ) : (
                <div className="space-y-1">
                  {attachableItems.map((item) => {
                    const key = choiceKey(item.kind, item.refId);
                    const checked = !!consented[key];
                    // The server's own cap, applied before the send rather than
                    // after it: past five the whole report is refused, so a
                    // sixth tick must not look like a valid choice.
                    const atCap = maxAttachments !== null && !checked && chosenAttachments.length >= maxAttachments;
                    return (
                      <label
                        key={key}
                        className={`flex items-start gap-2 text-[11px] rounded border px-2 py-1.5 transition-colors ${
                          atCap ? "border-neutral-800 text-neutral-700 cursor-not-allowed"
                            : checked
                              ? "border-blue-500/50 bg-blue-500/10 text-neutral-200 cursor-pointer"
                              : "border-neutral-700 text-neutral-500 hover:border-neutral-600 cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={atCap || submitting}
                          onChange={(e) => setConsented((prev) => ({ ...prev, [key]: e.target.checked }))}
                          className="mt-0.5 shrink-0 accent-blue-600"
                        />
                        <span className="min-w-0">
                          <span className="uppercase tracking-wide text-[9px] text-neutral-500 mr-1">
                            {t(`workspace.feedback.floating.kinds.${item.kind}`)}
                          </span>
                          <span className="break-words">{item.title || `${item.kind} ${item.refId}`}</span>
                        </span>
                      </label>
                    );
                  })}
                  {maxAttachments !== null && chosenAttachments.length >= maxAttachments && (
                    <p className="text-[10px] text-amber-400/90">
                      {t("pages:workspace.feedback.floating.attachmentCap", { max: maxAttachments })}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Screenshot */}
            <div>
              <p className="text-[11px] text-neutral-500 mb-1.5 uppercase tracking-wide">{t("pages:workspace.feedback.floating.screenshotLabel")}</p>
              {screenshot ? (
                <div className="relative rounded-lg overflow-hidden border border-neutral-700">
                  <img
                    src={screenshot}
                    alt={t("pages:workspace.feedback.floating.screenshotAlt")}
                    className="w-full h-20 object-cover object-top"
                  />
                  <div className="absolute top-1 right-1 flex gap-1">
                    <span className="text-[9px] text-white/90 bg-black/60 px-1.5 py-0.5 rounded">
                      {Math.round(screenshot.length / 1024)}KB
                    </span>
                    <button
                      onClick={() => setScreenshot(null)}
                      className="bg-black/60 text-white rounded-full p-0.5 hover:bg-black/80"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={captureScreenshot}
                  disabled={capturing}
                  className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-blue-400 transition-colors border border-dashed border-neutral-700 hover:border-blue-500/50 rounded-lg px-3 py-2 w-full justify-center"
                >
                  {capturing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                  {capturing ? t("pages:workspace.feedback.floating.capturing") : t("pages:workspace.feedback.floating.captureScreenshot")}
                </button>
              )}
            </div>

          </div>{/* end scrollable body */}

          {/* ─── Fixed Footer — Submit Button ─── */}
          <div className="px-4 py-3 border-t border-neutral-800 shrink-0 bg-neutral-900 rounded-b-xl">
            <Button
              onClick={handleSubmit}
              disabled={submitting || !content.trim()}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white text-xs h-9"
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              ) : (
                <Check className="w-3.5 h-3.5 mr-1.5" />
              )}
              {submitting ? t("pages:workspace.feedback.floating.sending") : t("pages:workspace.feedback.floating.sendFeedback")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function TypeBtn({ active, onClick, icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 py-1.5 rounded border transition-colors ${
        active
          ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
          : "border-neutral-700 text-neutral-500 hover:border-neutral-600 hover:text-neutral-400"
      }`}
    >
      {icon}
      <span className="text-[9px]">{label}</span>
    </button>
  );
}
