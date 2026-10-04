# Additional Canary product work, 2026-10-04

## Implemented and targeted runtime checks passed

* Bare `canary` now includes the last recorded verification in its compact
  read-only status. It explicitly labels the result historical and leaves session
  end unknown. The current CONNECTED verdict still refers only to wiring.
  Missing or malformed history cannot become a successful verification.
  History values are bounded by the existing decoder and escaped for terminal
  output. Existing JSON envelopes and the bare-command exit code remain intact.
* `canary --version --verbose` identifies Node version, platform, architecture,
  runtime executable, actual CLI entry and the SHA-256 of that entry. Default
  version output remains one line. This is an entry-file hash, not a hash of
  every dependency in a development installation. SEA uses its actual executable
  as the entry. The error-report guidance and README expose this option.
* The existing read-only status probe accepts an explicit absolute installed CLI
  path, prints its hash and Node version, and rejects malformed options instead
  of silently choosing the development build.

Source commits: `6377235`, `a414917`, `858d2e3`, on
`codex/compact-verification-history`. These changes are not merged into
`codex/product-progress` yet.

## Observations so far

The Node 24.21.0 TypeScript no-emit check succeeded after both product changes.
`git diff --check` succeeded. Three malformed probe invocations were rejected
before starting any fixture or Canary process. These observations do not verify
the compact history runtime behavior by themselves.

A forced build of this isolated branch then succeeded. The two focused CLI
version tests passed with zero failures and zero skips: the original version and
bare-command contract, and the new detailed runtime/entry/hash report in both
command spellings. The latter verifies that project bytes remain untouched.
Only isolated version/bare CLI subprocesses ran; no project checks or supervisor
stress ran alongside the primary gate. Raw logs are
`compact-version-20261004-build.log` and
`compact-version-20261004-targeted.log` in the external evidence directory.

Direct read-only version calls also compare the old installed frozen package
with the new built CLI: both exit zero and report Canary 1.5.0, but the old package
prints only that line while the new build adds the observed runtime and entry
identity. Logs: `verbose-version-20261004-old-installed.log` and
`verbose-version-20261004-new-built.log`. This is not a newly installed artifact
check. The probe now normalizes explicit Windows paths before comparing identity,
so equivalent slash spellings do not create a false mismatch.

The primary post-pilot verification job continues independently on unchanged
product source `688654d`. Its standalone suite completed with 1349 pass, zero
fail and four explicit skips. Its required productization mutation stage has
reported all 13 master-pass mutations caught. The entire gate is still pending;
this is not an overall pass.

## Next execution, after the current gate terminates

1. Run the updated probe with the previous installed frozen package as explicit
   `--cli`; retain the expected missing-feature failures.
2. Build this branch and run the same probe and the targeted version test.
   Check unchanged exit codes, actual paths and hashes, historical-only labeling,
   malformed history, and no project writes or execution from read-only commands.
3. Integrate the reviewed commits and run the required complete suite followed by
   productization, sequentially. Freeze and install the resulting package only
   after observing the terminal results.

No higher product rating is established by code or static checks. The earlier
pilot's unnecessary block has been corrected separately, but its repair-loop
overhead and incomplete Refactron scope remain open evidence.

## Targeted comparison completed

After confirming the status probe confines project writes and check execution to
its own mkdtemp fixtures and reads an explicitly selected independent CLI, it ran
separately from the unchanged primary gate. The old installed frozen artifact
(`d41dc6606447b7f2d5cd4d18a1aa00dfe1191fd7b46683bdfd9963827ff294d9`)
reported three expected missing-feature failures: verbose version, compact
verification history, and absent/malformed historical record handling. The new
built CLI (`5222b8ec9ee89298715a080da684e5b5570a56fc8e426faba78005ee5aefba7a`)
reported `lazy-connect-status: ALL PASS`, exit zero. Both used Node 24.21.0.

The same probe verifies unchanged bare exit code, read-only tree manifests,
no execution of sentinel checks by status/history, explicit help, corrupted and
tracked configuration distrust, sealed-script drift, removed hooks, terminal
injection handling, missing history, and unattended failing-check behavior.
Raw logs: `compact-status-20261004-old-installed.log` and
`compact-status-20261004-new-built.log` in the external evidence directory.

The build and targeted comparisons are complete. Integration, the required
full sequential gates, and verification of a newly installed artifact remain.
The primary gate has additionally reported architecture closure 39 pass / zero
fail / zero skip, and architecture mutations 13/13 caught with zero failures;
its overall terminal result is still pending.
