# Exception-style check exits: diagnosis without inventing a cause

## Observed evidence

The productization run for `d4c34d5` failed two cases when project check processes
returned `3221225501` (`0xc000001d`) and `3221225477` (`0xc0000005`). Canary's
failure message called these the project's own failure and advised fixing its
check. That attribution was stronger than the observed evidence.

Microsoft names these codes STATUS_ILLEGAL_INSTRUCTION and STATUS_ACCESS_VIOLATION
in its [NTSTATUS reference](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55).
The codes alone cannot identify which runtime, native dependency, host condition,
or deliberately chosen application exit produced them. The runtime observed on
this host was Node v26.7.0. No Windows Application error event for Node was
returned by the limited read-only event-log query; absence is not a diagnosis.

## Product correction

The shared failure-attribution function recognizes these exact signed or unsigned
DWORD exit values and reports cause `unknown`. Setup and doctor show the code and
its name; Stop also includes that diagnostic and its next action. A failing check
still fails: no READY/PASS, waiver, re-seal, retry, longer timeout, or support claim
is introduced. Existing public verdict statuses and exit codes are retained.

Ordinary assertion failures still use the existing project classification.
Missing authorized tools still use the measured environment classification.
Printed crash prose with an ordinary exit code cannot trigger unknown attribution.
The internal attribution union gains `unknown`; this is not a new verdict status.

Targeted evidence under `C:/Users/Johannes/Desktop/canary/_canary-data/evidence/`:

- `native-exit-attribution-20261003-red.log`: the regression failed because the
  observed exit value was classified `project`.
- `native-exit-attribution-20261003-green.log`: all 26 toolchain tests passed,
  none failed or skipped. Tests cover signed and unsigned values through both
  individual and aggregate attribution, and an ordinary-exit countercase.

This fixes the diagnostic, **not the process termination**. No additional Windows
process-monitor stress trials were run. The exhausted 30-trial diagnostic budget
and the unresolved monitor/provider findings remain open. The forthcoming full
gates may reveal another termination; a green run alone cannot close its cause.

## Provider evidence isolation

The package audit now passes an explicit `--report` path to its probe and keeps
each attempt in a unique directory. It preserves the package, exact instrument,
raw stdout/stderr, invocation and hashes before deleting the installation fixture.
A successful audit additionally requires the report's CLI and instrument hashes
to match the executed bytes. It does not read the globally shared legacy file.

`CANARY_PROBE_REPORT_DIR` selects a durable evidence parent for the measurement
script. Without it, the path is a separate directory under OS temp and is printed
as `PROVIDER EVIDENCE`. The legacy default report path remains for older direct
callers. These are experiment options, not new product CLI options. Syntax checks
passed; actual execution and hash assertions remain to be observed in the required
productization run.
