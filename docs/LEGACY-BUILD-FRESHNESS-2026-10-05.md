# Legacy build freshness correction

## Confirmed product defect

A v1.5 seal can order tests before build. The existing upgrade control exercised
only correct source and therefore missed a stale-artifact false READY: after
changing source to a broken implementation, the old artifact passed its tests,
then the build wrote the broken implementation, and doctor still returned zero.
`legacy-build-freshness-20261004-red` preserves the observed zero-versus-two
failure and 110 hashed raw files. The tested improved CLI was the previously
installed frozen product, entry hash `d41dc6606447b7f2d5cd4d18a1aa00dfe1191fd7b46683bdfd9963827ff294d9`.

## Product change

`planWithFreshTests` preserves the original sealed sequence and then repeats
only test-kind steps that precede the final build. Setup, doctor, Stop, candidate
verification, baseline comparisons and input controls use the same scheduler.
Focused single-check doctor remains PARTIAL and does not run a full plan.

No plan or starting state is resealed. Every repeated command is already in the
sealed plan. Initial failures remain failures; a later passing test cannot waive
them, and passing tests cannot waive a failed build. Current build-before-test
plans receive no extra execution. Legacy plans incur extra test executions and
may still need a second repair check when their initial test failed on an old
artifact; operators can review and reseal a build-before-test plan with setup.

Public statuses, exit codes and field names remain. Observed `checks` and evidence
steps include the additional executions on affected plans; consumers must not
assume one observed execution per sealed entry. Sealed configuration bytes stay
unchanged. Both earlier and later outcomes remain available in the evidence.

## Targeted evidence, not full gate completion

* Two focused tests pass: the pure scheduler and existing modern build-dependent
  setup/completion controls. Log `legacy-build-freshness-20261005-focused.log`.
* A portable declared-plan regression passes across setup, doctor and Stop,
  including config byte equality. Against the old installed CLI it fails because
  the additional freshness execution is missing. The separate red comparison
  above directly establishes the false READY. Logs end in `portable-{red,green}.log`.
* The first installed candidate passed ten doctor/order cases. An added actual
  Stop case exposed a result-index mapping error; its failed capture is retained
  in `legacy-build-freshness-20261005-green-stop`. The doctor and Stop mappings
  now refer to the expanded execution plan.
* Final installed candidate: source `4cb85ca`, package SHA-256
  `33b915496d51b1a52acd9f85e227188301cc20f1df8ba8bc91bfff3d675c2af3`,
  entry SHA-256 `6bfc65020a49e0c2f24c2b8bd9f6e80d0b65d4842af2791ca517797c30412d08`.
  `legacy-build-freshness-20261005-green-final` reports **11 installed-product
  observations passed, legacy seal unchanged**, with 184 hashed raw files.
  It covers stale broken source at doctor and Stop, initial-failure retention,
  a subsequent fully passing repair, failed builds and modern first-run success.

Evidence is under `C:/Users/Johannes/Desktop/canary/_canary-data/evidence`.
Source commits: `6282c59`, `04e6732`, `4cb85ca`, `7989419` on
`codex/legacy-build-freshness`. The scheduler and result mapping have been
integrated into `codex/product-progress`; full sequential gates remain pending.
The candidate package is a targeted-test artifact, not a
release or a completed productization claim. The interrupted older gate remains
separate; passing earlier gates did not cover this newly established defect.

## Baseline proof attribution

A second confirmed defect concerned evidence attribution: a baseline with
correct source but a stale broken artifact failed its first test, recovered
after build, and was still credited as a source failure. An unrelated source
edit therefore appeared to have discriminating evidence. The real Git regression
in `discrimination-completion.test.ts` failed with `false` instead of `null`
before the correction (`legacy-build-freshness-20261005-baseline-red.log`).

Baseline comparison now returns unknown when every failure came from a pre-build
test that passed after the baseline build. Both executions remain in the raw
evidence. This does not waive any failed check in setup, doctor or Stop. A
baseline failure that persists after build still provides discrimination; the
same regression tests that countercase. The corrected targeted test passes
(`legacy-build-freshness-20261005-baseline-green.log`, one pass, zero failures).
The candidate package above predates this additional correction.

## Combined gates and installed delivery

The clean integrated source `7ecf465d2f8661ef0cbaf6f4eaa5ef642291b2ef`
completed the required sequential gate job
`legacy-build-freshness-20261005-gates-job`. Standalone `npm test` reports
1357 tests, **1353 pass, zero fail, four explicit skips**. Productization ended
at `2026-10-04T23:43:04.764Z` with process status zero, no signal and no execution
error: **104 PASS, 6 explicit SKIP** (four host-bound; two live cost-gated and
not run; two host-bound steps executed zero checks). Architecture closure
reports 39 pass / zero fail / zero skip, and both mutation batteries caught
all 13 mutations. A skipped check is not a pass.

After the job ended, the existing freeze helper verified clean source and dist,
packed and installed the product in an isolated directory. Delivery evidence:
`legacy-build-freshness-20261005-frozen`.

* Archive: `package/final.tgz`, SHA-256
  `497650e8170a7cac242648aec2b7dee48cf9fee4a2bdabda8b54466bd4a6d65a`.
* Installed entry: `package/installed/node_modules/@canary-rn/cli/dist/main.js`,
  SHA-256 `10c482d22ac12c6c951b859d1dedf628c932be1251ebf21488a61528f1237805`.
* Version remains `canary 1.5.0`; this is an unreleased improvement artifact,
  identified by source and hashes, not the published v1.5.0 archive.
* Against the retained published release entry (`3cfdfece...d5e2`),
  `installed-comparison` passes all eleven observations, preserves seal bytes,
  and hashes 184 raw files. It covers stale broken artifacts at doctor and Stop,
  initial failure retention, subsequent repair, build failures and modern plans.
* Explicit installed-CLI status probe: ALL PASS. Provenance probe: seven pass,
  zero fail. Each receipt binds executed CLI path, entry hash and probe hash.

The baseline attribution correction has its targeted real-Git regression and
countercase in the completed full suite; the eleven-case installed comparison
does not independently exercise that new baseline-attribution case. These gates
and installed controls establish delivery of the corrections, not native agent
benefit or an 8/10 rating. The replacement native comparison and missing
Refactron prerequisite remain open. No merge or release was performed.
