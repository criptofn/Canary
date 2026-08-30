# Canary v0.1 Audit Remediation Ledger — 2026-08-30

Authority for this work: the independent Codex audit finding list (relayed by the
operator 2026-08-30). Each finding below was located in code at baseline
(`4106b41`, branch `audit-hardening`, 73/73 tests passing, build clean) — i.e.
**every listed finding was confirmed to have a live mechanism in the code, not
merely suspected**.

Operating rules (from operator):
- Provider-blocked items are marked `PROVIDER_BLOCKED`, never retried with the
  same generated content, never papered over by weakening Canary.
- After each milestone: focused tests → full suite → build+typecheck → golden
  Axios proof rerun (when the production pipeline is affected) → ledger update →
  local commit. No pushes, no remote, no v0.2 scope.
- Findings are treated as confirmed until independently disproven with
  **execution evidence**.

## Baseline facts

| item | value |
|---|---|
| branch | `audit-hardening` @ `4106b41` |
| tests at start | 73/73 pass, build+typecheck clean |
| golden proof | `npm run prove` — axios 0.27.2→1.0.0 on `ctimmerm/axios-mock-adapter@b8804442` |

## Milestones and findings

Status legend: OPEN · DONE · PROVIDER_BLOCKED · DISPROVEN(with evidence)

### M1 — regression-classification correctness
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F1 | False CONFIRMED_REGRESSION when candidate prints a passing summary then exits nonzero | `executor.round()` sets `reportedFailing = parseSummaryCounts(...).failing` — mocha/ava omit the "N failing" line when zero fail → `undefined`, and `isInfraRound`'s guard needs `=== 0`. Guard exists but is unreachable for real runner output. | DONE (c8be6aa: matched-summary-without-count ⇒ reported-zero; conservative INFRASTRUCTURE_FAILURE) |
| F2 | Differing candidate failure counts/identities still treated as deterministic | `classify()` compares only exit-code parity (`unanimous`/`every(pass)`); identical exit 3 with 2-vs-5 failing tests or different failing test identities still yields CONFIRMED_REGRESSION. | DONE (c8be6aa: rule 8 — within-arm failure-profile equality (count + sorted identities); divergence ⇒ FLAKY) |

### M2 — evidence semantic integrity
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F3 | Evidence validator accepts contradictory fabricated evidence | `validateBundle` is purely structural: any hand-authored bundle with well-shaped fields passes (label need not follow from rounds; `reproductionCount` unchecked vs candidate rounds; timeout/exit contradictions unchecked; unconfined drift + CONFIRMED label accepted). Fix: persist `infraSignal`/`reportedFailing`/`failingTestNames` per round (M1) and **re-derive** the classification inside the validator. | DONE (c8be6aa: validator re-derives classification, enforces reproductionCount, timeout/exit consistency, drift confinement vs trustful verdicts, sparsity refusal) |

### M3 — proof verification against real artifacts
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F4 | Proof accepts tampered hashes because it does not fully rehash artifacts | `cmdProve`/`assertProof` compare bundle fields to expectations but never re-hash the on-disk `.stdout.log`/`.norm` files against the recorded `raw*/normalized*Sha256`. Tampering artifacts (and log-derived assertions) is invisible. | DONE (M3: `verifyArtifacts` re-hashes all 4 files/round inside `cmdProve` — covers both `prove` and `check` — before any assertion; runs on the post-rerun dir, not just the pointer. Execution evidence: golden proof 16/16 PASS + live tamper test — appended byte to `baseline-1.stdout.log` → `check` exit 3 naming `TAMPERED artifact baseline-1.stdout.log` with both digests; restored → exit 0) |

