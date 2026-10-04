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
`codex/legacy-build-freshness`. These changes await integration and full
sequential gates. The candidate package is a targeted-test artifact, not a
release or a completed productization claim. The interrupted older gate remains
separate; passing earlier gates did not cover this newly established defect.
