# Additional Canary product work, 2026-10-04

## Implemented; compact history awaits runtime verification

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
the compact history runtime behavior.

A forced build of this isolated branch then succeeded. The two focused CLI
version tests passed with zero failures and zero skips: the original version and
bare-command contract, and the new detailed runtime/entry/hash report in both
command spellings. The latter verifies that project bytes remain untouched.
Only isolated version/bare CLI subprocesses ran; no project checks or supervisor
stress ran alongside the primary gate. Raw logs are
`compact-version-20261004-build.log` and
`compact-version-20261004-targeted.log` in the external evidence directory.

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
