# WS5 real-world evidence bundle — index

Everything under this directory was produced by commands run on this host on 2026-09-24. The
report that reads it is [`docs/REAL-WORLD-EVIDENCE-1.5.md`](../../../../../docs/REAL-WORLD-EVIDENCE-1.5.md).

CLI under measurement: `apps/cli/dist/src/main.js`, used **as-is** (no build was run in the Canary
repo during this workstream). `canary --help` self-reports **canary 1.4.0**.

| Path | What it is |
|---|---|
| `ENVIRONMENT.md` | host toolchain, every remediation performed, and the measured step environment |
| `tasks/` | the six task texts handed to the agent, verbatim |
| `repos/<name>-result.json`, `repos/<name>-agents.txt` | `canary result --json` and `canary agents` for each wired copy |
| `runs/<id>/` | one directory per agent run: raw NDJSON stream, ledger, `record.json`, diffs, git state |
| `runs/<id>/checkpoint-manual.*` | present **only** when the Stop hook did not fire and `canary checkpoint` was driven by hand with the real hook JSON |
| `falsedone-INDUCED-schniedelsmp/` | the **INDUCED** false-done demonstration — read `LABEL.txt` first |

## Runs

> **Read `runs/R1-refactron-pytest-ids/` with the provenance section below.** That directory holds
> **two** attempts; every other run directory holds exactly one. The row for R1 is stated in terms
> of the artifacts that survive, not in terms of the attempt it was first written about.

