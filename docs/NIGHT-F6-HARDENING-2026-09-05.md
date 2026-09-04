# Unattended Night Run — F6 Hardening — 2026-09-05 (attempt 1)

- **Worktree:** `C:\Users\Johannes\Desktop\canary-observation-hardening`, branch `post-glm-observation-hardening`
- **Starting SHA:** `34cf515b50ebab3eb68cb10859eef3a67e0e57f3`
- **Final HEAD:** this report's commit (exact SHA recorded in
  `.night-run/DONE` and in `git log`)
- **Builder role:** Qwen builder, unattended. No other LLM/model provider was
  invoked. No subagents, workflows, or swarms. **Nothing was pushed.**
- **Evidence location:** every RED/GREEN/mutant/probe log lives under
  `.night-run/` (git-ignored; paths cited below are relative to the worktree root).

## Scope discipline (explicit)

- **F1–F5 were NOT reopened.** No redesign, no touching DreamForge,
  Homeostasis, the GLM audit cage, or unrelated architecture.
- F6d (createdAt/freshness), F6g (64 MiB stream truncation), F6h
  (conditional-skip/CI) were **declared out of scope for this run** and were
  not attempted (see "Remaining F6 items").
- No existing test or gate was weakened. No expected result was changed
  except where a mechanical probe proved the old expectation stale (none
  required — every fix added pins rather than editing verdicts).
  No security check was disabled at any point.

## Findings, revalidation, and repairs

Every item: mechanical re-validation against current HEAD first; smallest
regression test, RED proven, smallest production fix, GREEN proven, relevant
package suites run; one commit per independent repair.

### F6c — prototype-named unknown fields bypassed `in` (REAL → FIXED, `4e69572`)

- **Revalidation:** mechanically reproduced at start SHA — an unknown field
  named e.g. `constructor` passed the `for (k in obj)`-style unknown-field
  refusal because `in` sees prototype properties.
- **RED:** `.night-run/f6c-red.log` — schema suite 37 tests, 1 fail (AssertionError).
- **GREEN:** `.night-run/f6c-green.log` — 37/37.
- **Fix:** `Object.hasOwn` own-property check in the unknown-field refusal.
- **Files:** `packages/evidence/schema/src/contract.ts`, `packages/evidence/schema/test/schema.test.ts`.

### F6f — absent `proofHost` granted host-exact trust (REAL → FIXED, `a060e8a`)

- **Revalidation:** reproduced — with no `proofHost` committed, host-exact
  checks silently counted as satisfied.
- **Fix semantics:** onProofHost may only come from a committed proofHost
  fingerprint (`fpEq`); absent proofHost ⇒ host-exact checks are **skipped**
  (skip reason embedded in the check `name` as `[SKIPPED: …]`) and the proof
  verdict becomes INCOMPLETE (exit 2). Nothing was granted.
- **RED:** `.night-run/f6f-red.log` (29/1 fail). **GREEN:**
  `.night-run/f6f-green.log` (83/83) and full apps/cli
  `.night-run/f6f-package-cli.log` (174/174).
- **Files:** `apps/cli/src/prove.ts` + 4 test files (`prove.test.ts`,
  `cli.test.ts`, `pipeline-e2e.test.ts`, `provenance.test.ts`).

### F6e — controlled empty npmrc existed only at one use point (REAL → FIXED, `cbd8dc4`)

- **Revalidation:** reproduced — the controlled empty userconfig was written
  by the pipeline but the executor's `$npm` injection path could run with no
  guarantee it still exists; npm behavior itself was NOT broadened.
- **Fix:** re-establish the controlled empty userconfig file at every point
  of use (pipeline site already existed; executor `$npm` injection site added).
- **RED:** `.night-run/f6e-red.log` (65/1 fail). **GREEN:**
  `.night-run/f6e-green.log` (79/79), support package
  `.night-run/f6e-package.log` (12/12).
- **Files:** `apps/cli/src/pipeline.ts`, `packages/runner/executor/src/index.ts`,
  `packages/runner/executor/test/executor.test.ts`.

### F6a — runner-root symlink/junction: anchor claim was lexical (REAL → FIXED, `684e27f`)

- **Revalidation:** re-confirmed FIRST with a mechanical probe at current
  HEAD (`.night-run/f6a-probe.mjs`, unique fresh scratch under the OS tmp
  dir): with a dir-symlink or an unprivileged **junction** at
  `node_modules/mocha` — or a junction at `node_modules` itself — pinned
  bytes living OUTSIDE the fixture passed `located.dir === canonical`
  (lexical `path.resolve`) and earned `--require` observer injection.
  Windows junctions are creatable unprivileged on this host (probe-proven).
- **Fix (minimal, at the single decision site):** `isPhysicalAnchor()` —
  both fixture and located dir must resolve through **every** link
  (`fs.realpathSync`) to the fixture-relative `node_modules/mocha` anchor;
  any resolution failure ⇒ not injectable (fail-closed, same posture as
  `locateRunnerPackage`). `prove` re-derives through the same call, so one
  fix covers both sites. Rejected alternatives: lstat-only at `locate`
  (misses the ancestor-link case), per-component checks (broader).
- **RED:** `.night-run/f6a-red.log` — executor 67 tests, 2 fail
  (AssertionError: injection granted through link/junction).
- **GREEN:** `.night-run/f6a-green.log` 67/67 (legit copy-staged double
  through the Windows tmpdir still injects — positive paths intact);
  apps/cli `.night-run/f6a-package-cli.log` 174/174.
