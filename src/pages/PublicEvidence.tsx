/**
 * The public evidence record for one published manifest (decision D9: the browser
 * is the record, and evidence needs a canonical public URL so a third party can
 * verify it).
 *
 * Every field below comes from the disclosure manifest the author published —
 * including the EXACT judging prompts, every judgment and every failed one. The
 * page can only show what the manifest holds: `includesPrivateDefinition` is
 * false by contract, so there is no workflow definition here to leak, and inputs
 * or outputs the author withheld are shown as withheld rather than as empty.
 */
import { useTranslation } from "react-i18next";
import { useParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { AppShell } from "@/components/layout/AppShell";
import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from "lucide-react";

export default function PublicEvidencePage() {
  const { t } = useTranslation("pages");
  const { manifestHash } = useParams<{ manifestHash: string }>();
  const wanted = (manifestHash ?? "").trim();
  const { data, isLoading } = trpc.marketplace.getEvidenceByHash.useQuery(
    { manifestHash: wanted },
    { enabled: wanted.length === 64 },
  );
  const manifest = data?.manifest ?? null;

  if (wanted.length !== 64) {
    return <Frame><Notice text={t("pages:evidencePage.badAddress")} /></Frame>;
  }
  if (isLoading) {
    return <Frame><p className="py-16 text-center text-sm text-neutral-500">{t("pages:evidencePage.loading")}</p></Frame>;
  }
  if (!manifest) {
    // Also the withdrawn case: withdrawal removes the public representation, and
    // a hash a reader was handed must say so rather than 404 in silence.
    return <Frame><Notice text={t("pages:evidencePage.notFound")} /></Frame>;
  }

  const j = manifest.judging;
  const money = (value: string) => (value === "unknown" ? t("pages:evidencePage.unknown") : `$${value}`);
  const failedAttempts = manifest.attempts.attempts.filter((a) => a.outcome !== "success");

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <header>
          <h1 className="text-2xl font-bold text-neutral-100">{t("pages:evidencePage.title")}</h1>
          <p className="mt-1 text-sm text-neutral-500">{t("pages:evidencePage.subtitle")}</p>
          <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Fact label={t("pages:evidencePage.provenance")} value={t(`pages:evidencePage.provenances.${manifest.provenance}`)} />
            <Fact label={t("pages:evidencePage.kind")} value={t(`pages:evidencePage.kinds.${manifest.publicationKind}`)} />
            <Fact label={t("pages:evidencePage.disclosure")} value={t(`pages:evidencePage.disclosures.${manifest.disclosureClass}`)} />
            <Fact label={t("pages:evidencePage.testedAt")} value={new Date(manifest.testedAt).toLocaleString()} />
            <Fact label={t("pages:evidencePage.publishedAt")} value={manifest.publishedAt ? new Date(manifest.publishedAt).toLocaleString() : "—"} />
            <Fact label={t("pages:evidencePage.policy")} value={`${manifest.publicationPolicyVersion} / ${manifest.consentVersion}`} />
          </dl>
          {manifest.withheldReason && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 w-3.5 h-3.5 shrink-0" />
              {manifest.withheldReason}
            </p>
          )}
          <p className="mt-3 break-all font-mono text-[11px] text-neutral-600">{wanted}</p>
        </header>

        <Section title={t("pages:evidencePage.whatWasTested")}>
          <p className="text-sm text-neutral-300">{manifest.versionIdentity.executionStrategySummary}</p>
          <p className="mt-1 text-xs text-neutral-500">{manifest.versionIdentity.evidenceScope}</p>
          <p className="mt-1 text-xs text-neutral-500">{manifest.publicTestConfiguration}</p>
          <p className="mt-1 text-[11px] font-mono text-neutral-600">
            v{manifest.versionIdentity.workflowVersionNumber} · {manifest.versionIdentity.definitionHash.slice(0, 16)}…
          </p>
          <p className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
            <ShieldCheck className="w-4 h-4 shrink-0 text-green-400" />
            {t("pages:evidencePage.noPrivateDefinition")}
          </p>
          {manifest.versionIdentity.listingId && (
            <Link to={`/marketplace/${manifest.versionIdentity.listingId}`} className="mt-2 inline-block text-xs text-blue-400 underline">
              {t("pages:evidencePage.backToListing")}
            </Link>
          )}
        </Section>

        <Section title={t("pages:evidencePage.promptsTitle")}>
          <p className="mb-3 text-xs text-neutral-500">{t("pages:evidencePage.promptsNote")}</p>
          <div className="space-y-3">
            {j.judgePrompts.map((p) => (
              <details key={p.judgePromptVersion} className="rounded-lg border border-neutral-800 bg-neutral-900/40">
                <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-neutral-300">{p.judgePromptVersion}</summary>
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap border-t border-neutral-800 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-400">{p.promptText}</pre>
              </details>
            ))}
          </div>
        </Section>

        <Section title={t("pages:evidencePage.panelTitle")}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-1 pr-3">{t("pages:evidencePage.slot")}</th>
                  <th className="py-1 pr-3">{t("pages:evidencePage.judgeModel")}</th>
                  <th className="py-1 pr-3">{t("pages:evidencePage.prompt")}</th>
                  <th className="py-1">{t("pages:evidencePage.settings")}</th>
                </tr>
              </thead>
              <tbody>
                {j.judges.map((judge, i) => (
                  <tr key={i} className="border-t border-neutral-800/70 text-neutral-300">
                    <td className="py-1.5 pr-3">{judge.judgeSlot}</td>
                    <td className="py-1.5 pr-3 font-mono">
                      {judge.judgeModel}
                      {judge.variant && <span className="text-neutral-500"> · {judge.variant}</span>}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-neutral-400">{judge.judgePromptVersion}</td>
                    <td className="py-1.5 text-neutral-400">
                      {Object.entries(judge.settings).map(([k, v]) => `${k}=${String(v)}`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title={t("pages:evidencePage.rubricTitle")}>
          <p className="mb-2 text-[11px] font-mono text-neutral-600">{j.rubric.rubricVersionRef}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {j.rubric.dimensions.map((d) => (
              <div key={d.dimension} className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                <p className="text-xs font-medium text-neutral-200">{d.dimension}</p>
                <p className="mt-1 text-[11px] text-neutral-500">{d.definition}</p>
                <p className="mt-1 text-[11px] text-neutral-500">
                  {d.lowerBound}–{d.upperBound} · {t("pages:evidencePage.weight")} {d.weight}
                </p>
                <ul className="mt-1 space-y-0.5 text-[11px] text-neutral-600">
                  {d.anchors.map((a, i) => <li key={i}>— {a}</li>)}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">{j.aggregationRule}</p>
        </Section>

        <Section title={t("pages:evidencePage.judgmentsTitle", { n: j.judgments.length })}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-1 pr-3">{t("pages:evidencePage.case")}</th>
                  <th className="py-1 pr-3">{t("pages:evidencePage.candidate")}</th>
                  <th className="py-1 pr-3">{t("pages:evidencePage.slot")}</th>
                  <th className="py-1 pr-3">{t("pages:evidencePage.result")}</th>
                  <th className="py-1">{t("pages:evidencePage.rationale")}</th>
                </tr>
              </thead>
              <tbody>
                {j.judgments.map((v, i) => (
                  <tr key={i} className="border-t border-neutral-800/70 align-top text-neutral-300">
                    <td className="py-1.5 pr-3 font-mono text-neutral-400">{v.stableCaseId}</td>
                    <td className="py-1.5 pr-3 font-mono text-neutral-400">
                      {v.stableCandidateId ?? v.pairedCandidateIds?.join(" vs ") ?? "—"}
                    </td>
                    <td className="py-1.5 pr-3">
                      {v.judgeSlot}
                      <span className="block font-mono text-[10px] text-neutral-600">{v.judgePromptVersion}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      {v.dimensionScores?.map((s) => (
                        <span key={s.dimension} className="mr-2 font-mono">
                          {s.dimension} {s.rawScore}/{s.upperBound}
                        </span>
                      ))}
                      {v.pairPreference && <span className="font-mono">{v.pairPreference}</span>}
                      {v.status !== "completed" && (
                        <span className="flex items-center gap-1 text-amber-400">
                          <XCircle className="w-3.5 h-3.5" />
                          {t(`pages:evidencePage.statuses.${v.status}`)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-neutral-500">{v.rationale ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {j.parseFailures.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
              <p className="text-xs font-medium text-amber-300">
                {t("pages:evidencePage.failedTitle", { n: j.parseFailures.length })}
              </p>
              <ul className="mt-1 space-y-1 text-[11px] text-neutral-400">
                {j.parseFailures.map((f, i) => (
                  <li key={i}>{f.stableCaseId} · slot {f.judgeSlot} · {f.judgePromptVersion} — {f.sanitizedReason}</li>
                ))}
              </ul>
            </div>
          )}

          {j.validatorOutcomes.length > 0 && (
            <ul className="mt-3 space-y-1 text-[11px] text-neutral-400">
              {j.validatorOutcomes.map((v, i) => (
                <li key={i} className="flex items-start gap-2">
                  {v.passed
                    ? <CheckCircle2 className="mt-0.5 w-3.5 h-3.5 shrink-0 text-green-400" />
                    : <XCircle className="mt-0.5 w-3.5 h-3.5 shrink-0 text-amber-400" />}
                  <span>{v.kind} ({v.validatorVersion}) — {v.environment}; {v.limitations}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("pages:evidencePage.casesTitle")}>
          <div className="space-y-3">
            {manifest.cases.map((c) => (
              <div key={c.stableCaseId} className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                <p className="text-[11px] font-mono text-neutral-500">
                  {c.stableCaseId} · {t(`pages:evidencePage.origins.${c.origin}`)}
                  {c.baseCaseId && ` · ${c.baseCaseId}`}
                </p>
                {c.inputText
                  ? <pre className="mt-1 whitespace-pre-wrap text-xs text-neutral-300">{c.inputText}</pre>
                  : <p className="mt-1 text-xs text-neutral-600">{t("pages:evidencePage.inputWithheld")}</p>}
                {c.expectedOutput
                  ? <p className="mt-1 text-[11px] text-neutral-500">{t("pages:evidencePage.reference")}: {c.expectedOutput}</p>
                  : c.referenceMaterialPublished === false && c.withheldReferenceMaterialReason
                    ? <p className="mt-1 text-[11px] text-neutral-600">{c.withheldReferenceMaterialReason}</p>
                    : null}
              </div>
            ))}
          </div>
        </Section>

        <Section title={t("pages:evidencePage.outputsTitle")}>
          <div className="space-y-3">
            {manifest.outputs.map((o, i) => (
              <div key={i} className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                <p className="text-[11px] font-mono text-neutral-500">
                  {o.stableCandidateId} · {o.stableCaseId} · #{o.replicationIndex} ·{" "}
                  {t(`pages:evidencePage.runStatuses.${o.runStatus}`)} · {t(`pages:evidencePage.provenances.${o.provenance}`)}
                </p>
                {o.outputText
                  ? <pre className="mt-1 whitespace-pre-wrap text-xs text-neutral-300">{o.outputText}</pre>
                  : <p className="mt-1 text-xs text-neutral-600">{t("pages:evidencePage.outputWithheld")}</p>}
              </div>
            ))}
          </div>
        </Section>

        <Section title={t("pages:evidencePage.modelsTitle")}>
          <ul className="space-y-1 text-xs text-neutral-400">
            {manifest.testedModels.map((m, i) => (
              <li key={i} className="font-mono">
                {m.requestedModel}
                {m.returnedModel && m.returnedModel !== m.requestedModel && ` → ${m.returnedModel}`}
                <span className="text-neutral-600">
                  {" "}{m.provider}{m.route ? `/${m.route}` : ""} · {m.revision ?? m.notExposedReason}
                </span>
                {m.stepModelMap && m.stepModelMap.length > 0 && (
                  <ul className="ml-4 mt-0.5 space-y-0.5 text-[11px] text-neutral-600">
                    {m.stepModelMap.map((s, k) => (
                      <li key={k}>step {s.stepOrder}: {s.requestedModel}{s.returnedModel && s.returnedModel !== s.requestedModel ? ` → ${s.returnedModel}` : ""}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t("pages:evidencePage.attemptsTitle")}>
          <div className="grid gap-3 sm:grid-cols-2 text-xs text-neutral-400">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
              <p className="mb-1 font-medium text-neutral-300">{t("pages:evidencePage.planned")}</p>
              <p>{manifest.attempts.planned.cases} × {manifest.attempts.planned.candidates} × {manifest.attempts.planned.generationRepeats}</p>
              <p>{manifest.attempts.planned.judgments} judgments · {manifest.attempts.planned.validators} validators</p>
            </div>
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
              <p className="mb-1 font-medium text-neutral-300">{t("pages:evidencePage.completed")}</p>
              <p>{manifest.attempts.completed.cases} × {manifest.attempts.completed.candidates} × {manifest.attempts.completed.generationRepeats}</p>
              <p>{manifest.attempts.completed.judgments} judgments · {manifest.attempts.completed.validators} validators</p>
            </div>
          </div>
          {failedAttempts.length > 0 && (
            <ul className="mt-3 space-y-1 text-[11px] text-neutral-500">
              <li className="text-neutral-400">{t("pages:evidencePage.failedAttempts", { n: failedAttempts.length })}</li>
              {failedAttempts.slice(0, 30).map((a, i) => (
                <li key={i}>{a.operationKind} #{a.attemptIndex} · {a.stableRef} — {a.sanitizedReason ?? a.outcome}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("pages:evidencePage.costsTitle")}>
          <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Fact label={t("pages:evidencePage.costGeneration")} value={money(manifest.costs.totalGenerationCostUsd)} />
            <Fact label={t("pages:evidencePage.costPerRun")} value={money(manifest.costs.generationCostPerCompletedRunUsd)} />
            <Fact label={t("pages:evidencePage.costDesign")} value={money(manifest.costs.designCostUsd)} />
            <Fact label={t("pages:evidencePage.costPreparation")} value={money(manifest.costs.preparationCostUsd)} />
            <Fact label={t("pages:evidencePage.costJudging")} value={money(manifest.costs.judgingCostUsd)} />
            <Fact label={t("pages:evidencePage.costRetries")} value={money(manifest.costs.retryCostUsd)} />
            <Fact label={t("pages:evidencePage.costNarrative")} value={money(manifest.costs.narrativeCostUsd)} />
            <Fact label={t("pages:evidencePage.costProvider")} value={money(manifest.costs.providerInvoicedAmount)} />
          </div>
          <p className="mt-2 text-[11px] text-neutral-500">
            {manifest.costs.tokenUsage.promptTokens}↑ / {manifest.costs.tokenUsage.completionTokens}↓
            {manifest.costs.tokenUsage.cachedTokens > 0 && ` · ${manifest.costs.tokenUsage.cachedTokens} cached`}
            {" "}· {manifest.costs.currency} · {manifest.costs.costCompleteness}
          </p>
          <p className="mt-1 text-[11px] text-neutral-500">
            {manifest.costs.pricingSource} · {new Date(manifest.costs.pricingAsOf).toLocaleString()}
            {manifest.costs.priceVectorVersion && ` · vector ${manifest.costs.priceVectorVersion}`}
          </p>
          {(manifest.costs.estimatedItems.length > 0 || manifest.costs.missingItems.length > 0) && (
            <ul className="mt-2 space-y-1 text-[11px] text-amber-300/80">
              {manifest.costs.estimatedItems.map((m, i) => <li key={`e${i}`}>≈ {m}</li>)}
              {manifest.costs.missingItems.map((m, i) => <li key={`m${i}`}>— {m}</li>)}
            </ul>
          )}
        </Section>
      </div>
    </AppShell>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <AppShell><div className="mx-auto max-w-2xl p-10">{children}</div></AppShell>;
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <AlertTriangle className="mt-0.5 w-5 h-5 shrink-0 text-amber-400" />
      <p className="text-sm text-neutral-400">{text}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-neutral-600">{label}:</dt>
      <dd className="text-neutral-300">{value}</dd>
    </div>
  );
}
