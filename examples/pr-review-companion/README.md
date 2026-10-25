# PR Review Companion

Paste a pull-request diff, get a structured senior-level review: style, security, test coverage, and a clear verdict.

An example pipeline exported from DeeWaanAI, with the evaluation that scored it.

- **Steps:** 4
- **Judging panel:** 3 judge(s); rubric dimensions: correctness (0.5), runnability (0.25), clarity (0.25)
- **Test data:** 1 case(s), 2 candidate output(s)
- **Certified version:** 1, definition hash `19a5869fafb3b88cdbf073f56250d2c88eb2255dfb044b0c215dbadd1fac8f4e`

## Files

| File | What it is |
|---|---|
| `pipeline.json` | the pipeline itself: ordered steps, prompts, per-step model and limits |
| `evidence.manifest.json` | the published evidence record exactly as issued, including its Ed25519 attestation |
| `judging.json` | rubric, the full judging prompts, the judges and the aggregation rule |
| `scores.json` | every judgment, the tested models, cost and test time |

Import `pipeline.json` into a local DeeWaanAI install to use it; the evidence and scores are the record of what it scored when this version was tested.