| id | repo | hook fired? | verdict | turns | wall |
|---|---|---|---|---|---|
| `H1-hermes-maxagedays` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 14 | 166.4 s |
| `H2-hermes-invoices` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 14 | 195.2 s |
| `H3-hermes-quantize` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 20 | 290.7 s |
| `H5-hermes-simulation-cases` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 35 | 776.9 s |
| `S1-schniedelsmp-idlookup` | schniedelsmp.net | yes | `pass` (after the worker re-sealed its own plan and baseline) | 48 | 880.1 s |
| `R1-refactron-pytest-ids` | refactron | **two attempts in one directory — see below** | attempt 2 (the only surviving `record.json`): hook fired, `fail [tests]`; no completion attempt was reached. Attempt 1 (hook did not fire) survives only as its leftover manual checkpoint, a `block` on a **Canary-environment** failure | attempt 2: none (`no result event`) | attempt 2: 1 500.1 s (its `record.json`); attempt 1: ~169 s — **the artifact that carried that number (attempt 1's own `ledger.json`) is not in this bundle** |

`record.json` in each run directory carries the machine-readable form of all of it, including
`hookFiredDuringRun`, `checkpointDrivenManually`, `seenByModel` (whether the model was actually
shown the refusal) and the provider-native `usage`.

## Attempt provenance — which artifact belongs to which attempt

**The layout rule, from the audit finding this section answers: one attempt is one directory.**
`tooling/probes/v15-realworld-run-task.mjs` now opens `<run root>/<attempt id>/` (for example
`runs/R1-refactron-pytest-ids/attempt-1/`) and writes every artifact of that attempt inside it —
start metadata, raw stream, parsed stream, ledger, checkpoint events, the manual checkpoint if there
was one, git state, diff, `record.json`, `attempt-result.json`, `SHA256SUMS`. Every write is
create-or-fail, and a run into a directory that already holds evidence is **refused** (exit 1,
nothing written) unless `--new-attempt` opens a fresh attempt directory. The regression that proves
it is `tooling/probes/v15-attempt-provenance.mjs`.

**The six run directories in this bundle are the PRE-LAYOUT ("flat") shape**: the probe wrote each
artifact directly into the run root, which is unambiguous only when a task has exactly one attempt.
Five of them do — for `H1`, `H2`, `H3`, `H5` and `S1` the flat directory *is* that task's single
attempt, and their `record.json` is that attempt's own record. `R1-refactron-pytest-ids/` is the
exception, and it is why the layout changed.

### `R1-refactron-pytest-ids/` — MIXED: two attempts in one directory

Executed on this bundle (read-only):

```
node tooling/probes/v15-attempt-provenance.mjs --audit tooling/benchmark/results/session-evidence/v15-realworld/runs/R1-refactron-pytest-ids
```

```
AUDIT C:\Users\Johannes\Desktop\canary\tooling\benchmark\results\session-evidence\v15-realworld\runs\R1-refactron-pytest-ids
RECORDED ATTEMPT: label=R1 arm=canary wallSeconds=1500.1 window=2026-09-24T05:02:45.854Z..2026-09-24T05:27:47.384Z
RECORDED FLAGS: hookFiredDuringRun=true checkpointDrivenManually=false timedOut=true sawResultEvent=false
  THIS  agent.diff  mtime=2026-09-24T05:27:47.384Z
  THIS  agent.stderr.raw.txt  mtime=2026-09-24T05:02:46.975Z
  THIS  agent.stderr.txt  mtime=2026-09-24T05:27:46.455Z
  THIS  agent.stream.jsonl  mtime=2026-09-24T05:27:46.454Z
  THIS  agent.stream.raw.txt  mtime=2026-09-24T05:27:17.181Z
  DIR   canary-doctor-evidence
  THIS  canary-doctor-on-final-tree.txt  mtime=2026-09-24T05:28:52.139Z
  OTHER checkpoint-manual.stderr.txt  mtime=2026-09-24T04:57:38.425Z  → predates the recorded attempt by 307s: it belongs to an EARLIER attempt
  OTHER checkpoint-manual.stdout.txt  mtime=2026-09-24T04:57:38.423Z  → predates the recorded attempt by 307s: it belongs to an EARLIER attempt
  THIS  git-after.json  mtime=2026-09-24T05:27:47.384Z
  THIS  git-before.json  mtime=2026-09-24T05:02:45.847Z
  OTHER hook-input.json  mtime=2026-09-24T04:57:09.467Z  → predates the recorded attempt by 336s: it belongs to an EARLIER attempt
  THIS  ledger.json  mtime=2026-09-24T05:27:46.478Z
  THIS  record.json  mtime=2026-09-24T05:27:47.385Z
checkpointBefore.at=2026-09-24T04:57:38.412Z → OUTSIDE the recorded attempt's window (inherited from another attempt)
AUDIT RESULT: MIXED — 4 artifact(s)/state belong to a different attempt than record.json describes
```

Artifact by artifact:

| Artifact | Attempt it belongs to | How that is established |
|---|---|---|
| `record.json`, `ledger.json`, `agent.stream.raw.txt`, `agent.stream.jsonl`, `agent.stderr.raw.txt`, `agent.stderr.txt`, `agent.diff`, `git-before.json`, `git-after.json` | **attempt 2** — started `2026-09-24T05:02:45.854Z`, `wallSeconds: 1500.1`, `timedOut: true`, `hookFiredDuringRun: true`, `checkpointDrivenManually: false`, `sawResultEvent: false`, `assistantEvents: 139` | each file's mtime falls inside attempt 2's own window as its `record.json` states it, and each is the last write of its kind (attempt 2 truncated attempt 1's copies) |
| `canary-doctor-on-final-tree.txt`, `canary-doctor-evidence/**` | attempt 2's **final tree**, after the run (05:28:51–05:28:52Z) | post-run doctor invocation; not part of either attempt's stream |
| `hook-input.json` (04:57:09.467Z), `checkpoint-manual.stdout.txt`, `checkpoint-manual.stderr.txt` (04:57:38.423Z/425Z) | **attempt 1** — the earlier, ~169 s attempt, which was driven manually | the three files predate attempt 2's `startedAt` by 307–336 s; attempt 2 never wrote them (`checkpointDrivenManually: false`), so they were left behind by the earlier attempt |

Three consequences a reader must not read past, all of them measured above:

1. **Attempt 2 inherited attempt 1's terminal state as its own "before".** `record.json`'s
   `checkpointBefore` is `{"at":"2026-09-24T04:57:38.412Z","status":"fail","failed":["tests"],…}` —
   attempt 1's manually driven checkpoint, 307 s before attempt 2 started and outside attempt 2's
   window. It is *not* attempt 2's starting state.
2. **`hook-input.json` is attempt 1's, but its `transcript_path` now resolves to attempt 2's
   stream** (`…/R1-refactron-pytest-ids/agent.stream.jsonl`, written as a relative path). The
   leftover artifact and the record it points at are from different attempts.
3. **This index previously described attempt 1 in the R1 row** ("169 s", "manually driven `block`")
   while the only surviving `record.json` describes attempt 2. Both facts are real; they belong to
   different attempts, and the row above now says which is which.

**Attempt 1's raw record is NOT in this bundle, and it cannot be reconstructed.** Absent: attempt 1's
`agent.stream.raw.txt`, `agent.stream.jsonl`, `agent.stderr*`, `ledger.json`, `record.json`,
`agent.diff`, `git-before.json`, `git-after.json`, `hook-input.json`'s own stream, and the
`wallSeconds`/`numTurns`/`usage` numbers that lived in its ledger. Attempt 2 opened the same
directory and truncated every one of those files, so no copy exists here and **no amount of reading
this bundle will produce attempt 1's timeline**. What survives of attempt 1 is exactly the three
files listed above, plus what they say: `canary checkpoint` was driven by hand at
`2026-09-24T04:57:37.949Z` and returned
`{"decision":"block","reason":"Canary verification failed: tests (npm run test, exit 1)…"}` naming
`…/refactron/.canary/evidence/2026-09-24T04-57-37-949Z-checkpoint/tests.log` in the measured
repository copy — an **environment** failure (`python3`/`sh` cannot be seen by the sealed step,
§4 of the report), not the agent's work. The `~169 s` figure quoted for attempt 1 is a session note;
its own artifact was attempt 1's `ledger.json`, which attempt 2 overwrote. **Nothing here is
reconstructed, inferred into a record, or invented to fill the gap.**

**What this bundle therefore does not claim:** that R1 had two fully recorded attempts (it had one
recorded attempt and one partial leftover); that attempt 2's `checkpointBefore` describes attempt
2's start; or that the R1 row's verdict is a verdict about a completion (neither attempt reached
one). The defect itself is regression-tested:
`node tooling/probes/v15-attempt-provenance.mjs` (a re-run into a directory that already holds
evidence is refused; `--new-attempt` opens a second directory; the first attempt's bytes stay
byte-identical; each attempt keeps its own identity and `SHA256SUMS`).

## Probes (in the Canary repo, not in this bundle)

| Probe | What it measures |
|---|---|
| `tooling/probes/v15-realworld-run-task.mjs` | one real agent task, end to end: stream → ledger → did the hook fire → raw decision JSON, into one immutable directory per attempt |
| `tooling/probes/v15-attempt-provenance.mjs` | that re-running a task into a run root holding evidence is refused, that `--new-attempt` separates attempts, and that each attempt's identity is separately recoverable (`--audit <dir>` attributes a real bundle's artifacts to attempts) |
| `tooling/probes/v15-realworld-gate-env.mjs` | the environment a sealed step is actually handed on this host |
| `tooling/probes/v15-realworld-falsedone-induced.mjs` | the INDUCED false-done demonstration, all five conditions, restoring the repo in a `finally` |
