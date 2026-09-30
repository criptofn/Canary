# Installed six-task controls after the input-control correction

## Scope

This no-model follow-up measures the same installed product across all six
recorded tasks: Hermes H1/H2/H3/H5, Refactron R1 and Schniedelsmp S1. It uses
fresh, independent task copies at the recorded starting commits. Ordinary project
checks and Canary setup/doctor are run before applying the known task solution.
The historical solutions are operator-controlled inputs, not agent output in
this experiment.

Each positive control runs the project checks, real completion checkpoint and
independent task oracle. The negative control retains exactly those regression
checks and restores the task implementation from its sealed baseline. The oracle
must observe the original defect again, and completion must be blocked. These
are deliberately introduced controls, not naturally observed agent mistakes.

The installed package is the local improvement tested in the preceding report,
not the original GitHub release. Package SHA-256:
`ef2d79f37352626eb5547e22daaa1c20020bb2bb160fa9aa34b8a841735b5e34`.
CLI SHA-256:
`22810c904c340d57156f3a8497daa0548b24fbcead7c683b142fb762fabed68b`.
The original release package remains available and its recorded SHA-256
`cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386`
was rechecked; it is not the artifact executed in this matrix.

## Reproduction and evidence

```powershell
node tooling/probes/v15-installed-task-matrix.mjs --cli '<absolute installed dist/main.js>' --package '<absolute package.tgz>' --scratch-root '<local recorded project repositories>' --java-bin '<absolute Java 21 bin>' --out '<new absolute evidence directory>'
```

The saved instrument invokes the existing preparation, validation and oracle
tools. Its manifest pins each instrument, historical patch, installed CLI and
package by hash. Command argv, output, exit codes, task identities and the actual
checkpoint records are retained. No development CLI fallback is used. The
measurement executes edited project programs with LOCAL same-user rights; it
does not demonstrate an OS security boundary or native agent-hook dispatch.

Local evidence directory:
`C:\Users\Johannes\AppData\Local\Temp\canary-installed-matrix-20261001`.
The instrument sources used for this run are also saved under `instruments/`.

## Results

The first run completed all twelve plain/Canary preflights with zero nonzero
commands and six READY results. H1's positive control passed and its negative
control was blocked. H2 then exposed a historical fixture dependency: its
regression code uses `fs`, `os` and `path`, but its saved task-only patch inherited
those imports from an earlier H1 solution. On the independent original baseline,
the source oracle passed but the project check crashed with `ReferenceError:
fs is not defined`. Canary correctly recorded `fail` and blocked completion.
The run stopped there; the remaining controls were not executed. Its final
summary is incomplete, not a passed six-task matrix.

The H2 solution preparation now supplies its own imports, preserving the actual
assertions and source correction. The matrix uses that preparation tool for H2
and pins its hash. It also asserts every preflight command's success and that
the final checkpoint was written by `checkpoint`, rather than accepting a stale
setup/doctor record. Raw evidence is hashed separately from mutable project
copies. No shipped product source or package changed in this follow-up.

The corrected run uses new independent copies and a new evidence directory:
`C:\Users\Johannes\AppData\Local\Temp\canary-installed-matrix-20261001-corrected`.
It exited 0 with **12/12 controls passed** in 19 minutes 17 seconds. All twelve
plain/Canary preflights also passed; every Canary baseline was READY. Each of the
six independent baseline oracles observed its target defect. Each positive
oracle passed, and each negative oracle observed that same defect again.

| Task | Correct solution | Original implementation with the same regression check |
| --- | --- | --- |
| H1: zero-day age filter | pass; not blocked | fail; blocked |
| H2: invoice classification | pass; not blocked | fail; blocked |
| H3: quantization bits | pass; not blocked | fail; blocked |
| H5: simulation cases | pass; not blocked | fail; blocked |
| R1: pytest parameter ids | pass; not blocked | fail; blocked |
| S1: ambiguous id prefix | pass; not blocked | fail; blocked |

All six positive hook responses retained the worker-authored-evidence caveat.
Neither historical solutions nor an operator's use of this measurement tool
silently turn rewritten tests into independent authority. All twelve checkpoint
records came from the real `checkpoint` command, not setup/doctor or a loop guard.
CLI and package hashes were unchanged at the end.

Permanent raw evidence is under
`C:\Users\Johannes\Desktop\canary\_canary-data\evidence\installed-six-task-20261001`:
`fixture-failure/` preserves 344 byte-verified files from the initial incomplete
run; `corrected-final/` preserves 692 byte-verified files from the completed run.
The exporter validates instrument snapshots and historical inputs against their
recorded hashes. It includes the product's native evidence bundles separately
from the mutable project copies. Original absolute execution paths are retained
in the records, while `export-manifest.json` maps the archived raw bytes.
An initial export to `corrected/` stopped on an encoding mismatch: the H2
preparation's source digest hashes decoded UTF-8 text, while the exporter first
compared raw bytes. The corrected exporter verifies that decoded-text digest
and records the byte digest separately. The partial export is not authoritative;
use `corrected-final/export-manifest.json`.

Syntax checks for all three changed measurement programs passed. The matrix and
byte-verifying exports exercise their changed behavior. The complete unit suite
and productization battery were not repeated for these measurement-only changes:
no shipped source or installed package changed. Their earlier results remain
those in [the input-control report](POST-V15-INPUT-CONTROL-2026-09-30.md), not new
passes claimed for this run.

This matrix does not measure agent repair success, model cost, token savings,
or ordinary user intervention. The outstanding native twelve-session pilot
and intermittent Windows monitoring finding remain separate. No higher product
rating follows from passing these controls alone.

## Next pilot route under investigation

The host has Claude Code 2.1.278. Ollama documents local Claude Code support via
its Anthropic-compatible API and native input/output token counters. This is a
possible route to a real agent-hook pilot without the unresolved Alibaba billing
cap, using an explicitly isolated local configuration. Compatibility, effective
settings, model behavior and accounting still need an executed preflight before
any paired pilot starts. No native Claude model session ran in this follow-up.
Sources: [Ollama Claude Code integration](https://docs.ollama.com/integrations/claude-code),
[Anthropic API compatibility](https://docs.ollama.com/api/anthropic-compatibility),
[Claude settings precedence](https://code.claude.com/docs/en/settings).
