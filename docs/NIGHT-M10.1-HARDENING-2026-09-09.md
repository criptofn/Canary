# M10.1 hardening — F4 closure, host-neutral evidence, claim correction — 2026-09-09

- **Repo/branch:** this clone, `qwen-builder` (builder cage, **no remote, nothing pushed**)
- **Base SHA:** `d6757df4932f652217f8e0a5b7cfa2aacc9b1130` (NOT amended)
- **Host (this run):** Linux 6.18.33.2-microsoft-standard-WSL2 · node v26.7.0 ·
  npm 11.19.0 · git 2.43.0 — POSIX results below are labeled **POSIX-only
  unless stated**; every Windows-sensitive item names its state.
- **Trigger:** independent GLM M10 audit `PASS WITH DOCUMENTED RESIDUALS`; the
  repairable findings were F4 (material Northstar bypass), the S11 POSIX
  fixture vacuity, HTG evidence host-dependence, and the unconditional M10
  claim. F1 and F2 were already dispositioned at `d6757df` (see below).
- **Evidence:** every log cited here is tracked under
  `docs/night-evidence/2026-09-09-m10-1-hardening/`.

## F4 — the taskless obligation bypass (CLOSED, enforced)

**The bypass, re-proved before the fix** (`before-f4-repro-taskless-open.log`,
`tooling/probes/m10-f4-bypass-repro.mjs` at base SHA): a fresh base with NO
registered task, a testless candidate commit, then
`no task → obligationsFor derives ZERO duties → green sealed plan = whole
verdict → CANDIDATE PASS (exit 0) → --promote exit 0 → APPLIED to the trusted
base → promotion bundle written`. Probe verdict: `F4-BYPASS: OPEN`.

**The enforcement** (`apps/cli/src/candidate.ts`, §10 ladder): a candidate
whose record froze an intent snapshot and has **no registered task kinds —
none live, none frozen at isolation** — gets one objective duty prepended:

```
obligation [task-authority] UNPROVEN (objective): NO task-obligation
authority: ... Register the work (canary task "..." --kind ...) and
re-verify; omitting registration is not a way through §10, it is exactly
what makes §10 unprovable.
```

`NOT PROVEN → exit 2`, honest `'unproven'` bundle carrying the executed steps;
`isolate --promote` gate 1 re-verifies LIVE, rides the same refusal, and — as
throughout M8 — writes **zero promotion bundles** and leaves the base HEAD
byte-unchanged. No obligation is fabricated and no task is guessed: Canary
only refuses to claim completion it holds no authority to judge.

**No escape hatch exists:** no flag, no env var, no agent-writable metadata.
Pinned by contract test F4-F (`CANARY_NO_TASK_OK=1`,
`CANARY_SKIP_TASK_AUTHORITY=1`, `--no-task-ok` all inert) — and structurally:
the only state that opens the door is a `canary task` registration, which
requires the work to actually satisfy its derived duties.

**The trustworthy architectural distinction** kept intact: **pre-M10 records
(no `intent` field)** verify exactly as before — the committed compatibility
posture (S5 of the probe). The gate is bound to `rec.intent` precisely so the
one non-agent-controlled population (records made before §11 froze anything)
keeps its semantics; for every record written by the shipped CLI, an intent
snapshot is structurally present, and forging the pre-M10 shape means editing
the candidate record — which M9's fingerprint sandwich already catches.

**After the fix, same probe:** `after-f4-repro-closed.log` —
`verify-exit=2 bundle=["unproven","unproven"]`,
`promote-exit=2 promotion-bundles=[] base-moved=false applied=false`,
`F4-BYPASS: CLOSED`, and leg 2's positive control still lands: registered
bugfix + committed regression test → `CANDIDATE PASS` → `PROMOTED ... ACCEPTED`
(`M10-f4-repro: ALL PASS`). The probe is now a permanent
`verify:productization` step (item 14e).

## Compatibility discipline — every zero-task flow, inspected

Survey of all flows that intentionally ran taskless candidates, and the honest
disposition of each (registration text = what the candidate actually does):