### M4 — process lifecycle containment
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F5 | Detached descendants can survive a normal successful execution | `killTree` runs only on timeout. On normal `close`, descendants (same group on POSIX, children on Windows) are never swept. | DONE (M4, this host) — post-close `sweepDescendants()` on EVERY exit (Windows: live-orphan PPID lineage via CIM + CreationDate floor vs PID-reuse; POSIX: /proc pgrp scan + group-kill backstop). Residual, documented in code: POSIX `setsid()` double-fork daemon escapes both sweep and (here) proof-of-absence — v0.1 claims best-effort containment sweep, NOT a kernel jail. **POSIX branch not yet executed** (no WSL on this host; no push so ubuntu CI not run tonight) — mechanism-proven test + containment e2e both green on Windows. |

### M5 — environment consistency
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F6 | Child environment exposes undeclared Windows variables incl. HOMEDRIVE/HOMEPATH | `sanitizedEnv` returns a literal allowlist block, but `envKeys` in evidence records **declared** keys, never the child's **observed** keys. Vector unverified — M5 starts with an executed child-env observation probe; fix or DISPROVEN per result, then keep observation as a permanent assertion test. | DONE (M5, this host) — executed probe CONFIRMED the vector and found it worse than reported: real `HOMEPATH=\Users\…`, `USERNAME`, `USERDOMAIN`, `LOGONSERVER`, `HOMEDRIVE`, `SYSTEMDRIVE` appear even for `env:{}` — the WINDOWS LOADER appends session vars regardless of block replacement (so "allowlist ⇒ invisible" was false). Fix: sanitizedEnv NEUTRALIZES all six with fixed non-identity values (explicit vars win over loader injection — probe-verified); `SANITIZE_ALLOWLIST` extended to cover the full cross-platform declaration (15 win32 keys); PERMANENT observation test (`packages/support/test/env.test.ts`) asserts child-observed keys == declared and identity vars hold neutral values. Bundle `envKeys` is now truthful by verification. POSIX equality awaits ubuntu CI. |

### M6 — package-manager/config handling
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F7 | Uppercase `.NPMRC` bypasses config audit on Windows | `findRcFiles` compares `e.name` case-sensitively against `RISKY_RC_FILES`; on case-insensitive filesystems `.NPMRC` is loaded by npm as project config. | DONE (M6: case-INSENSITIVE match everywhere — fail-closed even on Linux; 2 new audit tests incl. mixed-case nested `.YarnRc.yml`) |
| F8 | npm global options before the install subcommand bypass `--ignore-scripts` injection | `expandArgv` finds the subcommand as the first token not starting with `-` — a **value-taking** option (`$npm -u evil.npmrc install x`) shifts detection to `evil.npmrc`, silently skipping ALL isolation flags. Also no rejection of spec-provided conflicting config flags. | DONE (M6: `pmArgvGuard` — short options rejected outright; isolation-conflicting long flags rejected BEFORE and AFTER subcommand (`--userconfig/--prefix/--registry/--cache/--script-shell/...`); unknown bare option before subcommand rejected instead of guessed; `exec/x/dlx/shell/explore` subcommands forbidden (trailing injection dead after `--`). 5 new tests; golden argv shapes all still expand + inject) |

### M7 — tree-drift correctness
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F9 | Confinement removal not caught by the 73-test suite | The rule-9 confinement override lives inline in `runExperiment`; no test exercises it. Fix: pure `applyConfinementGuard` + offline end-to-end pipeline test (M8 seam) so guard removal flips a test. | OPEN |
| F10 | Scoped/nested dependency drift handling gaps | `diffTrees` passes the **raw** spec package name into `inDependencySubtree` while tree keys are `escapePkgKey`-encoded — for a scoped dep (`@scope/pkg` → key `@scope%2Fpkg`) `key === dependency` never matches → every scoped-drift report is falsely "not confined". `endsWith('/'+dep)` also needs the escaped form. | OPEN |