- **Live docs corrected:** `docs/EXECUTION-AUTHORITY.md` §3 now states a
  hash match alone never earns injection — the package must occupy the
  anchor PHYSICALLY.
- **Files:** `packages/runner/executor/src/index.ts`,
  `packages/runner/executor/test/executor.test.ts`, `docs/EXECUTION-AUTHORITY.md`.

### F6b — exit -1 VALID observation semantics (RE-VALIDATED: accurate but benign → pinned, `e882d9f`)

- **Revalidation finding:** the historical description was true but the
  behavior is **deliberate and fail-closed-contained**:
  - capture (`observation.ts` exit-consistency) EXEMPTS exit -1 by design —
    a kill's exit code claims nothing about tests, and the observation must
    record what was actually watched (complete stream + -1 stays VALID);
  - the classification gate clauses (`failing==0⇒exit≠0`,
    `failing>0⇒exit==0`) and the schema mirror
    (`packages/evidence/schema/src/index.ts:613`) are structurally blind to
    -1-with-failures — identical in both, no drift;
  - the SOLE absolute veto is `infraCause`'s unconditional
    `if (r.exitCode === -1) return 'killed or signal death'` (classification
    `index.ts:205`), which survives `attestedView`, fires before any gated
    rule, and routes such rounds to INFRASTRUCTURE_FAILURE via rule 1.
- **Verdict semantics were NOT changed** (per brief: containment already
  holds; the smallest correction the contract justifies is test + comment).
- **Repairs:** false comment ("exit==-1 never gets a VALID status past
  capture") replaced with the truthful contract in
  `packages/core/classification/src/index.ts` and
  `packages/runner/executor/src/observation.ts` (both diffs are
  comment-only — verified). Two pinning tests:
  - layer-1 (`apps/cli/test/attested-channel.test.ts`): VALID stream + exit
    -1 ⇒ capture honors it (`status === 'VALID'`);
  - layer-2 (`packages/core/classification/test/classify.test.ts`): gate
    returns null on that round (blind BY CONTRACT) yet classification is
    INFRASTRUCTURE_FAILURE rule 1 via the killed veto.
- **Mutant proof:** deleting the veto clause makes the new F6b test fail
  (plus two pre-existing F4 tests that lean on it):
  `.night-run/f6b-mutant.log` 87 tests / 3 fail. Clause restored
  byte-exactly; reconfirmed green.
- **GREEN:** `.night-run/f6b-green-classify.log` 87/87;
  `.night-run/f6b-green-channel.log` 20/20.
- **Files:** the 4 files above (2 comment, 2 test).

## Final qualification

- **Complete repository suite (once, at final HEAD before this doc):**
  `npm test` (build + typecheck + all node:test) — **472 tests / 71
  suites / 472 pass / 0 fail / 0 cancelled / 0 skipped**, exit 0.
  Log: `.night-run/final-full-suite.log`. (Pre-branch baseline was
  438/64; the delta is this branch's added pins, nothing removed.)
- **Golden proof:** run on the canonical pinned toolchain
  (`~/.canary-pinned-host/node-v26.3.0-win-x64`, Node **v26.3.0** /
  npm **11.16.0**, PATH-prefixed so child processes resolve pinned — no
  global config changed): `npm run prove` on
  `fixtures/axios-0.27-to-1.0/specs/axios-mock-adapter.json` →
  **PASS — 37 assertions held (all of them, host-exact included, ON the
  proof host)**, exit 0. Log: `.night-run/final-prove-pinned-host.log`.
  The dev host itself runs Node 26.7.0 (drift) — recorded honestly; on it
  the F6f semantics would legitimately yield the off-proof-host skip posture,
  which is the designed fail-closed behavior, not a defect.
- **Commits (five, one per independent repair):**

  | SHA | Finding |
  |---|---|
  | `4e69572` | F6c prototype-named unknown fields |
  | `a060e8a` | F6f absent proofHost never grants host-exact |
  | `cbd8dc4` | F6e controlled empty npmrc at every use point |
  | `684e27f` | F6a physical anchor (symlink/junction bypass closed) |
  | `e882d9f` | F6b killed-round containment pinned (semantics unchanged) |

- **Beads:** children 88x.1–88x.6 all closed with evidence; epic 88x closed
  at run end.
- **Final `git status`:** clean (untracked `.holdthegoblin/` is hook-local
  state, left as-is).

## Skipped / unresolved, and remaining F6 items

- **Skipped by explicit brief (NOT deferred silently):**
  - **F6d** — createdAt/freshness redesign: out of scope tonight.
  - **F6g** — 64 MiB stream truncation redesign: out of scope tonight.
  - **F6h** — conditional-skip/CI redesign: out of scope tonight.
- **Documented residual (unchanged, pre-existing):** the observer trust tier
  still has no cryptographic provenance root; code inside the injected
  genuine process can neutralize hooks / emulate the protocol or run
  trivially-real tests under renamed titles (residuals 8a/8a′/F3, already
  documented in `docs/EXECUTION-AUTHORITY.md`). F6a removed one concrete
  way to obtain injection; it does not change this residual.

## Statement

All five prioritized F6 items were revalidated against current HEAD,
repaired (or correctly closed as already-contained) with RED→GREEN evidence,
each in its own commit. F1–F5 were not reopened. The full repository suite
and the golden proof on the pinned canonical host pass at final HEAD.
