# Commit-to-Changelog

A week of commits in, a release-ready changelog out — classified entries, human-readable writing, and a semver suggestion.

An example pipeline exported from DeeWaanAI, with the evaluation that scored it.

- **Steps:** 3
- **Judging panel:** 3 judge(s); rubric dimensions: correctness (0.5), runnability (0.25), clarity (0.25)
- **Test data:** 1 case(s), 2 candidate output(s)
- **Certified version:** 1, definition hash `f5aacf5a46525e666b38dd5691a78808224728e7ac7b2d38b7b1f4f756b9665b`

## Files

| File | What it is |
|---|---|
| `pipeline.json` | the pipeline itself: ordered steps, prompts, per-step model and limits |
| `evidence.manifest.json` | the published evidence record exactly as issued, including its Ed25519 attestation |
| `judging.json` | rubric, the full judging prompts, the judges and the aggregation rule |
| `scores.json` | every judgment, the tested models, cost and test time |

Import `pipeline.json` into a local DeeWaanAI install to use it; the evidence and scores are the record of what it scored when this version was tested.
