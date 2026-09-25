import { useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import type { JudgePromptKey, JudgePromptOverrides } from "../../contracts/offeringV2";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";

type EditorData = inferRouterOutputs<AppRouter>["benchmark"]["judgePrompts"];

export default function JudgingPrompts() {
  const { t } = useTranslation("pages");
  const [params, setParams] = useSearchParams();
  const requestedId = Number(params.get("benchmarkId"));
  const benchmarkId = Number.isSafeInteger(requestedId) && requestedId > 0 ? requestedId : undefined;
  const list = trpc.benchmark.list.useQuery({ limit: 50 });
  const detail = trpc.benchmark.judgePrompts.useQuery({ benchmarkId: benchmarkId ?? 1 }, {
    enabled: benchmarkId !== undefined, refetchOnWindowFocus: false,
  });
  const [dirty, setDirty] = useState(false);

  return <AppShell>
    <div className="h-full min-w-0 overflow-y-auto p-4 sm:p-6 space-y-5">
      <header>
        <h1 className="text-xl font-semibold">{t("judging.title")}</h1>
        <p className="mt-2 text-sm text-neutral-400">{t("judging.intro")}</p>
      </header>
      <label className="block text-sm space-y-2">
        <span>{t("judging.evaluation")}</span>
        <select className="block w-full max-w-lg rounded border border-neutral-700 bg-neutral-900 p-2" value={benchmarkId ?? ""}
          onChange={(event) => {
            if (dirty && !window.confirm(t("judging.discard"))) return;
            setDirty(false);
            setParams(event.target.value ? { benchmarkId: event.target.value } : {});
          }}>
          <option value="">{t("judging.select")}</option>
          {benchmarkId && !list.data?.some((b) => b.id === benchmarkId) && <option value={benchmarkId}>#{benchmarkId}</option>}
          {list.data?.map((b) => <option key={b.id} value={b.id}>#{b.id} · {b.executionMode} · {b.state}</option>)}
        </select>
      </label>
      {list.isLoading && <p role="status">{t("judging.loading")}</p>}
      {list.error && <p role="alert" className="text-red-400">{list.error.message}</p>}
      {list.data?.length === 0 && <p className="text-neutral-400">{t("judging.empty")}</p>}
      {benchmarkId && detail.isLoading && <p role="status">{t("judging.loading")}</p>}
      {detail.error && <div role="alert" className="space-y-2 text-red-400">
        <p>{detail.error.message}</p><Button variant="outline" onClick={() => void detail.refetch()}>{t("judging.reload")}</Button>
      </div>}
      {detail.data && !detail.error && <PromptForm key={`${benchmarkId}:${detail.data.revision}`} data={detail.data} onDirty={setDirty}
        reload={() => { if (!dirty || window.confirm(t("judging.discard"))) { setDirty(false); void detail.refetch(); } }} />}
    </div>
  </AppShell>;
}

function PromptForm({ data, onDirty, reload }: { data: EditorData; onDirty: (dirty: boolean) => void; reload: () => void }) {
  const { t } = useTranslation("pages");
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<JudgePromptKey>(data.prompts[0]?.key ?? "default");
  const [overrides, setOverrides] = useState<JudgePromptOverrides>(data.overrides);
  const preview = trpc.benchmark.judgePrompts.useQuery({ benchmarkId: data.benchmarkId, overrides }, {
    enabled: false, refetchOnWindowFocus: false,
  });
  const save = trpc.benchmark.saveJudgePrompts.useMutation({
    onSuccess: (next) => {
      onDirty(false);
      toast.success(t("judging.saved"));
      utils.benchmark.judgePrompts.setData({ benchmarkId: data.benchmarkId }, next);
      void utils.benchmark.quote.invalidate({ benchmarkId: data.benchmarkId });
    },
  });
  const prompt = data.prompts.find((p) => p.key === selected);
  const framing = overrides[selected] ?? data.defaults.find((p) => p.key === selected)?.framing;
  const dirty = JSON.stringify(overrides) !== JSON.stringify(data.overrides);
  const edit = (next: JudgePromptOverrides) => {
    setOverrides(next);
    onDirty(JSON.stringify(next) !== JSON.stringify(data.overrides));
  };
  const shown = preview.data?.prompts.find((p) => p.key === selected) ?? prompt;
  if (!prompt || !framing) return <p role="alert">{t("judging.noPrompts")}</p>;

  return <section className="space-y-5">
    <div className="rounded border border-neutral-700 bg-neutral-900 p-4 space-y-2 text-sm">
      <p>{t(data.editable ? "judging.editable" : "judging.locked")}</p>
      <p className="text-neutral-400">{t("judging.safety")}</p>
      <p className="text-amber-300">{t("judging.approval")}</p>
      <p className="text-neutral-400">{data.judges.map((j) => j.model).join(" · ")}</p>
    </div>
    <details className="rounded border border-neutral-800 p-3">
      <summary className="cursor-pointer text-sm">{t("judging.criteria")}</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-400">{JSON.stringify(data.rubric, null, 2)}</pre>
    </details>
    <label className="block text-sm space-y-2">
      <span>{t("judging.variant")}</span>
      <select value={selected} disabled={save.isPending} onChange={(e) => setSelected(e.target.value as JudgePromptKey)}
        className="block w-full max-w-lg rounded border border-neutral-700 bg-neutral-900 p-2">
        {data.prompts.map((p) => <option key={p.key} value={p.key}>{t(`judging.variants.${p.key}`)}</option>)}
      </select>
    </label>
    <div className="grid gap-4 lg:grid-cols-2">
      {(["system", "preface"] as const).map((field) => <label key={field} className="block space-y-2 text-sm">
        <span>{t(`judging.${field}`)}</span>
        <textarea className="block w-full min-h-40 rounded border border-neutral-700 bg-neutral-900 p-3 text-sm disabled:opacity-60"
          value={framing[field]} maxLength={field === "system" ? 2000 : 4000} readOnly={!data.editable} disabled={save.isPending}
          onChange={(e) => edit({ ...overrides, [selected]: { ...framing, [field]: e.target.value } })} />
      </label>)}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={preview.isFetching || save.isPending} onClick={() => void preview.refetch()}>{t("judging.preview")}</Button>
      {data.editable && <>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate({ benchmarkId: data.benchmarkId, expectedRevision: data.revision, overrides })}>
          {t(save.isPending ? "judging.saving" : "judging.save")}
        </Button>
        <Button variant="outline" disabled={save.isPending || overrides[selected] === undefined} onClick={() => {
          const next = { ...overrides }; delete next[selected]; edit(next);
        }}>{t("judging.reset")}</Button>
      </>}
      <Button variant="outline" disabled={save.isPending} onClick={reload}>{t("judging.reload")}</Button>
    </div>
    {(save.error || preview.error) && <p role="alert" className="text-red-400">{save.error?.message ?? preview.error?.message}</p>}
    {dirty && <p role="status" className="text-amber-300">{t("judging.unsaved")}</p>}
    <div className="space-y-3">
      <h2 className="font-semibold">{t(preview.data ? "judging.previewTitle" : "judging.savedPreview")}</h2>
      <p className="text-xs text-neutral-500 break-all">{shown?.promptVersion}</p>
      <p className="text-xs text-neutral-400">{t("judging.placeholders")}</p>
      {shown?.messages.map((message, index) => <div key={index} className="rounded border border-neutral-800 p-3">
        <h3 className="text-xs uppercase text-blue-400">{message.role}</h3>
        <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-300">{message.content}</pre>
      </div>)}
    </div>
  </section>;
}
