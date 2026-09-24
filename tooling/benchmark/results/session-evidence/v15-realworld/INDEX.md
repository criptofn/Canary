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

| id | repo | hook fired? | verdict | turns | wall |
|---|---|---|---|---|---|
| `H1-hermes-maxagedays` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 14 | 166.4 s |
| `H2-hermes-invoices` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 14 | 195.2 s |
| `H3-hermes-quantize` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 20 | 290.7 s |
| `H5-hermes-simulation-cases` | Hermes_Agent | yes | `unproven` (`regression-evidence`) | 35 | 776.9 s |
| `S1-schniedelsmp-idlookup` | schniedelsmp.net | yes | `pass` (after the worker re-sealed its own plan and baseline) | 48 | 880.1 s |
| `R1-refactron-pytest-ids` | refactron | no (nothing tried to stop) | manually driven `block` on a **Canary-environment** failure | — | 169 s, no `result` event |

`record.json` in each run directory carries the machine-readable form of all of it, including
`hookFiredDuringRun`, `checkpointDrivenManually`, `seenByModel` (whether the model was actually
shown the refusal) and the provider-native `usage`.

## Probes (in the Canary repo, not in this bundle)

| Probe | What it measures |
|---|---|
| `tooling/probes/v15-realworld-run-task.mjs` | one real agent task, end to end: stream → ledger → did the hook fire → raw decision JSON |
| `tooling/probes/v15-realworld-gate-env.mjs` | the environment a sealed step is actually handed on this host |
| `tooling/probes/v15-realworld-falsedone-induced.mjs` | the INDUCED false-done demonstration, all five conditions, restoring the repo in a `finally` |