### M8 — pipeline and CLI integration tests
| ID | Finding | Scope | Status |
|---|---|---|---|
| F13 | Failing-test identities not persisted in the Evidence Bundle | No `failingTestNames` in `RoundEvidence`/schema. Fix lands with M1 (classification consumes identities), persisted here. | DONE (c8be6aa: `infraSignal`/`reportedFailing`/`failingTestNames` flow executor → bundle → published JSON schema) |
| — | (gap) No `apps/cli` tests exist at all; `npm test` glob doesn't cover `apps/**` | Fix: offline e2e experiment (local stub fixture, no network) exercising pipeline → classification → evidence → prove/check, including confinement guard, fabricated-tamper rejection, CLI exit codes. | PARTIAL (M3 commit adds `apps/**` to test+CI globs and `apps/cli/test/prove.test.ts`; full offline pipeline e2e still OPEN) |

### M9 — CLI/report consistency
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F12 | `npm run report` unusable without explicit evidence argument | `cmdReport` requires argv[1]; root script passes none → usage/exit 3. Fix: default to latest run's evidence; report must render failing-test identities from the bundle itself (currently only via unused `extras`). | OPEN |

### M10 — CI running the real proof
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F11 | CI runs `canary run` instead of real proof assertions | `ci.yml` golden-proof step only checks `run`'s exit code. Fix: `run` + `check` in CI; split proof expectations into portable assertions (classification/rule/exit codes/summaries/failing identities/internal determinism) vs machine-local hash assertions skipped off-proof-host (structured `hostFingerprint` comparison, not string vibes). | OPEN |

### M11 — documentation truth pass
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F14 | No filesystem sandbox or network allowlist exists; docs must not claim it | README/SECURITY claims checked against code: env allowlist + audit gate + no-shell + pinned SHA are real; fs jail / network egress control are not. Rewrite claims to enforced-guarantee vs best-effort vs absent, and record M4/M5/M6 outcomes honestly (incl. residual gaps like post-exit orphan spawn). | OPEN |
| F15 | Linux/cross-platform support not proven | CI core job is ubuntu but golden proof is windows-only and never runs on Linux. Fix scope for v0.1: honestly document platform status; add ubuntu CI leg for the offline suite (already ubuntu); do NOT claim the golden proof is Linux-proven without an executed Linux run. | OPEN |

## Deferred / out of scope (v0.1)

No v0.2 features. No RepoWise/Semgrep/CodSpeed/Playwright/cloud/distributed/AI-diagnosis.
`packages/registry-npm` stays reserved.

## Milestone log

(append one dated entry per milestone: what changed, test results, commit hash)

### 2026-08-30 — M1 + M2 (F1, F2, F13, F3) @ c8be6aa
Classification fixes (F1 zero-failing-line ⇒ reported-zero; F2 rule-8 within-arm
failure-profile equality), per-round identity plumbing (F13), and the semantic
`validateBundle` re-derivation (F3). Suite 73→89 green; build+typecheck clean;
golden Axios proof PASS (16/16, identical normalized hashes) post-M1. Honest
note: M1+M2 landed as one commit and the ledger status cells were not flipped
at commit time — corrected here at M3. The post-M2 golden-proof rerun was
folded into the M3 rerun below (M2 changed only validation, which the prove
path exercises before assertions — so the M3 PASS covers it).

### 2026-08-30 — M3 (F4) @ 9364538
`verifyArtifacts()` re-hashes all four per-round artifacts against recorded
digests; `cmdProve` (both `prove` and `check`) refuses on any mismatch before
assertions, and re-checks the post-rerun dir. New `apps/cli/test/prove.test.ts`
(6 tests: clean, raw-tamper, norm-tamper, missing, all-four, logPath-contract);
test+CI globs now cover `apps/**` (first slice of the M8 gap). Suite 89→95
green; build+typecheck clean; golden Axios proof PASS (16/16). Live negative
test on real proof artifacts: byte-append to `baseline-1.stdout.log` →
`check` exit 3, `TAMPERED artifact baseline-1.stdout.log` (recorded vs on-disk
digests printed); restore → `check` exit 0.

