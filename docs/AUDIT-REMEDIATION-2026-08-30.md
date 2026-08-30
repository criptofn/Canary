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
| F1 | False CONFIRMED_REGRESSION when candidate prints a passing summary then exits nonzero | `executor.round()` sets `reportedFailing = parseSummaryCounts(...).failing` — mocha/ava omit the "N failing" line when zero fail → `undefined`, and `isInfraRound`'s guard needs `=== 0`. Guard exists but is unreachable for real runner output. | OPEN |
| F2 | Differing candidate failure counts/identities still treated as deterministic | `classify()` compares only exit-code parity (`unanimous`/`every(pass)`); identical exit 3 with 2-vs-5 failing tests or different failing test identities still yields CONFIRMED_REGRESSION. | OPEN |

### M2 — evidence semantic integrity
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F3 | Evidence validator accepts contradictory fabricated evidence | `validateBundle` is purely structural: any hand-authored bundle with well-shaped fields passes (label need not follow from rounds; `reproductionCount` unchecked vs candidate rounds; timeout/exit contradictions unchecked; unconfined drift + CONFIRMED label accepted). Fix: persist `infraSignal`/`reportedFailing`/`failingTestNames` per round (M1) and **re-derive** the classification inside the validator. | OPEN |

### M3 — proof verification against real artifacts
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F4 | Proof accepts tampered hashes because it does not fully rehash artifacts | `cmdProve`/`assertProof` compare bundle fields to expectations but never re-hash the on-disk `.stdout.log`/`.norm` files against the recorded `raw*/normalized*Sha256`. Tampering artifacts (and log-derived assertions) is invisible. | OPEN |

### M4 — process lifecycle containment
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F5 | Detached descendants can survive a normal successful execution | `killTree` runs only on timeout. On normal `close`, descendants (same group on POSIX, children on Windows) are never swept. | OPEN |

### M5 — environment consistency
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F6 | Child environment exposes undeclared Windows variables incl. HOMEDRIVE/HOMEPATH | `sanitizedEnv` returns a literal allowlist block, but `envKeys` in evidence records **declared** keys, never the child's **observed** keys. Vector unverified — M5 starts with an executed child-env observation probe; fix or DISPROVEN per result, then keep observation as a permanent assertion test. | OPEN |

### M6 — package-manager/config handling
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F7 | Uppercase `.NPMRC` bypasses config audit on Windows | `findRcFiles` compares `e.name` case-sensitively against `RISKY_RC_FILES`; on case-insensitive filesystems `.NPMRC` is loaded by npm as project config. | OPEN |
| F8 | npm global options before the install subcommand bypass `--ignore-scripts` injection | `expandArgv` finds the subcommand as the first token not starting with `-` — a **value-taking** option (`$npm -u evil.npmrc install x`) shifts detection to `evil.npmrc`, silently skipping ALL isolation flags. Also no rejection of spec-provided conflicting config flags. | OPEN |

### M7 — tree-drift correctness
| ID | Finding | Root cause located | Status |
|---|---|---|---|
| F9 | Confinement removal not caught by the 73-test suite | The rule-9 confinement override lives inline in `runExperiment`; no test exercises it. Fix: pure `applyConfinementGuard` + offline end-to-end pipeline test (M8 seam) so guard removal flips a test. | OPEN |
| F10 | Scoped/nested dependency drift handling gaps | `diffTrees` passes the **raw** spec package name into `inDependencySubtree` while tree keys are `escapePkgKey`-encoded — for a scoped dep (`@scope/pkg` → key `@scope%2Fpkg`) `key === dependency` never matches → every scoped-drift report is falsely "not confined". `endsWith('/'+dep)` also needs the escaped form. | OPEN |

### M8 — pipeline and CLI integration tests
| ID | Finding | Scope | Status |
|---|---|---|---|
| F13 | Failing-test identities not persisted in the Evidence Bundle | No `failingTestNames` in `RoundEvidence`/schema. Fix lands with M1 (classification consumes identities), persisted here. | OPEN |
| — | (gap) No `apps/cli` tests exist at all; `npm test` glob doesn't cover `apps/**` | Fix: offline e2e experiment (local stub fixture, no network) exercising pipeline → classification → evidence → prove/check, including confinement guard, fabricated-tamper rejection, CLI exit codes. | OPEN |

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
