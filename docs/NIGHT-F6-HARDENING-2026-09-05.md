# Unattended Night Run — F6 Hardening — 2026-09-05 (attempt 1)

- **Worktree:** `C:\Users\Johannes\Desktop\canary-observation-hardening`, branch `post-glm-observation-hardening`
- **Starting SHA:** `34cf515b50ebab3eb68cb10859eef3a67e0e57f3`
- **Final HEAD (attempt 1):** `d327e71c1e68fb4e292f2c2c26268693580bef3e`
  (same value as the exported run-record
  `docs/night-evidence/2026-09-05-F6/DONE`)
- **Builder role:** Qwen builder, unattended. No other LLM/model provider was
  invoked. No subagents, workflows, or swarms. **Nothing was pushed.**
- **Evidence location (corrected post-audit):** every RED/GREEN/mutant/probe
  log cited below is tracked at `docs/night-evidence/2026-09-05-F6/`.
  Attempt 1 wrote them to `.night-run/` — per-worktree scratch that another
  worktree or clone never sees; see the Errata section and the retention
  contract in `docs/night-evidence/README.md`.

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
- **RED:** `docs/night-evidence/2026-09-05-F6/f6c-red.log` — schema suite 37 tests, 1 fail (AssertionError).
- **GREEN:** `docs/night-evidence/2026-09-05-F6/f6c-green.log` — 37/37.
- **Fix:** `Object.hasOwn` own-property check in the unknown-field refusal.
- **Files:** `packages/evidence/schema/src/contract.ts`, `packages/evidence/schema/test/schema.test.ts`.

### F6f — absent `proofHost` granted host-exact trust (REAL → FIXED, `a060e8a`)

- **Revalidation:** reproduced — with no `proofHost` committed, host-exact
  checks silently counted as satisfied.
- **Fix semantics:** onProofHost may only come from a committed proofHost
  fingerprint (`fpEq`); absent proofHost ⇒ host-exact checks are **skipped**
  (skip reason embedded in the check `name` as `[SKIPPED: …]`) and the proof
  verdict becomes INCOMPLETE (exit 2). Nothing was granted.
- **RED:** `docs/night-evidence/2026-09-05-F6/f6f-red.log` (29/1 fail). **GREEN:**
  `docs/night-evidence/2026-09-05-F6/f6f-green.log` (83/83) and full apps/cli
  `docs/night-evidence/2026-09-05-F6/f6f-package-cli.log` (174/174).
- **Files:** `apps/cli/src/prove.ts` + 4 test files (`prove.test.ts`,
  `cli.test.ts`, `pipeline-e2e.test.ts`, `provenance.test.ts`).

### F6e — controlled empty npmrc existed only at one use point (REAL → FIXED, `cbd8dc4`)

- **Revalidation:** reproduced — the controlled empty userconfig was written
  by the pipeline but the executor's `$npm` injection path could run with no
  guarantee it still exists; npm behavior itself was NOT broadened.
- **Fix:** re-establish the controlled empty userconfig file at every point
  of use (pipeline site already existed; executor `$npm` injection site added).
- **RED:** `docs/night-evidence/2026-09-05-F6/f6e-red.log` (65/1 fail). **GREEN:**
  `docs/night-evidence/2026-09-05-F6/f6e-green.log` (79/79), support package
  `docs/night-evidence/2026-09-05-F6/f6e-package.log` (12/12).
- **Files:** `apps/cli/src/pipeline.ts`, `packages/runner/executor/src/index.ts`,
  `packages/runner/executor/test/executor.test.ts`.

### F6a — runner-root symlink/junction: anchor claim was lexical (REAL → FIXED, `684e27f`)

