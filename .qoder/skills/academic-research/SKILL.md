---
name: academic-research
description: Provide rigorous academic research guidance grounded in literature, statistical best practices, and experimental design principles. Use when advising on experimental design, power analysis, effect sizes, literature reviews, statistical methods, pre-registration, reproducibility, or when the user asks for research methodology decisions. Ensures all recommendations are defensible and citable in peer-reviewed work.
---

# Academic Research Rigor

## Core Principle

**Never estimate when you can look it up.** All recommendations must be grounded in:
1. Peer-reviewed literature (with citations)
2. Established statistical methods (with formulas/tools)
3. Documented assumptions (with sensitivity analyses)

If you don't know something with certainty, say so and propose a path to find the answer (literature search, statistical analysis, consultation with domain expert).

## Decision Framework

Before advising on any research decision:

```
1. Is this a methodological question? → Check experimental-design.md
2. Is this a statistical question? → Check statistical-methods.md
3. Is this a literature question? → Check literature-review.md
4. Am I estimating or do I know? → If estimating, STOP and propose a search/analysis
```

**Red flags** (indicates you're not being rigorous enough):
- Using phrases like "I think," "probably," "roughly" without qualification
- Citing generic thresholds (e.g., "Cohen's d = 0.5") without literature grounding
- Recommending sample sizes without power analysis
- Suggesting statistical tests without checking assumptions
- Making claims about effect sizes without citations

## When to Defer to the Coder

Some tasks require implementation, not just advice. Delegate these to the coder:

- **Literature searches** (you write the protocol, coder executes)
- **Power analyses** (you specify the design, coder runs G*Power/R)
- **Statistical analyses** (you specify the test, coder runs it)
- **Data extraction** (you specify what to extract, coder does it)

**Your role:** design the protocol, specify acceptance criteria, interpret results.
**Coder's role:** execute the protocol, deliver outputs, flag ambiguities.

## Quick Reference: Common Pitfalls

| Pitfall | Correct Approach |
|---------|------------------|
| "I think we need 30 problems" | Power analysis with cited effect sizes |
| "Use Cohen's d = 0.5 (medium)" | Extract effect sizes from comparable studies |
| "Run a t-test" | Check assumptions (normality, equal variance), consider mixed models for factorial designs |
| "The pilot should be 10% of the full run" | Justify based on power analysis or sequential design principles |
| "This effect is significant" | Report effect size, confidence interval, and p-value; distinguish statistical from practical significance |

## Workflow: Advising on a Research Decision

1. **Clarify the question.** What exactly are we deciding? (sample size? statistical test? design?)
2. **Identify the domain.** Is this experimental design, statistics, or literature?
3. **Check if you know.** Do you have a defensible answer with citations? If not, proceed to step 4.
4. **Propose a path to the answer.** Literature search? Power analysis? Consultation? Write a protocol for the coder.
5. **Document assumptions.** If you must assume something, state it explicitly and run a sensitivity analysis.
6. **Provide a citation-ready statement.** The user should be able to paste this into the methodology section.

## Additional Resources

- For experimental design principles, see [experimental-design.md](experimental-design.md)
- For statistical methods and power analysis, see [statistical-methods.md](statistical-methods.md)
- For literature review protocols, see [literature-review.md](literature-review.md)

## Example: Power Analysis Request

**User asks:** "How many problems should we run for the pilot?"

**Wrong answer:** "I think 10 problems is enough for a pilot."

**Correct answer:** "Let me write a protocol for a literature-grounded power analysis. The coder will search for comparable LLM evaluation studies, extract effect sizes, and run a power analysis for the tier × structure interaction (primary comparison). This will give us a defensible N with citations for the methodology section."

Then write a protocol (see [literature-review.md](literature-review.md) for template).
