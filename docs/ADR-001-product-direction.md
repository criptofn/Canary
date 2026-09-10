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

Critical invariant (already implemented, now contractual; amended 2026-09-02
after the audit finding-A demonstration, which showed that the exit-code +
summary-text + infra-pattern channel — while itself never reachable by an
LLM — could be satisfied by a *subject* printing text without ever running
tests; the subject is also a producer that must not certify itself):
PASS / CONFIRMED_REGRESSION / PRE_EXISTING_FAILURE / FLAKY /
INFRASTRUCTURE_FAILURE / INCONCLUSIVE come from reproducible evidence and
pure functions. `@canary-rn/classification` consumes only run facts Canary
derives itself — exit codes, structural output properties, and (post-audit) the
execution-observation channel: a Canary-injected, byte-pinned-runner
lifecycle record that must agree with every text claim before a strong
verdict exists. It has no dependency on any AI pathway — the LLM cannot reach
the verdict, structurally. Full claim contract, trust ladder and stated
ceilings: docs/EXECUTION-AUTHORITY.md.

## Orchestrator principle

Canary owns the workflow: baseline/candidate execution, comparison,
reproduction, classification, evidence, final verdict. External tools
(RepoWise for blast radius, RTK for output reduction, Semgrep/CodeQL for
security evidence, CodSpeed for performance, Playwright for UI, a hosted LLM for
explanation) may later feed evidence or improve individual stages **behind
optional adapter/provider boundaries** — they never own the workflow, and
Canary must run with zero external integrations.

Adapter evidence invariant (post-audit, contractual — docs/EXECUTION-AUTHORITY.md
§10): evidence an adapter merely *claims* is a claim; it may carry a strong
verdict only through a re-derivable Canary-side channel (byte-pinned
execution observation, bound artifacts, committed proof), never through a
producer-asserted scalar. A self-declared producer identity can never
establish attestation — that is the self-certification the hardening exists
to prevent.

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
