# Canary: measured repair access and a false proof removed (2026-09-30)

## What changed

A follow-up to the scoped verification fix used four fresh local agent sessions
on Hermes tasks H1/H2. The previous file-only experiment prevented the agent from
running project tests or reading Canary output. The existing local harness now
supports operator-listed check commands, complete saved output, and optional
Canary diagnostics. Configuration and tool output live outside the measured
workspace; file writes still cannot enter Canary state. This is an experiment
harness, not a new supported integration or an OS security sandbox.

The sessions exposed a product defect in H2: the agent put example documents in
its working directory and rewrote the smoke test to inspect them. Its check
passed on the candidate. When Canary overlaid that test on the baseline, the
documents were absent; reading `move.group` threw a TypeError before the
assertion ran. Canary counted that crash as proof about the source change and
reported a pass with the worker-authored-evidence caveat.

The completion comparison now measures an input control for worker-authored
checks whose baseline run contains a TypeError, ReferenceError or SyntaxError.
It builds another fresh baseline tree, overlays the same checks and the current
versions of changed existing product files, and runs the same sealed plan. New
non-check files remain absent on both comparison sides. If this control also
fails, the outcome is objectively unproven. Both native outputs are saved in
bounded evidence bundles and the feedback names their locations. The control
tree is removed after the measurement.

This fixes the observed crash without treating every TypeError as invalid proof.
A genuine implementation crash remains discriminating when the current
implementation passes the input control. Wrapping the missing-input crash in
`assert.doesNotThrow` does not bypass the control. A self-contained behavioral
assertion still earns a pass with the existing worker provenance caveat.

Existing CLI schemas, statuses and JSON verdicts are retained. A previously
accepted ambiguous comparison can now return NOT PROVEN. The extra plan run
occurs only for the runtime-error case above. This does not establish general
fixture parity for arbitrary assertions or new implementation files. A missing
module/file remains handled by the existing infrastructure-failure checks.
Same-user LOCAL authority limits remain in force.

Reviewable implementation commits on `codex/product-progress`:
`2347070` contains the product correction, regression cases, troubleshooting
and installed replay instrument; `bfa9159` contains the local experiment tools
and accounting/classification corrections; `50ed758` corrects collection
completion and preserves the flat attempt layout. No merge or publication was performed.

## Four recorded local sessions, before the product correction

Both arms had the same authorized `npm test` command, model, task and independent
starting commit. H1 started plain first; H2 started Canary first. The independent
task oracles and historical solutions were outside the file-tool surface. There
were no manual repairs or injected defects during these sessions. Canary
checkpoints were driven by the harness; native Claude/Codex Stop hooks were not
observed. The frozen package was the previous local improvement, not the GitHub
release artifact.

Authorized checks execute edited project programs with the same OS user rights.
Keeping oracles outside the file-tool surface does not provide an OS-enforced
barrier against a program accessing those files. This pilot measures observed
agent behavior; it does not demonstrate adversarial oracle isolation.

| Task/arm | Independent source oracle | Native input/output tokens | Seconds | Check calls | Actual final Canary record |
| --- | --- | --- | --- | --- | --- |
| H1/plain | pass | 16,177 / 1,707 | 41.7 | 1 | not applicable |
| H1/Canary | pass | 44,502 / 4,962 | 91.5 | 3 | unproven; one-repair stop guard |
| H2/Canary | pass | 101,116 / 3,514 | 84.7 | 3 | pass with worker caveat; unsound baseline crash found afterwards |
| H2/plain | pass | 16,091 / 1,531 | 53.4 | 1 | not applicable |

All four model sessions emitted terminal results, but all four collection
processes exited 1 afterwards. Their new `tool-output/` subdirectory broke the
attempt's flat-file hash writer (`EISDIR`), after `attempt-result.json` had already
said complete. The pilot runner ignored the collection exit codes and therefore
incorrectly labelled the pilot complete. The top-level pilot hash manifest still
covers the retained raw files and native counters can be validated; this does
not turn those attempts into complete captures.

