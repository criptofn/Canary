# ADR-001 — Product direction: independent verification layer

Date: 2026-08-30 (supersedes framing in docs/PLAN.md §1)
Status: ACCEPTED

## Decision

Canary is **an independent verification layer for AI-written code** —
"Cool diff. Prove that it actually made the project better."

Dependency version updates (the golden case: axios 0.27.2 → 1.0.0) are the
**first controlled proof-of-value** because they provide historical,
reproducible before/after cases. They are a verification *domain*, not the
product boundary.

Core workflow (generalizes the axios arms):

```
capture known baseline -> apply/inspect candidate change ->
run deterministic checks against both states ->
compare (functionality, API behavior, perf, security, tests where available) ->
reproduce suspected regressions -> machine-readable evidence ->
deterministic classification -> only then may an LLM explain/summarize
```

Critical invariant (already implemented, now contractual):
PASS / CONFIRMED_REGRESSION / PRE_EXISTING_FAILURE / FLAKY /
INFRASTRUCTURE_FAILURE / INCONCLUSIVE come from reproducible evidence and
pure functions. `@canary-rn/classification` consumes only exit codes,
runner-summary presence, and infra patterns; it has no dependency on any AI
pathway — the LLM cannot reach the verdict, structurally.

## Orchestrator principle

Canary owns the workflow: baseline/candidate execution, comparison,
reproduction, classification, evidence, final verdict. External tools
(RepoWise for blast radius, RTK for output reduction, Semgrep/CodeQL for
security evidence, CodSpeed for performance, Playwright for UI, Qwen for
explanation) may later feed evidence or improve individual stages **behind
optional adapter/provider boundaries** — they never own the workflow, and
Canary must run with zero external integrations.

## v0.1 scope discipline

Build now: core runner, baseline/candidate execution, classifier, evidence
representation, the historical axios golden fixture, reproducibility.
Do NOT build now: integrations, dashboard, API service, distributed anything.
RepoWise is the likeliest FIRST integration after the core proof lands —
not part of v0.1.

## Consequences

- "Baseline" and "candidate" remain the two arm names for all future change
  types (version swaps, diffs, model-generated commits) — the runner does
  not care what made the candidate differ.
- The Evidence Bundle stays a pure function of observed runs; new evidence
  kinds (perf, security) would extend it as ADDITIONAL deterministic fields,
  never by routing judgment through prose.
- `canary check` (one-command verdict UX) is the eventual front door, but
  only after the golden proof is stable in CI.
