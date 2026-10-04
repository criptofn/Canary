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
The complete batch at `457e65ba839d1f62e481409f3f0dbc6f79771604` subsequently
completed both required gates on isolated Node 24.21.0, sequentially:
standalone unit reporter **1349 tests, 1345 passed, 4 skipped, 0 failed**;
productization **104 PASS, 6 explicit SKIP** (four host-bound and two live
cost-gated). A skip remains unproven. Both terminal captures report status 0,
null signal and null error in `product-batch-final-20261004-usage-job/capture`.

That source was frozen once. Package SHA-256:
`f15ac46ac9f2ef03a2b4017ad0c66bb37e1beb4dd1df6b4bdbff2489390b5036`;
installed CLI SHA-256:
`aa263badc5778c8c88716da04056d2c8f00c1231bd2a74188a6c61a77ea377c4`.
The installed comparison and regression subset passed. No model session has
started for this artifact. Subsequent measurement fixes did not rebuild it.

The six-task controls have not completed. The unchanged Refactron baseline
(`1fe40d8505bbb0cac703c976401c17213abf1e9d`) fails regular project tests before
any agent work, with varying coverage assertions and Vite sourcemap failures.
Node 24 and Node 26 both exhibited failures. A temporary logging diagnostic
passed but did not establish a cause; its source was restored byte-exact.
The restored countercheck again failed. No external project fix, test exclusion
or baseline substitution is included in Canary's product progress.

Raw captures remain in `product-batch-controls-20261004-envelope-job`,
`product-batch-controls-20261004-baseline-recheck-job`,
`refactron-baseline-path-20261004-job`, `refactron-baseline-node26-20261004-job`,
`refactron-coverage-origin-20261004-job` and
`refactron-restored-baseline-20261004-job`. The two matrix attempts have
byte-verified incomplete archives. These failures do not prove a Canary defect.

Measurement corrections now parse the top-level validation envelope, refuse
bad actual baseline receipts before any model/server initialization, only mark
preparation complete after checks pass, and normalize Windows PATH key casing.
These are instrumentation changes, not user-facing product features.

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

## Next product correction: process failure diagnosis

`runPlanStep` discarded supervisor errors. Its null exit code was then attributed
to missing tools, recommending installation even for an interrupted check.
The shared runner now retains supervisor diagnostics in the existing stderr
evidence and keeps trusted failure facts in memory for attribution. `doctor`
and failed completion reports identify `CHECK PROCESS FAILURE`, keep the cause
unknown and direct the operator to inspect the command/output and resolve the
process error or time limit. Printed project prose cannot supply those facts.
A capture error with a zero exit code also cannot become a passing check.
CLI statuses, exit-code contracts and serialized field names remain unchanged.

The targeted regression failed before the correction
(`check-process-diagnosis-20261004-red.log`). The complete affected test file
then reports **30 passed, zero failed or skipped** with a canonical Node 24
caller PATH (`check-process-diagnosis-20261004-canonical-green.log`). An earlier
run with a mismatched caller PATH had two inventory-premise failures and is
retained in `check-process-diagnosis-20261004-green.log`; it is not a passing run.
Tests use the existing controller execution seam, so no extra Windows native
process-monitor trial was consumed. Both required broad gates for this correction
have now completed, sequentially, at `c234fd8b599d3c782e22aecffb7a442ef62fcc52`:
standalone **1350 tests, 1346 passed, 4 skipped, 0 failed**; productization
**104 PASS, 6 explicit SKIP** (four host-bound, two live cost-gated).
The internal productization unit reporter independently gives the same counts.
Both terminal records have status 0, null signal and null error.
Raw evidence: `check-process-diagnosis-20261004-gates-job/capture`.

The complete product stand was frozen after these gates, without further product
changes, in `check-process-diagnosis-20261004-frozen/package`:
package SHA-256 `bde4ff32d99c768aa361b305b523d6d2852f54421cd9cc74f2b23e3fd007132a`;
installed CLI SHA-256 `d41dc6606447b7f2d5cd4d18a1aa00dfe1191fd7b46683bdfd9963827ff294d9`.
The earlier frozen artifact remains preserved and does not contain this correction.

