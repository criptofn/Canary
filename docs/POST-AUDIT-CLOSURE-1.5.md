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

## CI results (draft PR #8, run `36094994575`, sha `0b7bae9`)
| leg | result |
|---|---|
| core ubuntu | **SUCCESS** |
| standalone ubuntu / windows / macos | **SUCCESS** |
| golden regression proof (axios 0.27.2 → 1.0.0) | **SUCCESS** |
| **core windows** | **FAILURE — 1211 tests, 1205 pass, 1 fail, 5 skipped** |

Three test-portability defects in the NEW v1.5 tests were found by the ubuntu leg and fixed
(a Windows-only sandbox-kind assertion; a hardcoded Windows path separator; and a PROJECT-attribution
test that depended on Git being installed at `C:\Program Files\Git\cmd`, i.e. on the runner's software
inventory). Ubuntu then went green, confirming all three.

### OPEN BLOCKER — the one Windows failure, and it looks like a PRODUCT defect

```
not ok 1 - setup accepts --toolchain-dir with spaces, records it, and the sealed step sees it
  setup exited 2:

  + C:\Users\runneradmin\AppData\Local\Temp\canary-v15st-unit-gSmlhm\a tool chain with spaces\bin
  the plan's own program is still pinned to an absolute path; these directories exist for what your
  check spawns itself. Revoke with: canary setup --clear-toolchain-dirs

  smoke test (running your own project scripts):
  ✗ tests: npm run test (exit 3)
    the authorized directory never reached the child PATH

  NEEDS ATTENTION — PROJECT CHECK FAILURE — your project's own checks did not pass (tests).
  That is your project talking, not Canary.
```

**This is not a test defect.** The product accepted and sealed an operator-authorized directory whose
path contains spaces, and then that directory **never reached the sealed child's PATH** — which is
precisely the defect BLOCKER 6 exists to close, reappearing for a path shape the audit did not cover.
`setup` additionally reported it as `PROJECT CHECK FAILURE` and blamed the project, which is the second
half of BLOCKER 6 undoing itself in this case.

**It does not reproduce locally**: the same suite passes on this machine (37/37 after a forced
rebuild). One environmental difference is a candidate and has NOT been confirmed: the GitHub runner
checks out to **`D:\a\Canary\Canary`** while `TEMP` is on **`C:`**, so the authorized directory lives
on a different drive from the repository. **No mechanism is claimed** — it needs a host that can
reproduce it.

**Consequence, stated plainly:** `FINDING 6` is fixed for the cases the probe measures, and is
**NOT GREEN on the Windows runner**. The Windows core leg is a required gate, so the closure is
**not complete** and the candidate stays unreleased.

**The cross-drive candidate is REFUTED, by experiment.** `subst R: C:\Users\Johannes\Desktop\canary`
puts the repository on a different drive from `TEMP` (which stays on `C:`) — the same shape as the
runner — and the suite run through `R:` passes:

```
node --test --concurrency=1 R:\apps\cli\dist\test\v15-sealed-toolchain.test.js
  -> tests 25, pass 25, fail 0, exit 0
     including "setup accepts --toolchain-dir with spaces, records it, and the sealed step sees it"
```

The mapping was removed afterwards. So the failure is **not** explained by a cross-drive layout, that
candidate is eliminated, and **the cause remains unknown**. It needs a runner-side diagnostic or a
maintainer machine that reproduces it; no further mechanism is guessed here.

### Third Windows attempt (`36111042216`, sha `447f4fb`) — a DIFFERENT failure

The spelling fix worked: **the path-with-spaces test passed**. A different test then failed:

```
not ok 1 - sweepDescendants finds and kills a live parent's child process
  error: 'sweep killed [7564] but not 2144'      duration_ms: 35980
```
`packages/support/dist/test/lifecycle.test.js:85` — the descendant sweep (the known load-sensitive
one AGENTS.md flags at ~34 s; the whole suite pins `--test-concurrency=8` partly because of it).

**Evidence that it is intermittent rather than deterministic:**
- it PASSED on the v1.4 Windows leg (`testCodeFailure: 0`) and on the immediately preceding run
  `36094994575`, which failed only the path-with-spaces test;
- locally it passes **5/5**, and takes **894 ms** here against **35,980 ms** on the runner — a ~40×
  difference.

**My first hypothesis was wrong and is retracted here:** I guessed a one-second window, but
`sweepWin32` computes `cut = spawnedAtMs - 60_000` (`packages/support/src/index.ts:740`), so the
window is 61 seconds and a slow runner does not by itself explain the miss.

**Classification: INTERMITTENT, HOST-LOAD-DEPENDENT, CAUSE UNDETERMINED.** It is recorded as an open
failure, **not** waved away as a flake, and **not** answered by re-rolling until green — "run it again
until it passes" is the false-green behaviour this project exists to prevent. The Windows core leg is
a required gate and it is **not green**.

## New candidate commit

Recorded after the final gate run; see the closing message.

## Release blockers remaining

Everything in §"full release gates" below is **NOT RUN** against this tree: unit suite, productization
battery, mutation/security batteries, HARDENED live, first-run, real-world regression, CI legs and the
Windows core leg. **READY FOR A SECOND LOCAL AUDIT: NO.**
