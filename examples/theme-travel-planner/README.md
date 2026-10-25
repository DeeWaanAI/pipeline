# Theme Travel Planner

A theme and a hard budget in, a realistic day-by-day trip out: destinations, itinerary, costed budget, and a packing list matched to the theme.

An example pipeline exported from DeeWaanAI, with the evaluation that scored it.

- **Steps:** 4
- **Judging panel:** 3 judge(s); rubric dimensions: accuracy (0.3), completeness (0.25), instructionFit (0.25), clarity (0.2)
- **Test data:** 1 case(s), 2 candidate output(s)
- **Certified version:** 1, definition hash `10d07118d60f7315ad92d0aacf15f904e369c8648640090ef774d9a75f1c6c1f`

## Files

| File | What it is |
|---|---|
| `pipeline.json` | the pipeline itself: ordered steps, prompts, per-step model and limits |
| `evidence.manifest.json` | the published evidence record exactly as issued, including its Ed25519 attestation |
| `judging.json` | rubric, the full judging prompts, the judges and the aggregation rule |
| `scores.json` | every judgment, the tested models, cost and test time |

Import `pipeline.json` into a local DeeWaanAI install to use it; the evidence and scores are the record of what it scored when this version was tested.
