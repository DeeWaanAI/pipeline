# Paper Digest

A research paper (or abstract) in, a trustworthy digest out: claims, evidence table, limitations, and a 200-word plain-English summary.

An example pipeline exported from DeeWaanAI, with the evaluation that scored it.

- **Steps:** 3
- **Judging panel:** 3 judge(s); rubric dimensions: accuracy (0.3), completeness (0.25), instructionFit (0.25), clarity (0.2)
- **Test data:** 1 case(s), 2 candidate output(s)
- **Certified version:** 1, definition hash `37e6d9c44ef0e7be26d28b09325525801daf192b25ff4944e60c854eb6283c8f`

## Files

| File | What it is |
|---|---|
| `pipeline.json` | the pipeline itself: ordered steps, prompts, per-step model and limits |
| `evidence.manifest.json` | the published evidence record exactly as issued, including its Ed25519 attestation |
| `judging.json` | rubric, the full judging prompts, the judges and the aggregation rule |
| `scores.json` | every judgment, the tested models, cost and test time |

Import `pipeline.json` into a local DeeWaanAI install to use it; the evidence and scores are the record of what it scored when this version was tested.
