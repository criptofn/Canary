# Canary Migration Plan — from Golden-Snapshot Prototype to Dependency Regression Detection

Status: IMPLEMENTED (v0.1 alpha / proof-of-concept — see the round-1..4 ledgers
under docs/ and the golden fixture under fixtures/). This document is the
original plan; where it and the shipped code disagree, THE CODE IS THE TRUTH
and §6 below has been kept current with it.
Date: 2026-08-30 (plan) · §6 updated 2026-09-01 to match the post-sol decision table

---

## 1. Product restatement (updated 2026-08-30 — see docs/ADR-001-product-direction.md)

Canary is **an independent verification layer for AI-written code**: given a
baseline state and a candidate change, it runs deterministic checks against
both, reproduces suspected regressions, and emits a machine-readable
evidence bundle with a deterministic classification. Only *after* that does
an LLM get to speak, and it may never render the verdict.

**Dependency version updates are the first controlled proof-of-value**
(historical, reproducible before/after), not the product boundary:

## 2. Disposition of the Python prototype

The prototype (`canary/`, `tests/`, `proof/`, `examples/` — 59 unit tests + a
passing 8-step e2e proof) is the wrong product (generic golden-output
checker). It is **archived, not extended**: `git mv` into
`archive/python-golden-prototype/` (kept out of the TS build graph).

### Concepts PRESERVED (re-implemented in TypeScript)

| Prototype concept | Where it reappears |
|---|---|
| Deterministic subprocess execution: argv arrays (no shell), forced child env, captured stdout/stderr/exit code, timeout → kill → ERROR-not-golden | `packages/runner/executor` |
| Normalization of nondeterministic output before comparison (ISO timestamps, durations, temp/home/user/host paths, UUIDs, hex addresses; line-ending + trailing-newline canonicalization) | `packages/evidence/normalizers` — essential: test logs contain timings, ports, temp paths |
| Structured comparison (field-wise exit/stdout/stderr, unified diffs, JSON + human report dual format) | `packages/core/comparator` |
| Strong automated tests: real-subprocess integration tests, zero mocks | node:test suite + CI |
| Adversarial validation | a red-team pass over the pipeline before declaring M4, plus the prototype's lesson encoded as a rule: **a green result over degenerate evidence is a failure** — see §6 "degenerate-run guard" |
| Evidence hash chaining (sha256 of raw and normalized streams; atomic single-file bundle writes) | `packages/evidence/hashing` |
| E2E proof script as the primary milestone artifact | `canary prove` command + CI job (§7 M4) |

### Concepts DISCARDED
- golden baseline as the product concept (goldens of *test runs* are not the point)
- record/verify/accept CLI surface
- single-repo TOML config format (replaced by experiment specs, JSON, native TS)

## 3. Target repository layout (per mandate, with additions)

```
apps/
  cli/                       canary CLI (command name: `canary`)
packages/
  core/
    planner/                 experiment spec -> ordered ArmPlan[] (pure)
    comparator/              run-facts diffing, normalized streams, tree diff
    classification/          pure decision function -> Classification
  runner/
    executor/                subprocess runs: argv, env, timeouts, capture, kill
    workspace/               isolated per-arm workspaces from pinned git content
    environment/             toolchain + package-manager fingerprinting/selection
  evidence/
    schema/                  Evidence Bundle types + JSON Schema (draft 2020-12)
    hashing/                 sha256 streams, normalized-stream hashing
  registry-npm/              npm registry client (versions, deps, gitHead, tarballs)
  github/                    repo content fetch by owner/name + commit SHA (codeload tarballs)
  ai/                        OPTIONAL summarizer interface (no-op provider default)
  support/                   shared: logging, errors, exit codes, fs helpers
fixtures/
  axios-0.27-to-1.0/         the golden fixture: experiment spec + verified metadata
schemas/
  evidence.schema.json       published schema, versioned
docs/
archive/
  python-golden-prototype/   the old Python code (reference only)
.github/workflows/ci.yml     build + unit/integration tests + `canary prove`
LICENSE                      Apache-2.0
```

