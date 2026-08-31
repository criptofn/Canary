# Canary v0.1 Audit Remediation — ROUND 2 Ledger — 2026-08-31

Audited baseline (frozen, untouched): **`f823b98a9a8e6da75384192f65b946af4bc3ee75`**
Working branch: **`reaudit-hardening`** (created exactly at the audited SHA).
Authority: independent Codex RE-AUDIT (round 2) finding list, relayed by the
operator 2026-08-31. Status legend: OPEN · FIXED · PARTIALLY_FIXED ·
ACCEPTED_LIMITATION · REJECTED_WITH_EXECUTION_EVIDENCE.

## Reproduction (execution evidence at the frozen baseline)

All six release blockers were reproduced against the BUILT snapshot before any
change (script run 2026-08-31; output recorded in the session and summarized):

| ID | Reproduction result at `f823b98` |
|---|---|
| B1 | CONFIRMED — `extractFailingTestNames` on a two-suite/two-failure mocha log returned `["handles baseURL correctly"]` (2 distinct suite-qualified failures collapsed to 1). The REAL golden run shows this live: 3 failures / 2 distinct leaf titles / 3 distinct suite-qualified identities (`passThrough tests (requires Node) > handles baseURL correctly` vs `onNoMatch=passthrough option tests (requires Node) > handles baseURL correctly`). The committed proof itself asserts only 2 of the 3 identities. |
| B2 | CONFIRMED — `classify` over 4 zero-execution rounds (summary line present, no tests run) → `PASS rule 3`; rounds with NO runner summary at all, exit 0 → `PASS rule 3`. Executor computes `infraSignal` only when `exitCode !== 0`, so infra-shaped output at exit 0 is invisible to the classifier. |
| B3 | CONFIRMED (policy) — `verifyArtifacts` resolved `../baseline-1.stdout.log` OUTSIDE the artifacts dir and reported no containment issue for the file it found (only missing siblings); `logPath` is never checked against the round's own `arm`/`round`, so cross-round swaps (`candidate#1` claiming `candidate-2.stdout.log` with consistently swapped digests) verify clean. |
| B4 | CONFIRMED (by code path, full mutation matrix lands with the fix milestone): no digest binds cross-field claims; `check` never asserts `schema`/`experimentId`; persisted per-round facts (counts/names/summary/infra flags) are never re-derived from the artifact BYTES except for round-1 logs. |
| B5 | CONFIRMED — `$npm ins evil` and `$npm ii evil` (npm's real aliases of `install`) executed with `--ignore-scripts? false` (silent no-injection); raw `npm install x` and `node npm-cli.js install x` bypass the entire guard (guard only fires on `$npm`/`$yarn` tokens); `$npm install pkg -- x` appends all isolation flags AFTER the user `--`, where npm treats them as positional args → bypass. |
| B6 | CONFIRMED — `diffTrees({}, {}, 'axios')` returns `confined: true`: an empty/partial dependency-tree observation vacuously "proves" confinement. treeHash's `npm ls` exit status and `problems` array are never evaluated. |

## Release blockers

| ID | Finding | Status |
|---|---|---|
| B1 | Suite-qualified canonical test identity; no leaf-title collapse; proof updated to the REAL three golden identities | FIXED @ this commit |
| B2 | Execution-validity taxonomy: zero-test and no-summary runs can never PASS; infra-shaped output at exit 0 never PASS (without misclassifying benign prose) | OPEN |
| B3 | Artifact paths canonical (derived from arm/round, not trusted strings) + resolved-path containment + ownership binding | OPEN |
| B4 | Evidence bound to bytes: manifest integrity digest, per-round fact replay against artifacts, report verifies-or-labels, proof asserts schema/experimentId/repo/environment/tarball | OPEN |
| B5 | Canonical package-manager policy: closed subcommand allowlist (no alias blacklist), raw npm forms rejected, `--`-in-install rejected, isolation flags in effective position by construction | OPEN |
| B6 | Tree observations typed TREE_VALID/INCOMPLETE/INVALID; only VALID supports trustful labels; principled rule for npm ls non-zero w/ known problems | OPEN |

## Secondary round-2 findings

| ID | Finding | Status |
|---|---|---|
| S1 | F10-adjacent: POSIX sweep ignores session-level lineage (setpgid-escapees within the child's session missed) | OPEN |
| S2 | proof schema/experimentId not asserted (folds into B4) | OPEN |
| S3 | CI/clean-room use `npm install`, not `npm ci` | OPEN |
| S4 | README test count stale; PLAN historical claims to re-check | OPEN (final doc pass) |
| S5 | report renders without any artifact verification (folds into B4) | OPEN |

## Milestone log

(append one dated entry per milestone: reproduction → change → regression +
adversarial tests → mutation evidence → gates → commit SHA)