### 2026-08-30 — M4 (F5) @ this commit
`runCommand` now sweeps descendants after EVERY child close (normal exit and
timeout alike): `sweepDescendants()` — win32 BFS over `Win32_Process.ParentProcessId`
(live orphans retain their creator's PPID) with a CreationDate≥spawn−60s floor
against PID-reuse collateral, POSIX /proc `pgrp==childPid` scan (ps fallback)
plus negative-pgid SIGKILL backstop. `RunOutcome` gains `childPid`/`sweptPids`/
`sweepFailed`. 5 new tests in `packages/support/test/lifecycle.test.ts`
(mechanism proof against a LIVE parent + containment e2e normal-exit/timeout/
no-descendants/no-self-kill). Execution note: the dev session runs inside a
Windows Job Object that kills orphans on parent exit — the e2e survivor could
not be left alive for the sweep here, so the sweep mechanism is proven
directly against a live parent (found + killed the child) while e2e asserts
containment regardless of winning layer; that environment fact does NOT hold
for production runs generally. Suite 95→100; build+typecheck clean; golden
Axios proof PASS (16/16). POSIX branch awaits ubuntu execution (CI leg — no
push tonight); F15 documents the same.

### 2026-08-31 — M5 (F6) @ 5702019
Executed child-env observation probe FIRST, as the ledger required. Vector
CONFIRMED and worse than stated: Windows appends the logon session's identity
vars to every child environment even when the block is fully replaced
(`env:{}` still yielded the real `USERNAME`/`HOMEPATH`/`LOGONSERVER`/
`USERDOMAIN`/`HOMEDRIVE`/`SYSTEMDRIVE`), while evidence recorded only the
declared 9. A second probe proved explicitly-declared vars win over loader
injection, so `sanitizedEnv` now neutralizes all six with fixed non-identity
values (USERNAME=canary, USERDOMAIN=CANARY, LOGONSERVER=\\\\CANARY, HOME-
drive/path/SYSTEMDRIVE derived from the disposable workspace). SANITIZE_-
ALLOWLIST (evidence schema) extended accordingly. New PERMANENT observation
test `packages/support/test/env.test.ts` (3 tests): observed keys == declared
keys (incl. what the bundle records), neutralized values proven in the child,
no credential/behavior-injection vars visible, real account identity absent.
Executor test de-duplicated its hard-coded key list to derive from
sanitizedEnv. Suite 100→103; build+typecheck clean; golden Axios proof PASS
(16/16 — npm output unaffected by the neutralized vars). POSIX observed==
declared awaits ubuntu CI (no WSL here; F15).

### 2026-08-31 — M6 (F7, F8) @ this commit
F7: `findRcFiles` now matches rc names case-INSENSITIVELY (`RISKY_RC_FILES_-
LOWER`), so `.NPMRC` / `.YarnRc.yml` trip the injection gate on Windows/macOS
case-insensitive filesystems — fail-closed on Linux too. 2 new audit tests
(uppercase root `.NPMRC`, mixed-case nested `.YarnRc.yml`).
F8: `pmArgvGuard()` replaces the shift-able `find(!startsWith('-'))` detector.
It throws CanaryError on: any short option (`-u` etc.), any isolation-
conflicting long flag (`--userconfig/--prefix/--cache/--registry/--global/
--script-shell/--workspace/--omit/...`) in EITHER position (before or after
the subcommand — npm honors both), an unknown bare option before the
subcommand (cannot be proven valueless ⇒ could shift detection), and the
`exec/x/dlx/shell/explore` subcommands (fetch+run third-party code where the
trailing injection would land after `--` and evaporate). Legitimate self-
describing (`--key=value`) and known-boolean options pass; injection is
unchanged when the subcommand is install-family. 5 new executor tests incl.
the exact `$npm -u evil.npmrc install x` bypass (now rejected) and a
regression guard that `--loglevel=silent install` still injects. Suite
103→110; build+typecheck clean; golden Axios proof PASS (16/16 — the real
`--before=…`/`--no-save`/`--no-package-lock`/`--frozen-lockfile` shapes all
expand and inject correctly).