- **Revalidation:** re-confirmed FIRST with a mechanical probe at current
  HEAD (`docs/night-evidence/2026-09-05-F6/f6a-probe.mjs`, unique fresh scratch under the OS tmp
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
- **RED:** `docs/night-evidence/2026-09-05-F6/f6a-red.log` — executor 67 tests, 2 fail
  (AssertionError: injection granted through link/junction).
- **GREEN:** `docs/night-evidence/2026-09-05-F6/f6a-green.log` 67/67 (legit copy-staged double
  through the Windows tmpdir still injects — positive paths intact);
  apps/cli `docs/night-evidence/2026-09-05-F6/f6a-package-cli.log` 174/174.
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
  `docs/night-evidence/2026-09-05-F6/f6b-mutant.log` 87 tests / 3 fail. Clause restored
  byte-exactly; reconfirmed green.
- **GREEN:** `docs/night-evidence/2026-09-05-F6/f6b-green-classify.log` 87/87;
  `docs/night-evidence/2026-09-05-F6/f6b-green-channel.log` 20/20.
- **Files:** the 4 files above (2 comment, 2 test).

## Final qualification

- **Complete repository suite (once, at final HEAD before this doc):**
  `npm test` (build + typecheck + all node:test) — **472 tests / 71
  suites / 472 pass / 0 fail / 0 cancelled / 0 skipped**, exit 0.
  Log: `docs/night-evidence/2026-09-05-F6/final-full-suite.log` (independently
  re-run post-audit with identical numbers: `reverify-head-suite.log`, and a
  TREE-pinned re-derivation in a clean detached worktree at `d327e71`:
  `reverify-head-d327e71-treepinned-suite.log`).
  Pre-branch baseline at `34cf515` is **465 tests / 71 suites** — re-derived
  in a clean detached worktree (`reverify-baseline-34cf515-suite.log`) and
  cross-checked against 34cf515's own commit message ("Full suite 465/465
  pass."). The delta is +7 tests from this branch's added pins; the suite
  count is 71 before and after, and no tests were removed. (Attempt 1 cited
  438/64 here — stale-copied from the Sept-2 index at a different HEAD;
  see Errata.)
- **Golden proof:** run on the canonical pinned toolchain
  (`~/.canary-pinned-host/node-v26.3.0-win-x64`, Node **v26.3.0** /
  npm **11.16.0**, PATH-prefixed so child processes resolve pinned — no
  global config changed): `npm run prove` on
  `fixtures/axios-0.27-to-1.0/specs/axios-mock-adapter.json` →
  **PASS — 37 assertions held (all of them, host-exact included, ON the
  proof host)**, exit 0. Log: `docs/night-evidence/2026-09-05-F6/final-prove-pinned-host.log`.
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

- **Beads:** children 88x.1–88x.5 all closed with evidence; epic 88x closed
  at run end. (Attempt 1 wrote "88x.1–88x.6"; the tracker contains exactly
  five children — `bd show 88x` — and no 88x.6 ever existed. Count typo,
  corrected here; note the beads store lives in the main repo's
  `.beads/embeddeddolt`, which is not part of this tracked worktree.)
- **Final `git status` (corrected):** no modifications to tracked files,
  **but not "clean" in any audit-useful sense** — attempt 1 left the
  `.night-run/` evidence files (26 in the scratch dir) untracked and
  unexported, and their ignore
  lived only in the builder's local `.git/info/exclude`, so a "clean"
  `git status` coexisted with evidence no other worktree could see. That
  is exactly the failure the Errata section and
  `docs/night-evidence/README.md` address. (Untracked `.holdthegoblin/` is
  hook-local state — machine-local event/audit logs that a `git add -A`
  would have swept into the evidence commit; now covered by a committed
  `.gitignore` entry alongside `.night-run/`, same precedent, same reason.)

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

## Errata & post-audit corrections (2026-09-05 independent re-audit)

The independent GLM re-audit (auditor HEAD `d327e71`) confirmed all five F6
fixes real and correct and ordered **no change to them** — this run changed
zero production code. What was wrong was this report's EVIDENCE LAYER. Four
claims were false; each correction below re-derives its number from an
explicit reproducible command (full command list, including the disclosed
cwd mis-run of the first baseline attempt, in
`docs/night-evidence/2026-09-05-F6/reverify-commands.txt`; counting
convention now codified in `docs/TEST-COUNTING.md`).

1. **"`.night-run/` (git-ignored)" was misleading.** The ignore lived only
   in the builder's local `.git/info/exclude` — never committed, never
   visible from another worktree or clone. The evidence therefore existed
   ONLY in this worktree while the report cited it as if recoverable. Fix:
   all 20 attempt-1 files exported to tracked
   `docs/night-evidence/2026-09-05-F6/`; a real committed `.gitignore`
   entry added (verify: `git check-ignore -v .night-run` →
   `.gitignore:33`); retention contract in
   `docs/night-evidence/README.md`. The evidence was NOT ignored away —
   ignore-only would have destroyed it, which the brief correctly forbade.
2. **"Final `git status`: clean" overstated.** Tracked files were
   unmodified, but 26 untracked files in `.night-run/` made "clean"
   audit-meaningless (the section above is corrected in place).
3. **"Pre-branch baseline was 438/64" was wrong.** 438/64 came from the
   Sept-2 `evidence-index.txt` at HEAD `b3a5069` (archived here as
   `sept2-evidence-index.txt`) — stale-copied into this report. True baseline, re-derived in a clean detached worktree at
   `34cf515` (`reverify-baseline-34cf515-suite.log`, self-proving `TREE:`
   line): **465 tests / 71 suites / 465 pass / 0 fail / 0 skipped**,
   cross-checked against `git show -s --format=%B 34cf515` ("Full suite
   465/465 pass.").
4. **"64 -> 71 suites" was wrong; the delta is in TESTS.** Suites were 71
   at `34cf515` and 71 at `d327e71` (unchanged). The F6 branch added +7
   tests: 465 → 472. The 472/71 final figure itself was independently
   re-confirmed (`reverify-head-suite.log`, identical summary block; and
   `reverify-head-d327e71-treepinned-suite.log`, which additionally
   self-proves its tree with a `TREE:` first line — the earlier head re-run
   had no TREE pin, an overclaim since corrected in `reverify-commands.txt`).

Post-audit additions (this correction commit): the four corrections above;
`docs/TEST-COUNTING.md`; residual-risk documentation in `docs/SECURITY.md`
(F6e TOCTOU **narrowed, not closed**) and `docs/EXECUTION-AUTHORITY.md`
(F6e + F6a skip caveat); and an F6a coverage sentinel test in
`packages/runner/executor/test/executor.test.ts` so a link-denying platform
can no longer look green while silently not exercising the link-escape
regression — FAIL under `CI`, loud warn + visible skipped entry off-CI
(proof: `reverify-f6a-skip-probe.log`, `reverify-f6a-ci-sentinel-fail.log`;
the corrections pass itself was adversarially verified by a 20-agent
find-then-refute workflow — full result exported as
`postaudit-verification-workflow.json`, provenance in
`reverify-commands.txt` section 5; the beads-range and `.holdthegoblin/`
ignore fixes in this pass came out of that verification; hook-autonomy
proof matrix exported as `hook-policy-test.mjs`/`.log`, ALL-CASES-PASS);
post-change full suite **473/71/473 pass/0 fail/0 skipped**, EXIT:0,
`reverify-postchange-suite.log`). A platform that cannot exercise the
guard is now distinguishable from one that passed it.

## Statement

All five prioritized F6 items were revalidated against current HEAD,
repaired (or correctly closed as already-contained) with RED→GREEN evidence,
each in its own commit. F1–F5 were not reopened. The full repository suite
and the golden proof on the pinned canonical host pass at final HEAD.