To continue independent controls despite the Refactron prerequisite failure,
the matrix now accepts explicit existing `--tasks` labels. Default scope stays
all six. Selection and unselected labels are recorded. Selected controls get a
separate capture status; the full matrix remains INCOMPLETE with fewer than
12 passing controls. No assertion or the full-scope denominator was reduced.
H1/H2/H3/H5/S1 will run independently; R1 remains an unresolved prerequisite,
and both planned R1 native sessions remain unexecuted rather than successful.
This partial continuation does not fulfill the six-task plan or prove 8/10.

The independent continuation has now executed **10/12 full-scope controls**:

| Task | Correct change | Restored faulty implementation |
| --- | --- | --- |
| H1 | checkpoint pass, no block | checkpoint fail, blocked |
| H2 | checkpoint pass, no block | checkpoint fail, blocked |
| H3 | checkpoint pass, no block | checkpoint fail, blocked |
| H5 | checkpoint pass, no block | checkpoint fail, blocked |
| S1 | checkpoint pass, no block | checkpoint fail, blocked |
| R1 | not executed: unstable pristine baseline | not executed: unstable pristine baseline |

The selected capture has no failure, but the matrix correctly reports
`status: incomplete` and exits nonzero for the missing two controls. Its raw
archive contains **544 byte-verified files** at
`check-process-diagnosis-20261004-frozen/independent-controls-archive`.
The strict complete-comparison reporter was not run against this partial
archive; its completion requirements remain unchanged.
Fresh solution-blind copies were prepared separately from these historical
solution controls. The native job `check-process-diagnosis-20261004-native-job`
started and terminated after H1/plain: the independent correctness oracle passed,
but API request 4 ended without message_stop/final usage, native accounting did
not match, and no Stop event occurred. This is an incomplete session, not a
successful completion. The owned model/server were stopped. No Canary arm ran.
The local provider charge was $0; Claude's displayed cost is not provider billing.

The next instrument revision retains incomplete independent sessions and
continues subsequent pairs; it still refuses aggregate completion if accounting,
declared context or required Stop evidence is missing. Protected configuration
and baseline violations still stop the pilot immediately. Fresh project copies
are required for the new run. Product artifact bde4ff32/d41dc660 stays unchanged.

The fresh continuation job `check-process-diagnosis-20261004-native-continuation-job`
is running with instrument commit `03a3e88`. Its first completed pair is H1:

| Arm | Independent correctness | Native completion | Native input/output tokens |
| --- | --- | --- | --- |
| plain | pass | success, end_turn, reconciled accounting | 272016 / 11514 |
| Canary | fail | error_max_turns at 51 reported turns; no Stop | 1136935 / 17680 |

The Canary arm's recorded checkpoint is the **unchanged preparation doctor**
checkpoint, timestamp `2026-10-04T19:29:09.838Z`, before the session began.
It is not a verification of the final worker state or a completion approval.
The worker's final implementation incorrectly skips every file when maxAgeDays
is null/undefined; the hidden oracle observes an empty list instead of all files.
Configuration and baseline ancestry remain intact. This naturally occurring
failure was not injected and was not caught by a completion hook: the session
never reached that hook. It is a negative product-use observation, not evidence
of a successful block or a new live false-positive verdict.
The previous truncated job's worker state and preflight are preserved in
`check-process-diagnosis-20261004-frozen/incomplete-native-worker-archive`
(129 hashed files). Remaining pairs are still running; no aggregate score is
derived from this one completed pair.

The continuation stopped after H2/Canary. Its independent oracle passed, native
accounting reconciled, and the actual Stop checkpoint passed. However, the agent
used Bash `sed` to add `invoice-extensions-tests` to package.json despite the
trial's Edit/Write denials. The sealed script, local plan, hook settings and MCP
configuration were unchanged; the protected-package hash changed. This session
does not meet the trial's preserved-configuration requirement and is not counted
as a clean success. The same-user LOCAL boundary remains explicit.
The producer's model unload and owned-server stop both succeeded.

To avoid repeating completed sessions, the instrument now accepts explicit
`--sessions` names. It checks supported unique names, matching task selection,
exact scheduling, and the original pristine HEAD/clean worktree and baseline
oracles for every selected arm. Existing integrity assertions remain binding.
The next segment runs only H2/plain, H3/plain+Canary, H5/Canary+plain and
S1/Canary+plain, preserving the original task order. Instrument hashes differ
between segments and must be reported; selected capture completion is not full
12-session completion. R1/plain and R1/Canary remain unexecuted.