The collection now writes check outputs directly into the existing immutable
attempt directory. Failed or timed-out collection processes stop the pilot and
cannot count as complete; a captured incorrect solution still counts as a
completed measurement, separately from its correctness. A targeted regression
failed against the old completion predicate and passes after the correction.
Original records were not rewritten: `pilot-analysis-corrected.json` explicitly
reports all four captures incomplete and retains the observed native counts.

H1's added regression accepts both filtered and unfiltered outcomes, so its
NOT PROVEN result is justified. H2's source change is correct according to the
independent oracle; its original Canary proof is unsound for the reason above.
Neither is an additional correct source outcome over the plain arm. These four
sessions do not demonstrate lower token use or justify a higher overall product
rating. They did provide a naturally observed defect and its exact replay input.

The H2 raw experiment summary incorrectly labelled final evidence unverified
because it searched the entire transcript, including an earlier NOT PROVEN
block. The parser now reads the final response and current checkpoint for that
classification; historical block observations remain separate. Original raw
files were preserved. `pilot-analysis.json` records the corrected classification
and verifies that the native input/output totals equal all assistant event
counters. Ollama does not report separate cache/reasoning counters here; the
harness's compatibility zero fields are not measurements of those categories.
Missing native response counters now stop accounting instead of substituting
zero.

Model: `qwen3.5:9b`, digest
`6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`.
Ollama local inference incurred no provider USD charge. Each model session emitted a terminal result
and the model was unloaded; the server started for this experiment was stopped.
The original paid twelve-session native Claude pilot remains outstanding.

The standard Windows sweep stress probe in the final productization run observed
12/12 passes (six idle, six under CPU load). That green sequence does not explain
or close the earlier intermittent process-monitoring finding. No process-sweep
implementation change is part of these commits.

## Installed replay and regression evidence

The instrument copies the eight exact observed H2 files into fresh baseline
repositories, seals each with its explicitly selected installed package and
executes doctor and checkpoint. File hashes, CLI hashes, version, full argv,
native outputs and product evidence are retained. This is a controlled replay
of a naturally observed agent artifact, not another agent session.

```powershell
node tooling/probes/v15-worker-runtime-crash.mjs --before-cli '<installed CLI>' --after-cli '<installed CLI>' --observed '<H2 agent workspace>' --git-source '<local Hermes repository>' --out '<new evidence directory>'
```

The final installed replay passed both expectations: the previous artifact
reported READY/pass; the input-control implementation reported NOT PROVEN and
blocked checkpoint with an unproven record. Both packages report version 1.5.0,
so the hashes identify the artifacts. Final package SHA-256:
`ef2d79f37352626eb5547e22daaa1c20020bb2bb160fa9aa34b8a841735b5e34`;
installed CLI SHA-256:
`22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`.
An earlier intermediate replay and package are retained separately; the final
measurement is `final-installed-replay/comparison.json`. Neither comparison is
against the original GitHub release package. All eight exact observed replay
input files are archived under `observed-H2/` as well as in the original agent
transcript; their hashes appear in the comparison record.

Local immutable evidence root:
`C:\Users\Johannes\Desktop\canary\_canary-data\evidence\completion-agent-repair-20260930`.
Entry points: `pilot/pilot-manifest.json`, `pilot/pilot-summary.json`,
`pilot-analysis-corrected.json`, and the installed replay `comparison.json` files.
The earlier `pilot-analysis.json` is retained, but does not expose the capture
process failure; use the corrected derivation for completion status.
The pilot's package SHA-256 is
`00748588cb6db5f44f3f69d0051f3ecc9a1fca673d0062d995d1fe32750782bf`;
its installed CLI SHA-256 is
`348bfdb7b6ad486bd084317ef157da6699f435d9f36f6b630f453ed8ef77abb9`.

## Fresh follow-up after both corrections

Four independent copies were prepared again; all four no-model preflights
passed. Measurement code was frozen at `50ed758`, with the final installed
package identified above. Model, settings, task, check permissions and starting
state were equal within each pair, and the arm order again alternated. No code
changes, builds, manual repairs or injected defects occurred during these
sessions. All four collection processes exited 0, produced their own hash
manifests and passed native-counter validation. This means complete measurement,
not successful work in every session.

