# CV Multi-Language Pack

One CV in, culturally-adapted CVs out in several languages — not literal translation: date formats, section norms and politeness registers adapted per country.

An example pipeline exported from DeeWaanAI, with the evaluation that scored it.

- **Steps:** 3
- **Judging panel:** 3 judge(s); rubric dimensions: adequacy (0.4), fluency (0.3), terminology (0.3)
- **Test data:** 1 case(s), 2 candidate output(s)
- **Certified version:** 1, definition hash `92d091b53a65993464fcadffba7154ee5bd551b38c668297d5d3dcd1805b5adf`

## Files

| File | What it is |
|---|---|
| `pipeline.json` | the pipeline itself: ordered steps, prompts, per-step model and limits |
| `evidence.manifest.json` | the published evidence record exactly as issued, including its Ed25519 attestation |
| `judging.json` | rubric, the full judging prompts, the judges and the aggregation rule |
| `scores.json` | every judgment, the tested models, cost and test time |

Import `pipeline.json` into a local DeeWaanAI install to use it; the evidence and scores are the record of what it scored when this version was tested.

The CV in the test data is a fabricated example (including the contact address); it is not a real person's document.
