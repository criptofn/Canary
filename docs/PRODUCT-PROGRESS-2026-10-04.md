# Product work after the native pilot — 2026-10-04

This batch improves Canary itself. The external projects remain validation fixtures.
It does not establish an 8/10 rating or close the Windows native-process findings.

## User-visible changes

| Problem | Delivered behavior | Compatibility and limits |
| --- | --- | --- |
| Operators must find executable directories to authorize needed tools | `canary setup --yes --toolchain java --toolchain python` resolves explicitly requested tools and seals their external directories | Missing tools and project-local PATH shadows refuse the complete operation. Existing directory flags remain supported. Authorization covers the directory, not just one binary. |
| A bare CLI invocation presents the expert command menu before answering project state | `canary` shows compact connection status, measured protection level, and links to `result` and `--help` | Read-only; no project checks run. Existing no-command exit code 3 remains. |
| Human output hides the proof scope already available in JSON | `doctor` shows registered requirement count and met/unproven/unmet duty counts; `result` shows historical scope and evidence caveats | Existing statuses and JSON envelopes remain. Zero registered criteria and absent legacy records are explicit. Historical evidence never decides the current verdict. |

## Executed focused checks

Evidence root: `C:/Users/Johannes/Desktop/canary/_canary-data/evidence`.

- Named toolchain setup: old behavior fails the new regression; final focused file reports 29/29 passing (`named-toolchain-20261003-green-final.log`). The LTS focused run reports 5/5 passing (`named-toolchain-lts-focused-20261004.log`).
- Compact entry: old behavior fails the regression. The first implementation also failed because verbose plan output still preceded status; the implementation was corrected. `compact-entry-20261004-green-final.log` reports `lazy-connect-status: ALL PASS`, including byte-preserving read-only behavior and explicit help.
- Human proof scope: both new cases fail before the change (`human-proof-scope-20261004-red.log`); the complete protocol file then reports 7/7 passing, zero skips (`human-proof-scope-20261004-green.log`). Controls cover open duties, agent-test caveats, legacy records, and historical-only display.

## Broad gates and pilot

The earlier named-toolchain source `ba3c0f68efec16776557b908af7238e0ebf4ea96`
completed standalone `npm test` on isolated Node 24.21.0: 1347 tests,
1343 passed, 4 skipped, zero failed. Its productization gate was still running
when this report was written. This is not a completed gate for the later compact
entry and human-output changes.

The queued pilot for that earlier source was cancelled while waiting, with no
commands or model sessions started, to use the complete product batch instead.
The complete batch still requires sequential full tests and productization,
followed by the installed controls and frozen twelve-session pilot.

The first complete-batch unit run on `7e2f421` reported 1349 tests: 1344 passed,
four skipped, one failed. The existing CLI contract requires a `usage:` line
when no command is given. The compact entry now retains a short usage line
after the state answer. The unchanged contract test passes, and
`compact-entry-usage-20261004-lazy-green.log` again reports all read-only entry
checks passing. Productization and model sessions did not run after the failed
unit gate; its evidence remains in `product-batch-final-20261004-job`.

Node 26's previous gate failures remain recorded. Running on LTS does not prove
their cause or close them. Native owner crashes now fail the mutation battery
instead of being counted as successful catches; failed provenance runs preserve
their real artifacts for diagnosis. Those are measurement fixes, separate from
the product changes above.

The older native pilot remains the only completed native comparison: Canary
4/6 correct normal completions versus plain 3/6, with 2.30 times the tokens and
1.86 times the elapsed time. The new batch has no measured replacement result
yet. A higher rating requires the new comparison, not merely more passing tests.