All ten runnable native arms are now terminal across the two segments. Four
Canary arms reached real Stop checkpoints. After separate H3 oracle repair,
functional correctness plus normal completion is **4/5 Canary versus 5/5 plain**;
requiring unchanged protected configuration reduces Canary to **3/5**. R1's
two planned arms remain blocked. This is not completion of the twelve-session
plan and does not establish an 8/10 product.

| Task | Plain | Canary | Native total tokens plain / Canary |
| --- | --- | --- | --- |
| H1 | correct normal completion | incorrect, max-turn abort, no Stop | 283530 / 1154615 |
| H2 | correct normal completion | correct Stop completion; package.json trial violation | 44981 / 792041 |
| H3 | correct normal completion | correct Stop completion after posthoc oracle repair | 90950 / 714480 |
| H5 | correct normal completion | correct Stop completion | 34046 / 88871 |
| S1 | correct normal completion | correct Stop completion | 174573 / 178757 |

Native API usage reconciles with Claude modelUsage in all ten arms, including
MCP traffic. Totals: **628080 plain versus 2928764 Canary tokens** (4.66x),
**379.052 versus 840.370 seconds** (2.22x). Provider charge remains $0.
These small local-model trials demonstrate overhead, not token savings.
The model/server were unloaded/stopped after both terminal segments.
Worker archives contain 152 and 167 hashed files respectively.

H3's raw oracle failure was a duplicate export introduced by the measurement
instrument when the worker already exported quantizeSymmetric. The repaired
instrument exposes a private alias without rewriting the declaration; identical
invalid/valid width assertions remain. Separate posthoc evidence passes both
unchanged candidate implementations and rejects the untouched pristine baseline.
Original outputs remain unchanged. This is a measurement correction, not a
product false green, and posthoc evidence has a different instrument hash.

Two additional product corrections were built after the frozen pilot:

* `result` no longer calls setup/doctor history a recorded completion. Human
  output distinguishes diagnostic history from hook responses and leaves session
  end unknown. Protocol tests: **8 pass, 0 fail, 0 skip**.
* The H2 raw baseline log identified an unnecessary block: a sealed smoke test
  imported `scripts/test-fileOrganizer-invoice-extensions.js`, but Canary's
  baseline overlay recognized suffix-named tests, not prefix-named tests. The
  overlay now also admits test-/test_/spec-/spec_ files, retaining worker
  provenance. A new regression fails before the fix and passes afterward;
  unused prefix tests and missing non-test helpers still cannot prove a change.
  Focused checks: **3 pass, 0 fail, 0 skip**. No verdict or JSON schema changed.

Evidence logs: `completion-history-label-20261004-{red,green}.log` and
`imported-test-prefix-20261004-{red,green}.log`. Full required gates for these
post-pilot changes remain pending; the previous frozen package is unchanged.

The required post-pilot standalone suite has now finished for product commit
`688654d0142948639a9a3387ad8a9cf794885ca7`: **1353 tests, 1349 pass, 0 fail,
4 explicit skips**, duration 335176.1559 ms, process status 0 with no signal or
execution error. `prefix-tests-completion-history-20261004-gates-corrected-job`
then started productization sequentially; its terminal result is still pending.
An earlier launcher mistakenly combined the output directory and `--unit-first`
into one PowerShell array element. That process tree was stopped and its capture
retained as interrupted, with no completion claim. The corrected standalone
suite forced a rebuild before running; it is the authoritative observation.

Inspection of the native tool records also limits the overhead diagnosis:
H1/Canary used 50 tool calls, eight tool errors and zero doctor calls; H2/Canary
used 41 calls, seven errors, one doctor call and the unnecessary missing-prefix
baseline block; H3/Canary used 28 calls, one error and one doctor call. Thus
repeated full Canary gate calls alone do not explain the token difference.
H2/H3/H5 plain arms each made zero smoke/test command calls. Functional oracle
success is not equivalent to adding and running regression tests. Further
improvements must reduce avoidable repair steps without dropping that evidence
requirement. These observations do not prove a prompting change will fix it.