npm workspaces monorepo, **strict TypeScript** (`tsconfig` project references,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node ≥ 22 (dev on 26),
zero runtime dependencies in `core/*` and `evidence/*` (pure logic); `runner/*`,
`github/`, `registry-npm/` use only Node built-ins + fetch (undici ships with Node).
Test runner: built-in `node:test`. No bundler; `tsc` output, `node dist/…`.
Linting = `tsc --noEmit` strict + code review (boring > configured).

## 4. Experiment spec format (declarative input)

`fixtures/axios-0.27-to-1.0/specs/axios-mock-adapter.json` (live golden; the earlier
cookiejar draft lives on as `specs/axios-cookiejar-support.demoted.json`):

```jsonc
{
  "schema": 1,
  "id": "axios-0.27-to-1.0--axios-cookiejar-support",
  "dependency": {
    "package": "axios",
    "baseline": "0.27.2",
    "candidate": "1.0.0"
  },
  "downstream": {
    "repository": "https://github.com/3846masa/axios-cookiejar-support",
    "commit": "f1e045d4787b4f4e427a502867e47c1e52cb7aa6",   // tag v4.0.2
    "fetch": "tarball"                                      // codeload by SHA
  },
  "install": {
    "packageManager": "npm",            // driven for swap; yarn1 for era-lock install
    "eraPin": "2022-10-04T00:00:00Z",   // resolution ceiling (npm --before / yarn frozen)
    "commands": {
      "prepare": ["yarn", "install", "--frozen-lockfile"],
      "candidateSwap": ["npm", "install", "--no-save", "--legacy-peer-deps", "axios@{candidate}"]
    }
  },
  "test": {
    "build": ["npm", "run", "build"],   // once, in prepare (compiles specs vs BASELINE types)
    "command": ["npx", "ava"],          // same compiled artifact both arms; axios swapped at runtime only
    "timeoutSecs": 600
  },
  "repetitions": { "baseline": 2, "candidateFailureReruns": 5 },
  "passSignal": { "authoritative": "exitCode", "expected": 0 }
}
```

Rationale for build-once/run-twice: the spec files and package sources are
compiled a single time against the baseline type contracts; the *runtime*
axios library is the only thing that differs between arms. This isolates the
independent variable exactly and turns any candidate-time TypeScript
breakage into a separately-reported, clearly-labeled type-compat observation
(not the primary signal).

## 5. Pipeline (the 16 mandated steps → concrete stages)

```
PLAN        spec → ArmPlan[]: prepare, baseline ×2, candidate ×1(+ reruns ×5)
PREPARE     github.fetch(commit) → clean source tree into staging workspace
            environment.fingerprint() → {node, npm, yarn, os, arch, timezone, locale}
            install.prepare (frozen era-locked tree)   → tree snapshot T (npm ls --json)
BASELINE    same staging tree → arm workspace B: run test command ×2 → RunFacts
CANDIDATE   reset to equivalent clean workspace (fresh copy of prepared staging
            tree, byte-identical except planned swap; verified by tree diff T vs T')
            install.candidateSwap → axios@1.0.0 → tree snapshot T'
            treeDiff(T,T') MUST reduce to the axios subtree, else INCONCLUSIVE(tree-drift)
            run test command ×1..N → RunFacts (failures trigger reruns to N=5)
COMPARE     normalize(logs) → exit codes, parsed runner summary, per-test status lists,
            first-divergence diff (unified), infra-signal matches, timings
CLASSIFY    pure decision function (§6)
EVIDENCE    JSON bundle (schemas/evidence.schema.json, schemaVersion=1,
            all raw/normalized sha256, reproduction counts, classification +
            matched rules listed, timestamps, toolchain versions)
            + HTML report (generated from bundle; same data, human layout)
EXIT CODES  0 CONFIRMED_REGRESSION (proof holds) · 1 PASS / proof failed ·
            2 other classification or infrastructure · 3 canary misuse
```

Every stage writes artifacts under `.canary-runs/<experiment-id>/<runid>/` —
append-only, hash-chained (bundle embeds artifact hashes), so a bundle is
self-auditing against its raw logs.

## 6. Classification — deterministic decision function

Inputs: per-arm exit codes, normalized logs, infra markers — and, since the
post-GLM observation hardening, the **execution-observation channel**: a
per-round record of what a Canary-injected observer WATCHED inside a
byte-pinned runner (claim contract: docs/EXECUTION-AUTHORITY.md). Printed
text enters as a CLAIM to be cross-checked, never as proof of execution; exit
codes are authoritative about process death, not about tests.
Infra markers are **regex allow-lists on runner facts** (npm/yarn ERESOLVE /
ENOTFOUND / EAI_AGAIN, `ERR_MODULE_NOT_FOUND`, ava internal crash banner,
timeout-kill sentinel, empty-output-without-summary) — never LLM judgment;
case-folded and ANSI-stripped at matcher entry (view-only, post-GLM B).

Total rules, evaluated IN THE ORDER SHIPPED (`packages/core/classification`;
every rule pinned by classify.test.ts). The rule-14 gate is not in the row
order below: `classify()` computes `observationGateIssue` over raw per-round
fields FIRST, runs the table (reading ATTESTED counts/identities when the
gate holds), and re-routes any gated result that failed the gate to rule 14 —
before the 9/10 confinement guard applies:

| # | Condition | Classification | Since |
|---|---|---|---|
| 0 | either arm missing from the fact set | INCONCLUSIVE | plan |
| 1 | ANY round is not a valid test execution: killed, crash signature, failed containment sweep, infra signature at any exit code, no runner summary, summary without machine-readable counts, zero EXECUTED tests (pending is not execution), exit≠0 claiming 0 failures, exit 0 masking failures | INFRASTRUCTURE_FAILURE | plan + audits F1/F5/B2 + R3-B1/B2 |
| 2 | baseline exit codes disagree | FLAKY | plan |
| 8 | within an arm, failing rounds' profiles (count + identityCoverage + identities) differ | FLAKY | audit F2 |
| 11 | a failing round's parsed identities do not fully account for its reported failing count | INCONCLUSIVE | R3-B1 |
| 12 | an arm's repetitions disagree on executed (passing+failing) or observed (+pending) totals | FLAKY | **post-sol RB-2** |
| 13 | a STRONG verdict (3/4/5) whose arms' executed or observed totals differ — weaker or missing execution may never produce a stronger verdict — **or** a would-be PRE_EXISTING_FAILURE whose candidate fails ≥1 identity baseline never saw fail (failing-set containment: a watched pass→fail transition is never swallowed; disjoint sets are non-comparable) | INCONCLUSIVE | **post-sol RB-2 / post-GLM F1** |
| 3 | baseline all-pass ∧ candidate all-pass (coverage comparable per 13) | PASS | plan |
| 4 | baseline all-fail ∧ candidate all-fail ∧ candidate failing identities ⊆ baseline's (comparable per 13) | PRE_EXISTING_FAILURE | plan |
| 5 | baseline all-pass ∧ candidate all-fail, profiles identical (comparable per 13) | **CONFIRMED_REGRESSION** | plan |
| 6 | baseline fails while candidate does not uniformly fail | INCONCLUSIVE / FLAKY | plan |
| 7 | baseline clean, candidate mixed | FLAKY | plan |
| 14 | gate: a strong or execution-claim label (STRONG_EXECUTION_LABELS — incl. every FLAKY producer 2/6/7/8/12) whose rounds lack a VALID observation agreeing with the text on counts, identities and exit semantics; downgrade-only, never upgrades | INCONCLUSIVE | **post-GLM A** |
| 9/10 | post-guard: tree drift outside the dependency subtree / non-VALID tree observation | any strong verdict downgraded to INCONCLUSIVE | audits F9/B6 |

The prototype lesson — "a green result over degenerate evidence is a failure"
— survives as rule 1's no-summary / zero-executed guards; "5 reruns" from the
original table is not a code rule (the planner enforces repeats ≥ 2 per arm,
and the validator independently requires ≥ 2 DENSE rounds for trustful
labels). Candidate reruns preserve per-run evidence; unanimity is computed
over exit codes; identical suite-qualified failing-test identities across
reruns are required (rule 8) and persisted in the bundle as first-class data.
Post-GLM: when the observation gate holds, the identity/coverage math reads
the ATTESTED counts/identities — the channels are equal by the gate's own
condition, so the observed record (not the text) is the canonical source for
the table (rule 13's F1 containment constraint is thereby evaluated on
Canary-observed failing identities, the only execution facts with authority);
malformed disk-carried observations are a gate REFUSAL (rule 14), never a
crash. On the un-attested path containment can at most pre-empt a producer
rule — any surviving strong or FLAKY label is downgraded to rule 14 anyway.

## 7. Golden fixture — selection evidence and fallback ladder

**Primary (statically verified 2026-08-30):** `3846masa/axios-cookiejar-support`
@ `f1e045d4` (v4.0.2). Verified facts:
- registry: devDep `axios: "0.27.2"` exactly; peer `axios >=0.20.0` (1.0.0 legal),
  deps `http-cookie-agent@^4.0.1`
- repo at that commit: committed `yarn.lock` (era-pinned tree), ava 4.2.0,
  `test: "ava"`, `pretest: build (tsc)`
- test specs make **real axios calls** against real `node:http` servers:
  `wrapper(axios)` monkey-patches the node adapter — the exact subsystem
  axios 1.0.0 rewrote (AxiosHeaders, adapter contract, transform pipeline)
- historical window: axios 1.0.0 released 2022-10-04; package's next releases
  (4.0.4, 2022-12-26 onward) carry the axios-1.x compatibility fixes → between
  those dates this repo genuinely failed against 1.0.0 while passing 0.27.2

**Gate M0 (blocked on §9.1 permission):** manual dry-run, no product code:
extract → `yarn install --frozen-lockfile` → build → `npx ava` (expect exit 0)
→ `npm i --no-save axios@1.0.0` → `npx ava` (expect nonzero, stable failing
specs) → rerun candidate ×3 (expect unanimous). If the signature does not
materialize, fallback ladder (same protocol, pre-vetted metadata):
  F1. `about-security/axios-cookiejar-support` @ v5.x pre-1.x-adapter fix
  F2. `softonic/axios-retry` @ v3.x (axios interceptor + error-shape dependence)
  F3. `JustinBeckwith/retry-axios` @ v0.3.2 (adapter wrap)
  F4. `for-GET/axiosist` (server-wrapper over axios)
  F5. user-designated real downstream
Only a fixture that produces PASS(0.27.2) → unanimous-FAIL(1.0.0) on *real
repo tests* becomes the golden fixture; until then, fixtures/ is documentation,
not proof.

## 8. AI layer boundary (packages/ai)

Interface only in v1: `summarize(bundle, rawLogs) => {summary, likelyAreas[]}`
with a no-op provider as the only implementation shipped enabled. Any real
provider (e.g. Qwen) attaches under `evidence.ai` as clearly-labeled,
non-authoritative fields. Invariant enforced in schema: `classification` is
not in `ai` namespace; bundle validation fails if an AI-written field
contradicts the deterministic fields. No prompt can flip §6 rules — the
pipeline structurally cannot consume AI output upstream of classification.

## 9. Decisions

### 9.1 RESOLVED (2026-08-30) — user approval with mandatory security constraints

Approved fixture: `3846masa/axios-cookiejar-support` @ `f1e045d4` — self-
authorized to proceed on this exact fixture/commit. Binding constraints,
which become **architectural requirements of `packages/runner`** (not
one-off dry-run ceremony):

1. Pin repo + exact commit SHA; fetch content by SHA (tarball), never branch.
2. Static inspection before any execution: `package.json` lifecycle hooks
   (`preinstall/install/postinstall/prepare` must be absent — script aborts
   otherwise), scripts, and config files. Verified 2026-08-30: no install hooks.
3. **Environment allowlisting** for every external process: fixture code sees
   only `PATH, PATHEXT, SystemRoot, windir, ComSpec, TEMP, TMP, HOME, USERPROFILE`
   (+ audit-F6 NEUTRALIZATIONS `USERNAME/USERDOMAIN/LOGONSERVER/HOMEDRIVE/
   HOMEPATH/SYSTEMDRIVE` — the Windows loader appends those to any child
   regardless of replacement, so they are declared with fixed non-identity
   values). Deny-by-omission kills `ANTHROPIC_*`, `*_TOKEN`,
   `*_KEY`, cloud credentials, SSH agent vars, `NODE_OPTIONS` — those are
   structurally invisible (proven by the permanent child-observation test,
   packages/support/test/env.test.ts). Values of
   allowlisted vars are recorded by *name only* in evidence.
4. Execution only inside a disposable workspace under the repo
   (`.canary-runs/…`, gitignored) or OS temp; caches (npm, yarn) redirected
   inside it; isolated `HOME`/`USERPROFILE`; empty explicit `--userconfig`.
5. No writes outside the workspace — **intended discipline, NOT an OS-enforced
   jail** (see docs/SECURITY.md Tier B: v0.1 has no filesystem sandbox).
6. Network limited (by Canary's own behavior, NOT an egress allowlist —
   SECURITY.md Tier C): approved repo content (codeload) + declared dependency
   installs (npm registry). `--ignore-scripts` on every install command so no
   transitive lifecycle code runs. A fixture's own test code is not firewalled.
7. No publish, push, remote modification, purchases, or external authentication.
8. All downstream repository code is treated as untrusted input.
9. The sanitizer is implemented once in `packages/support` (`sanitizedEnv` /
   `runCommand`; `packages/runner/environment` handles toolchain fingerprinting)
   and applied to every arm of every experiment — the same protection then
   holds for all future downstream repos automatically.
10. If a required capability cannot be provided without violating 3–7, the
    runner stops and reports INFRASTRUCTURE_FAILURE (with reason) before
    executing anything external.

First implementation of these rules: `archive/prototype-scripts/m0-dryrun.mjs`
and `run-experiment.mjs` (the M0 ladder harnesses), promoted into
`packages/runner/{executor,workspace}` + `packages/support` +
`packages/core/{planner,comparator,classification}` at M1–M4; CLI entry in
`apps/cli`. The prototypes are archived, not live.

### 9.2 Non-blocking (defaults confirmed)

- Default per §4: build-once/run-twice isolation; era pin `--before=2022-10-04`
- Repetitions: baseline ×2, candidate ×5 after failure
- Node 26 hosts everything (fingerprinted, era-risk documented; era packages
  run under `--legacy-peer-deps`); a toolchain-manager (pinned Node 16) is
  deferred — added only if a fixture proves Node-version-hostile (would show
  as INFRASTRUCTURE_FAILURE, never as fake PASS)
- Python prototype archived under `archive/`, not deleted
- No git commits until instructed (identity unconfigured); will ask at M1

## 10. Milestones

| M | Deliverable | Status (updated 2026-08-31) |
|---|---|---|
| **M0** | Manual dry-runs of candidate fixtures under the security contract | ✅ done — cookiejar PASS (honest), contentful refused by audit gate, mock-adapter CONFIRMED_REGRESSION |
| **M1** | Monorepo scaffold: workspaces, strict TS refs, LICENSE (Apache-2.0), CI workflow, archive move | ✅ done |
| **M2** | executor + normalizers + hashing, unit + real-subprocess tests | ✅ done (61 tests green) |
| **M3** | github + workspace-audit + environment + planner with spec validation | ✅ done |
| **M4** | comparator + classification + evidence schema + HTML report + CLI run/prove/check/report; golden proof reproduces | ✅ done — 4 independent CONFIRMED_REGRESSION runs, 14/14 proof assertions incl. byte-exact cross-run normalized-hash equality via the CLI (refactor parity gate) |
| **M5** | Adversarial validation (red-team of pipeline + boundary), docs pass | ✅ done — red-team 13 findings fixed; superseded/extended by the independent Codex audit (F1–F15) remediated in `audit-hardening` M1–M11, ledger docs/AUDIT-REMEDIATION-2026-08-30.md |

Known deliberate limits (v0.1):
- Hash-exact proof is machine-local (path separators in stack traces). Resolved
  by audit-F11, hardened by round-3 B3: SIX host-exact assertions (normalized
  hashes, evidence-environment↔proof-host binding, runtime version match,
  per-round argv/envKeys re-derivations) are gated on the ACTUAL runtime
  matching the committed `proofHost`; off-host they report SKIPPED, every
  portable assertion still runs (23 of them), and the verdict is INCOMPLETE
  (exit 2) — never a PASS built on skips. The pinned CI windows job executes
  all 37 with zero skips. No `--portable` flag was needed.
  Post-GLM F2: "matching" is BYTES, not claims — the fingerprint includes
  `nodeExecSha256` (SHA-256 of the running node executable); a tampered
  runtime printing v26.3.0 from other bytes is off-host, and a committed
  proofHost without the digest pin is REFUSED (assertion fails, exit 1).
- Round-3 ledger: docs/AUDIT-REMEDIATION-ROUND3-2026-08-31.md (blockers B1–B6,
  secondaries, and the internal adversarial self-review N1–N10 + doc-truth
  pass). The golden proof has never been re-cut for host drift: drifted dev
  hosts are COMPATIBILITY evidence, not new canonical hosts.
- Normalizer user/host rules disabled in pipeline wiring — the child env is
  sanitized with identity vars NEUTRALIZED (audit F6) so real usernames/hosts
  should not appear in fixture logs; re-enable per domain if needed.
- `registry-npm` intentionally empty (see its README).
- No filesystem jail, no network egress allowlist (see docs/SECURITY.md Tier
  C) — kernel-level containment is post-v0.1.