| surface | taskless PASS flows found | disposition |
|---|---|---|
| `m10-f4-bypass-repro.mjs` leg 1 | 1 — the attack itself | STAYS taskless: now asserts NOT PROVEN + locked promotion (it IS the regression test) |
| `m10-obligations.mjs` S4a/S4a2/S8/S9/S11 | 5 recovery-PASS legs | registered `--kind refactor` before isolation — behavior-preserving work under a sealed `test` plan; obligations MET (tests-green via plan step, coverage-loss via resolvable diff, no deletions) |
| `m10-obligations.mjs` S1/S2/S3/S4b/S6/S10 | already register bugfix/refactor | unchanged |
| `m10-obligations.mjs` S5 (pre-M10 intent-stripped) | 1 | unchanged — the compatibility boundary itself |
| `m7-candidate-isolation.mjs` | 10 scenarios (PASS/ADVANCED/recovery legs) | blanket honest `refactor` registration in `makeRepo` |
| `m8-promotion.mjs` | 13 scenarios | blanket registration in `makeRepo` |
| `m9-authority.mjs` | `control` + `pregate` repos only | SURGICAL registration on exactly those two — the drift repos deliberately stay taskless and the `mode=task` drift asserts the task file is ABSENT before the window (registering there would break the probe's own premise) |
| `m2–m5`, `m6` probes, `cleanroom-*`, `lsfiles`, HTG probes | none (no `isolate` usage) | unaffected (verified by grep + full runs) |
| contract tests `m7/m8/m9.test.ts` | run under the fake-git ceiling; the ladder is unreachable there | unaffected; suite green |

Zero-task flows REMAIN taskless wherever the scenario is about the block, not
the pass; every registered scenario gained only duties it already satisfies.
No test expectation was edited to accept the old bypass; no failing test was
deleted; M5/M8/M9 gates untouched (their batteries re-killed 13/13+1 SKIP,
10/10, 15/15 below).

## Tests and mutation quality added

- Contract tests **F4-A…F4-G** (`apps/cli/test/m10-obligations.test.ts`, real
  git through the product CLI): A NOT-PROVEN-naming-authority; B promotion
  locked, zero promotion bundles, base unmoved; C registered+MET → PASS →
  ACCEPTED; D registered-wrong-duty (bugfix, no test) → NOT PROVEN on
  `regression-evidence`, authority gate silent; E violation while taskless →
  BLOCKED (unmet outranks the new unproven); F no knob (env/flag inert);
  G fail > unmet > unproven > pass with the gate in play.
- M10 probe **S12** (real git, full story incl. the registration-recovery leg).
- **Mutation 20** (`m10-mutation-battery.mjs`): replaces the gate condition
  with `if (false)` — removes the enforcement itself. Its kill is exactly one
  owning FAIL — `FAIL S12` — with the other 13 scenarios passing; removing
  the gate genuinely re-opens the bypass (battery: 20/20, restore
  byte-verified).

## Results — final build, every headline from an executed reporter

| step | result | platform | log |
|---|---|---|---|
| toolchain recovery (`npm install`, egress allowed) | 31/629 baseline failures → 629/629 after the `resolveNpmCli()` host fix | POSIX | `baseline-suite-d6757df.log`, `suite-post-npmfix.log` |
| clean build (`tsc -b --force`, then final rebuild) | PASS (exit 0) | POSIX | `r4-clean-build.log`, `final-build.log` |
| decision-file byte stability across the final rebuild | candidate.js/onboarding.js sha256 identical before/after | POSIX | `dist-sha-before.txt`/`-after.txt` |
| full suite (`npm test`) | **636/636** (629 + 7 new F4 tests) | POSIX | `final-suite.log` |
| obligations+intent probe | **14/14 ALL PASS** (13 pre-F4 + S12) | POSIX | `final-obligations-probe.log` |
| M10 mutation battery | **20/20 caught, 0 survivors**, restore byte-verified (re-run on final dist: mutation 20 killed by exactly one `FAIL S12`) | POSIX | `r3-m10-battery-20-of-20.log`, `m10-battery-final.log` |
| M7 battery | 13/13 caught + **1 honest SKIP** (win32 reserved-device mutation + its owning test — unrunnable off win32) | POSIX | `m7-battery.log` |
| M8 battery | 10/10 caught | POSIX | `m8-battery.log` |
| M9 battery | 15/15 caught | POSIX | `m9-battery.log` |
| F4 repro (before → after) | `F4-BYPASS: OPEN` → `F4-BYPASS: CLOSED`, positive control PASS→ACCEPTED both times | POSIX | `before-f4-repro-taskless-open.log`, `after-f4-repro-closed.log`, `f4-repro-final.log` |
| lying-index letters premise probe | PASS | POSIX | `lsfiles-final.log` |
| `npm run verify:productization` (26 steps, one command) | **PASS WITH HOST-BOUND SKIP — 25 PASS, 1 SKIP**, exit 0; headline explicitly says "NOT full 26/26 acceptance on this host". The new step `probe: M10.1 F4 taskless-bypass repro (real git)` is green. The one SKIP is the HTG corpus (exit 3), with both SKIP lines printed by the probe itself: L1 — resolved engine holdthegoblin@0.1.3 predates the classifier this corpus pins (skipped on these bytes, not failed); L2 — wrapper delegates to a host-bound CLI absent from this cage (Windows audit host needed) | POSIX | `verify-productization-final.log` |
| S11 POSIX fixture (R1) | 13/13 pre-fix + 19/19 battery with mutation 19 killed for the intended reason (`FAIL S11`, hook genuinely executed via chmod 0755) | POSIX | `r1-obligations-post-chmod.log`, `r1-m10-battery-post-chmod.log` |
| HTG corpus probe (R2) | explicit-SKIP semantics: classifier layer reproduced against host-labeled engine bytes (source+version+sha256 printed); wrapper-delegation layer SKIPs off the audit host; exit 3 = `PROBE-PASS-WITH-SKIP`, never a PASS count | POSIX cage | `r2-htg-probe-posix.log` |

Attempt-1 logs stay byte-identical in the evidence dir per the retention
contract: `before-f4-repro.log` (infra-broken first attempt) and
`before-f4-repro-attempt2.log` (leg-2 ENOENT) are kept untouched next to the
authoritative `before-f4-repro-taskless-open.log`; re-derivations carry their
own names (`r3-`/`r4-` prefixed intermediates vs the canonical finals).

## R5 — the corrected claim (replaces the unconditional M10 wording)

Canary at the candidate boundary now guarantees:

- **Canary will not claim task completion without task authority.** A
  candidate whose record holds an intent snapshot and zero registered task
  kinds (none now, none frozen at isolation) is `CANDIDATE NOT PROVEN`
  (exit 2, obligation `[task-authority]` named), **never PASS**.
- **Missing task registration is NOT PROVEN, not PASS; promotion remains
  locked** (live re-verify gate 1, zero promotion bundles, base unmoved).
- **Registered tasks use the normal obligation ladder** — fail > unmet >
  unproven > pass, kinds can only add duties, the sealed plan stays the floor
  no declaration lifts.
- **Pre-M10 intent-less records verify exactly as before** — the one
  trustworthy distinction, itself protected by M9's fingerprint sandwich.

Corrected in tracked wording: `tooling/verify-productization.mjs` item 14d
(+ new 14e), `apps/cli/src/main.ts` help (`canary task`,
`isolate --verify`), `apps/cli/src/candidate.ts` §10/§10.1 comments,
`m10-obligations.mjs` and `m10-obligations.test.ts` headers.
Commit `d6757df` is NOT amended; this document and the new commit carry the
correction.

## F1 / F2 status (handoff items 4–5)

- **F2 (lying index `--assume-unchanged`/`skip-worktree`):** closed AT
  `d6757df` (gate-2 fold into dirty; S8; battery mutation 16). This pass
  re-proved it: S8 green on final dist, m10 battery kill intact.
- **F1 (same-UID hollow-the-base + re-isolate):** stays **deferred to
  directive §16–§18** exactly as recorded at `d6757df` (source pointer, not
  fake-closed). M10.1 did not reopen it — out of the R1–R5 scope.

## Honest residuals

1. **Windows re-run pending for this pass.** All results above are POSIX
   (WSL2). The R1 chmod fix is POSIX-only *behavior* (Windows ignores the exec
   bit — S11 worked there before); S12/F4 logic is platform-neutral but the
   suite/probes/battery re-run on the Windows audit host is still owed, as is
   the HTG full 25/25-equivalent reproduction (see 3).
2. **m7 battery reserved-stem mutation**: 1 honest SKIP off win32 (owning
   test too) — reported, never folded into the pass count.
3. **HTG delivered-evidence reproduction**: on this cage the post-classifier
   HTG engine bytes do not exist (host carries pre-classifier 0.1.3, no live
   hooks), so the wrapper-delegation layer SKIPs with an explicit reason and
   the chain reports `PASS WITH HOST-BOUND SKIP` — a labeled partial
   reproduction, not full acceptance. Full reproduction requires the builder/
   audit host with the delivered engine.
4. **M9 containment is detection-at-edges** (unchanged doctrine): a same-UID
   hand can delete the quarantine marker manually; what is closed is automated
   laundering. Untouched authority still passes (S12's recovery leg shows the
   gate must not shout at innocence).
5. **No stale-proof invalidation** (deferred by directive); M11 untouched by
   design. The gate is per-window-live: re-verification reads the live record
   each time, which is what locks promotion.

## Scope discipline

No M11 design, no M15/M16, no general goal/proof graph, no candidate
architecture redesign, no HTG weakening, no M5/M8/M9 weakening, no trusted
base changes to force green, no deleted or reshaped tests, no remote, no
push, no touch to the real Windows repository. The `npm install` side-effects
(`resolveNpmCli` host fix) were pre-existing R-track work from this pass's
toolchain recovery and are reported above.
