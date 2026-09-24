# Canary v1.5 — post-audit closure report

**Audited candidate:** `a004f5544af6ea62e1f3a4c036af8c8358e23462` (branch `codex/v15-evidence-release`).
**Auditor:** independent (GPT-5.6). **Closure branch head:** see *New candidate commit* at the end.
**Status: NOT RELEASED.** No tag, no merge, no push of the candidate, no v1.6 work.

An independent audit reproduced **four new blockers** and the **three known real-world defects**.
Every finding was reproduced on those exact bytes, classified, corrected with the smallest safe
change, and regressed. **The audit was right on every finding it raised** — including one where the
defect was in this candidate's own published claim.

| # | FINDING | AUDITOR | ROOT CAUSE (measured here) | FIX | REGRESSION | POST-FIX |
|---|---|---|---|---|---|---|
| 1 | Rewritten **existing** check kept independent authority (false GREEN) | CONFIRMED TRUST-BOUNDARY DEFECT, HIGH | `planDiscrimination` recorded `addedChecks` only for files **absent at baseline**; a worker that *rewrote* a recognized check was overlaid, failed on base, and was credited uncaveated | provenance decided by git: `addedChecks` vs new **`modifiedChecks`**, both worker-authored; caveat names which | `tooling/probes/v15-check-provenance.mjs` CASE B | **PASS** |
| 2 | Headline pooled a **fallback-estimator** cell | CONFIRMED | `usage.source` was `streamed per-message usage (no result event)`, `streamedUsageUsable:false`, pooled with 11 provider-native cells. `bench.mjs` filtered on `oracleUsable`, which says nothing about ledger comparability | `tooling/benchmark/eligibility.mjs`; enforced in the probe **and** the reporter; a run also needs one instrument digest | `eligibility.test.mjs` | **PASS** — claim WITHDRAWN |
| 3 | `--from-saved` printed a stale transcript as a current `PASS` | CONFIRMED (product validator NOT bypassed) | the PROBE read the OS-temp transcript regardless of age, host, store or a failed live battery | `--from-saved` is HISTORICAL, exit **2**, prints its own disproof; a failed live battery exits **4** | `hardened-evidence.test.mjs` | **PASS** |
| 4 | Two R1 attempts **mixed** in one output directory | CONFIRMED | the run-task probe reused one directory per task across attempts | one attempt per directory, **refusal on existing evidence**; index corrected | `tooling/probes/v15-attempt-provenance.mjs` | **PASS** (historical gap documented, not invented) |
| 5 | `LOCAL` implied worker-independent proof | **CLAIM TOO STRONG** (behaviour expected at LOCAL) | wording | LOCAL stated as same-user / operator-selected; HARDENED kept as the worker-independent path | `apps/cli/test/local-authority-same-user.test.ts` | see §5 |
| 6 | Sealed step loses `python`/`java`/`git`; Canary blamed the project | CONFIRMED PRODUCT DEFECT | the sealed environment builds its own PATH and ignores the calling PATH **by design** (anti-shadowing); a project whose check spawns an unresolvable tool then failed and was attributed to the project | see §6 | `tooling/probes/v15-sealed-toolchain.mjs`, `v15-sealed-toolchain.test.ts` | see §6 |
| 7 | Legitimate sealed-script check outside a test path = false red | CONFIRMED | the same `isTestPath` predicate that caused #1, failing in the opposite direction | check surface anchored to a **sealed plan script's text** (digest-verified) instead of a path heuristic | same probe, CASE A + CONTROL | **PASS** |
| — | No-git first-run fixture was inside an ancestor repo | harness gap, **not** a product defect | `git -C %TEMP% rev-parse --show-toplevel` → `C:/Users/Johannes`, so the fixture was never repo-free | fixture now proven repo-free (`rev-parse` fails **and** no ancestor `.git`) | `tooling/probes/v15-first-run.mjs` | **PASS** 66/0/0 |

## The token claim did not survive its own fix

| | |
|---|---|
| Published at `a004f55` | `83.21 % of Plain, −16.79 %` — **WITHDRAWN** |
| `v15-everyday` | plain 543,518 → guarded 438,818 — 80.74 % (−19.26 %) — **COMPLETE** |
| `v15-everyday-r2` | **INCOMPLETE** — one cell on the fallback ledger |
| `v15-everyday-r3` | plain 371,094 → guarded 446,893 — **120.43 % (+20.43 %)** — **INCOMPLETE** — six cells, **five instrument digests** |
| Valid cells | the two measurable runs disagree in **sign**; 39.7-point spread against **46.5 % drift in the plain arm alone** |
| Claim supported | **NONE.** Not a smaller saving, not a different percentage. At n=1 per cell this benchmark cannot resolve an effect of this size in either direction |
| Not substituted | the auditor's five-pair −16.38 %. Dropping the failed pair is selection, not a replacement measurement |
| Survives | the standing MCP payload **is** inside the measurement (6/6 guarded advertised `mcp__canary`, 0/6 plain) and costs **~438 tokens** measured provider-natively, not the ~1,432 `bytes ÷ 4` implied |

## Root of trust

- **LOCAL** — records are sealed outside the repository, but the **same user** may select and re-seal
  authority (`canary setup --yes`). A worker with that user's authority can re-seal its own commit.
  Stated as such in the UI and docs; **not** presented as worker-independent.
- **HARDENED** — the worker-independent path: authority is protected from the worker's own OS
  identity, established only by a measured boundary (see `HARDENED-1.5.md`).

## Honesty notes carried forward

- **R1 attempt 1's raw record is NOT on disk and CANNOT be reconstructed** — attempt 2 truncated it.
  Stated as a gap in `REAL-WORLD-EVIDENCE-1.5.md` and the bundle index; nothing was reconstructed.
- A documentation line in `REAL-WORLD-EVIDENCE-1.5.md` claimed `checkpointDrivenManually: true` for an
  R1 attempt where the surviving artifact says the opposite; corrected.
- The HARDENED **live** measurement was deliberately **stopped** when a concurrent force-rebuild landed
  mid-run. A measurement spanning changing bytes is not evidence; it is re-run against a frozen tree.

## New candidate commit

Recorded after the final gate run; see the closing message.

## Release blockers remaining

Everything in §"full release gates" below is **NOT RUN** against this tree: unit suite, productization
battery, mutation/security batteries, HARDENED live, first-run, real-world regression, CI legs and the
Windows core leg. **READY FOR A SECOND LOCAL AUDIT: NO.**