The project starting commit was
`7d0eb49c46d83184638fa093b44a15222feb8c51`. Local inference used
`qwen3.5:9b` with the digest above, temperature 0 and context length 8,192.
The fixed check definition was `checks.json`; the manifest and attempt records
retain the actual executable, arguments, tool hashes and model observations.

| Task/arm | Independent source oracle | Native input/output tokens | Seconds | Project check calls | Final checkpoint |
| --- | --- | --- | --- | --- | --- |
| H1/plain | pass | 16,171 / 1,695 | 43.8 | 1 | not applicable |
| H1/Canary | pass | 40,155 / 3,925 | 77.1 | 2 | fail; session ended after repair guard |
| H2/Canary | fail | 62,249 / 3,982 | 83.4 | 3 | fail; session ended after repair guard |
| H2/plain | pass | 15,581 / 1,573 | 39.7 | 1 | not applicable |

H1's source change passed the independent task oracle, but the added regression
called `fs.utimes` before creating `age1.txt`, so the project check failed with
ENOENT. That is a broken check, not evidence of a product false block. H2's
implementation still classified `invoice-2026.doc` as documents; its added
assertion failed and the independent oracle also failed. This is a naturally
observed source error; Canary did not certify it, and the repair did not succeed.
Neither ended session is labelled a passed checkpoint.

The original baseline/input-control defect remains demonstrated by the installed
replay and regression cases. These new sessions do not demonstrate successful
agent repair of that defect: both Canary arms ended with failing project checks.
They show a working collector and honest failed statuses, not higher source
correctness, fewer interventions or token savings. With only two pairs and this
local tool harness, they also do not establish a general correctness disadvantage.
No higher overall product rating is justified by this follow-up.

Evidence: `postfix-preflight.log`, `postfix-pilot/pilot-manifest.json`,
`postfix-pilot/pilot-summary.json`, per-attempt `SHA256SUMS`, and
`postfix-pilot-analysis.json`. The model was unloaded after all four sessions;
the separately started server was stopped (`postfix-cleanup.log`). Provider USD
charge was not applicable; native Claude/Codex Stop hooks remain unmeasured here.

This follow-up covers H1/H2 only. It does not replace the planned six-task,
twelve-session native Claude comparison. That pilot still needs a reliably
enforceable provider budget. The earlier intermittent Windows monitoring
finding also remains open. These results support the specific product correction,
not a claim that the complete post-1.5 validation plan has finished.

## Final gates

The product-correction `npm test` exited 0: 1,319 tests, 1,315 passed, zero failures,
four skipped, in 560.4 seconds. The complete native reporter output is retained
as `final-npm-test.log`. The two decisive input-control regression cases and
the original nine local harness tests also passed in targeted runs. After the
collection-status correction, the targeted harness suite passed 11/11;
`capture-status-before.log` and `capture-status-after.log` retain the failing
and passing regression reporters. Product source and the installed artifact
were unchanged by those measurement-only corrections. The subsequent complete
`npm test` also exited 0: 1,321 tests, 1,317 passed, zero failures, four skipped,
in 542.0 seconds (`npm-test-capture-fix.log`).

The four counted skips are POSIX `sh` process-sweep harness cases on Windows
(trusted `ps` resolution, inherited environment, an explicitly forged binary,
and a nonzero `ps` exit). The universal-tool Go suite is also explicitly skipped
because its workspace-local Go toolchain is absent; that skipped describe has
zero tests and is not included in the four-test skip count. These are not passes.

`verify:productization` exited 0: 104 PASS, six explicit SKIP, zero failures.
Four skips are host-bound: Go/Rust toolchains are absent (zero checks executed),
and both acceptance batteries lack a real PTY (their executable cases passed).
Two live Claude probes were not run because provider spend cannot be reliably
capped. Full output is `final-productization.log`; skipped probes are not passes.
All 13 master-pass mutations were caught. The packed product's tarball matches
the installed replay package SHA-256 above. The product source is unchanged by
the later collection fix. The full productization battery was not repeated
solely for that measurement-only fix: its unchanged shipped artifact was already
checked, while the changed collector received the targeted regressions, complete
unit rerun and four fresh end-to-end captures above.
An earlier full test run was intentionally interrupted while replacing
the first error-text guard with a measured input control. That partial run is
retained as `npm-test.log` and is not a passed gate.
