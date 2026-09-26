# Canary v1.5 — post-audit closure report

**Audited candidate:** `a004f5544af6ea62e1f3a4c036af8c8358e23462` (branch `codex/v15-evidence-release`).
**Auditor:** independent (GPT-5.6). **Candidate head:** `d3f6a9c5da730d9828be5b5751861b92a028cfd2`,
tested by GitHub Actions run
[`36168541720`](https://github.com/criptofn/Canary/actions/runs/36168541720) (all six legs green).
**Provenance:** `e51b6fc` is the **last product-source change** — the audited product fixes and the
local release batteries belong to it; `c605f2a` and `d3f6a9c` changed documentation, a test
diagnostic, audit tooling, the productization registration and CI plumbing, with **no product-source
behaviour change**.
**Status: NOT RELEASED.** No tag, no merge, no v1.6 work. Handed back for a second audit.

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
| 5 | `LOCAL` implied worker-independent proof | **CLAIM TOO STRONG** (behaviour expected at LOCAL) | wording | LOCAL stated as same-user / operator-selected; HARDENED kept as the worker-independent path | `apps/cli/test/local-authority-same-user.test.ts` | **PASS — 5/5.** A claim correction, **not** a boundary: at LOCAL the same user can still replace the store, the key and the ledger together |
| 6 | Sealed step loses `python`/`java`/`git`; Canary blamed the project | CONFIRMED PRODUCT DEFECT | the sealed environment builds its own PATH and ignores the calling PATH **by design** (anti-shadowing); a project whose check spawns an unresolvable tool then failed and was attributed to the project | an operator-authorized directory is **appended after** the trusted Node/OS dirs (never in front) and refused inside the repository; `SEALED ENV CANNOT RESOLVE` when Canary's restriction is the cause, `PROJECT CHECK FAILURE` only when the project genuinely failed | `tooling/probes/v15-sealed-toolchain.mjs`, `apps/cli/test/v15-sealed-toolchain.test.ts` | **PASS for the tested cases — 25/25**, and the probe measures that the suggested remediation makes the same check pass inside Canary. **Limits:** authorization is an OPERATOR act; no `JAVA_HOME` handling; `HOME` still redirected; not-found signatures cover en/de-DE text plus exit 9009/127 only; the real repositories were **not** re-run with an authorized directory |
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

**Local reproduction attempts, all negative (14 runs, 0 failures):**

| condition | runs | sweep duration | result |
|---|---|---|---|
| idle | 5 | 894 ms | 5/5 pass |
| 48 CPU burners on 24 cores | 5 | 1.6–2.0 s | 5/5 pass |
| 48 burners + test pinned to 2 cores (`affinity 3`) | 4 | 1.8–2.9 s | 4/4 pass |

The runner's sweep took **35,980 ms** — roughly 40× the idle local figure and ~12× the deliberately
constrained one — so the condition is not merely "slow", and this host cannot reach it. Because a
blind re-run could only return green or red *without a reason*, the next leg instead carries a
**diagnostic** (`packages/support/test/lifecycle.test.ts`).

**The diagnostic was too weak, and the second-auditor pass strengthened it (this commit).** It used to
print the whole `SweepResult`, the liveness of both processes and the platform — which cannot say
*which* exclusion happened, and it named only three causes. `sweepWin32` can omit a child in **four**
ways: (a) it is absent from the sweep's one CIM snapshot; (b) its `ParentProcessId` is not the parent
being expanded; (c) its `CreationDate` is **null** (the explicit `$c.CreationDate -and` guard) or
before the 61-second cut; (d) it was found but its `Stop-Process` failed. On failure the message now
carries, in addition:

- `sweepInputParentPid`, `expectedChildPid`, `spawnedAtMs` and the **`cutUsedBySweep`** recomputed
  from them, so the sweep's own boundary is reconstructible from the log;
- a **fresh, throwaway `Get-CimInstance` observation** of both PIDs (row count, `ProcessId`,
  `ParentProcessId`, `CreationDate`, presence), taken only when an assertion is about to fail;
- the shape that observation is consistent with, stated as a shape and, where two remain possible,
  as both.

**Its output path is itself measured, not assumed.** Because a diagnostic that has never fired is a
diagnostic nobody has tested, the *emitted* file was mutated once, outside the source, to reproduce
the runner's exact failure shape (`killed` without the child, `failed: false`) with both processes
alive; the run printed:

```
sweep killed [] but not 10208 | result={"killed":[],"failed":false} | platform=win32
| diagnostic: sweepInputParentPid=56752 | expectedChildPid=10208 | spawnedAtMs=1790349374686
| cutUsedBySweep=2026-09-25T15:15:14.686Z | aliveAtAssertionParent=true | aliveAtAssertionChild=true
| cimObservation snapshotCount=321
| cimObservation row=56752;present=true;ppid=61524;creationDate=2026-09-25T15:16:15.5518550Z
| cimObservation row=10208;present=true;ppid=56752;creationDate=2026-09-25T15:16:15.5867820Z
| shape (d) or a snapshot difference: present with the right parent and a date after the cut, ...
```

The artifact was then rebuilt (`tsc -b packages/support --force`) to a file **byte-identical** to the
previous build (SHA-256 `9CE5F8C6…`), the mutation string is absent, and the suite is 8/8 again.

**Diagnostic only: no assertion, threshold, timeout, kill or selection changed, and nothing here can
turn a failure into a pass.** It does **not** fix the containment question, and it is not claimed to.


### Fourth Windows attempt (`36131430147`, sha `e51b6fc`) — ALL SIX LEGS SUCCESS

| leg | result |
|---|---|
| `build + unit/integration tests (offline)` (ubuntu-latest) | **SUCCESS** |
| `build + unit/integration tests (offline)` (windows-latest) | **SUCCESS** — 1211 tests, **1206 pass, 0 fail, 5 skipped** |
| `standalone single executable` (ubuntu / windows / macos) | **SUCCESS** |
| `golden regression proof (axios 0.27.2 -> 1.0.0)` | **SUCCESS** |

Run `completed/success`; the Windows leg ran **170 minutes** against a 300-minute cap (**terminal, not a
timeout and not a cancellation**), **zero `not ok` lines**, and the sweep diagnostic **did not fire**.

**The honest caveat, which is part of the result:** the intermittent sweep failure did **not recur**, and
that is *not* evidence it is fixed. The only delta between the failing run and this one is a
**diagnostic in a test failure message**, which cannot affect product behaviour. So the correct reading
is: **the leg is green; the flake is documented, unexplained, and still open.** It is recorded here
rather than silently closed, and it is the first thing a second audit should try to reproduce.

### Fifth (final) Windows / CI attempt (`36168541720`, sha `d3f6a9c`) — ALL SIX LEGS SUCCESS

This run tested the **exact second-auditor candidate head** — the bytes produced by the
documentation pass described in the next section — rather than the older product commit.

| leg | result |
|---|---|
| `build + unit/integration tests (offline)` (ubuntu-latest) | **SUCCESS** — 4.6 min |
| `build + unit/integration tests (offline)` (windows-latest) | **SUCCESS** — 1,211 tests, **1,206 pass, 0 fail, 5 skipped** |
| `standalone single executable` (ubuntu / windows / macos-14) | **SUCCESS** |
| `golden regression proof (axios 0.27.2 -> 1.0.0)` | **SUCCESS** |

Run `completed / success` on head `d3f6a9c5da730d9828be5b5751861b92a028cfd2`, finished
`2026-09-25T21:25:17Z`. The Windows core leg is **terminal**: **1,211 tests, 1,206 pass, 0 fail,
5 skipped, 0 cancelled, 0 todo**, **zero `not ok`** lines, test step ≈ **215.4 min** inside a
**224.1-min** job against the **300-min** cap — completed, **not** timed out and **not** cancelled.
The one `skipped` step in that job (`architecture-closure-mutations.mjs`) is `if: runner.os == 'Linux'`
by design; it ran and passed on the ubuntu leg.

**The sweep passed, and that is still not a fix.** `sweepDescendants finds and kills a live parent's
child process` reported `ok`, and the improved diagnostic produced **zero `cimObservation` output** —
because its failure path **did not fire**. So: the intermittent Windows descendant-sweep failure did
**not** recur, this is the **second consecutive green observation**, and it remains
**NOT FIXED and UNEXPLAINED**. No product change was made between the original failure and either
green run; the only delta is a **test-failure diagnostic**, which cannot alter product behaviour.
A missed descendant would be a containment failure, so this stays at the top of the second-auditor
queue rather than being closed by repetition.

**Runtime, recorded and not explained away.** The Windows core leg took **224.1 min** here against
**170.9 min** on `e51b6fc` — about **31 % slower**, leaving **≈ 76 min** before the 300-min cap.
Whether that is runner variance, host load or something in these bytes is **not established**, and it
is **not** classified as a product defect. The timeout was **not** raised, and no threshold was
touched. It is recorded because a cap timeout would present as a red leg that is not a code defect.

## Second-auditor pass — documentation consistency, and a diagnostic that can be investigated

A second auditor found **no reopened original finding**, and **two** things that had to be corrected
before v1.5 could be called review-ready: the public audit set was internally stale and
contradictory, and the Windows sweep diagnostic did not distinguish all the causes the documentation
claimed it did. Both are addressed in this pass. **No product behaviour changed.**

| ITEM | WHAT WAS WRONG | WHAT THIS PASS DID |
|---|---|---|
| Claim/evidence matrix | still carried `83.21 % / −16.79 %` as **SUPPORTED BUT LIMITED** while a later section of the same file withdrew it; findings 5 and 6 still described as pending; a block declaring release gates un-run that had since gone green | one current truth: the headline is **REJECTED / WITHDRAWN** with **no replacement percentage**; findings 5/6 closed **with their stated limitations**; and the verification table now names **which commit each result covers** — `e51b6fc` is the last product-source change and owns the product fixes and the local batteries, while the **candidate head `d3f6a9c`** owns the CI result |
| Audit kit | asked a reviewer to attack a number this project had already withdrawn, and declared un-run gates that had run | §7.0 is now the **Windows descendant sweep** as the highest-priority open target (the failure, the 14 negative local attempts, why green ≠ fixed); the token target is "**can any effect be resolved at all — the project claims NONE**"; §8 separates CLOSED findings, the OPEN flake, unsupported claims and release state |
| Closure document | its last paragraph contradicted its own successful CI section | replaced by the current-state table below, with provenance, the sweep as **OPEN / UNEXPLAINED**, and the release untagged / unreleased / unmerged |
| README | called v1.3.0 the newest published artifact while the tree was described as a candidate for v1.4, quoted the superseded −19.3 % / −13.4 % pair, and led with a token claim that is withdrawn | v1.4.0 named as the latest **published** release, the source tree as the **unreleased v1.5 candidate**, the withdrawal stated where a reader meets it first, and the four evidence documents linked |
| Everyday benchmark document | its "Claim reset" section still listed the withdrawn aggregate as *supported* | that section now supports **nothing** about an everyday percentage, and the retained tables are labelled as the **withdrawn generation** |
| Real-world evidence document | §4 and §5.1 described defects without their post-audit state | each carries a one-line post-audit note: fixed for the **measured/tested** cases, with the limitation, and with "the repositories were not re-run" said explicitly |
| Windows sweep diagnostic | could not distinguish which exclusion occurred | see the section above: four shapes, a fresh CIM observation, the cut recomputed from the sweep input, and a **measured** self-test of the output path |
| CI trigger | `canary-ci` had no manual dispatch — the only reason draft PR #8 existed | `workflow_dispatch:` added. **Operational plumbing, not a product feature:** 12 inserted lines (comments plus the one trigger), **0 deletions**, and push / pull_request / schedule semantics unchanged. **Not usable from this branch yet, stated as an expectation rather than a measurement:** GitHub builds the dispatchable set from the **default branch**, so a manual dispatch of `canary-ci` is expected to become available only once this file reaches `main`. Nothing here pushes or merges, so that behaviour was **not verified**, and **PR #8 remains the way to run CI on this branch today** |

**A tripwire, because every one of those was found by a person reading carefully.**
`tooling/probes/v15-evidence-consistency.mjs` fails when a withdrawn figure appears without a marker
within ±4 lines, when a retired statement reappears (an un-run gate, a finding still described as
pending, a defect described as unfixed, or an older release described as the newest), or when a
required statement of the current truth disappears. It is registered in `verify:productization`. It
cannot check whether prose is **true** — only that the documents do not contradict each other about
what is claimed. **Its refusal path was itself exercised:** three real context gaps were caught in
`BENCHMARK-EVERYDAY-1.5.md`, and a deliberate falsification (an un-run gate status appended to the
audit kit) produced a FAIL and was restored byte-identically.

**What this pass deliberately did NOT do:** it did **not** re-run the productization battery, the
unit suite or the token benchmark — no product code changed, so their evidence on `e51b6fc` is not
invalidated by documentation. The new consistency probe has been run **standalone** on these bytes;
it has **not** yet been exercised inside a full battery run, and it is recorded here that way rather
than implied to be covered.

## Current state — exact, with provenance

| ITEM | STATE | COVERS WHICH BYTES |
|---|---|---|
| Original seven audited findings | **CLOSED for the measured / reproduced cases** — each row above names its regression and its remaining limitation | product fixes are in **`e51b6fc`**, the last product-source change |
| Full unit suite | **GREEN** — 1,288 tests / 216 suites: **1,284 pass, 0 fail, 4 skipped**, exit 0 | `e51b6fc` |
| Productization battery | **GREEN** — **104 PASS / 0 FAIL / 3 SKIP**, exit 0, 91.4 min | `e51b6fc` |
| HARDENED boundary, live | **GREEN 6/6** — measured on the author's host only; a host that cannot confine is `HOST UNSUPPORTED` | `e51b6fc` |
| Candidate head | **`d3f6a9c`** — documentation, a test diagnostic, audit tooling, the productization registration and CI plumbing; **no product-source behaviour change** | `d3f6a9c` |
| CI, six legs | **GREEN** — run [`36168541720`](https://github.com/criptofn/Canary/actions/runs/36168541720), `completed / success` | **`d3f6a9c`** — the exact candidate head |
| Windows core leg | **TERMINAL SUCCESS on `d3f6a9c`** — 1,211 tests, **1,206 pass, 0 fail, 5 skipped, 0 cancelled, 0 todo**, test step ≈ **215.4 min** in a **224.1-min** job against a 300-min cap, 0 `not ok`. The previous green on `e51b6fc` was **170.9 min** (**≈ 31 % slower**, **≈ 76 min** headroom) — recorded as operational, **not** a product defect, and the timeout was **not** raised | `d3f6a9c`; runtime compared with `e51b6fc` |
| Intermittent Windows descendant-sweep failure | **OPEN / UNEXPLAINED / DID NOT RECUR** — one hosted failure (`sweep killed [7564] but not 2144`, 35,980 ms), 14 negative local attempts, then **two consecutive green runs** with **no product change in between** (only a test diagnostic); the improved diagnostic produced **zero `cimObservation` output** because its failure path did not fire. **Green is not fixed** | failure seen on `447f4fb`; not observed on `e51b6fc` or `d3f6a9c` |
| Windows sweep observability | **DIAGNOSTIC IMPROVED** — the next failure prints the sweep input, expected child, the cut used, the four exclusion shapes and a fresh CIM observation. **Not a fix, and not claimed as one** | diagnostic added in `c605f2a`; silent on `d3f6a9c` |
| Everyday token-saving claim | **NONE** — `83.21 % / −16.79 %` withdrawn with no replacement; the two COMPLETE runs disagree in sign (80.74 % / −19.26 % and 102.91 % / +2.91 %); the pooled −10.19 % is smaller than the run-to-run spread | `e51b6fc` |
| Standing MCP payload | **~438 tokens**, measured provider-natively; in-session 6/6 guarded vs 0/6 plain — a cost measurement, not a saving | `e51b6fc` |
| v1.5 tagged | **NO** — no `v1.5*` tag exists | — |
| v1.5 released | **NO** — no v1.5 release exists | — |
| Merged to `main` | **NO** — `main` is `4271e6e` (`v1.4.0`, the latest published artifact) | — |
| Second external audit | **IN PROGRESS** — a second auditor reviewed this closure, found no reopened original finding, and has independently verified CI run `36168541720` on `d3f6a9c`. The intermittent Windows sweep is the outstanding open target | — |

**READY FOR A SECOND AUDIT: YES** — on the grounds that the repository now tells one internally
consistent truth, every gate that has been run is green **except** the sweep result, which is written
as OPEN rather than as green, and the token claim is absent rather than smaller.

**STILL NOT RELEASABLE ON MY OWN AUTHORITY:** the sweep result is unexplained and
containment-shaped; a second auditor has not yet had it. **NOT TAGGED. NOT RELEASED. NOT MERGED.**

**Candidate head: `d3f6a9c5da730d9828be5b5751861b92a028cfd2`** — pushed so the second auditor can
inspect it, and the exact bytes CI run `36168541720` tested. This final recording is **documentation
only** and changes no executable, test, tooling or workflow file.

