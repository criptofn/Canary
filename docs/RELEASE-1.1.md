# Canary v1.1

**Released 2026-09-13.** Artifact: `canary-rn-cli-1.1.0.tgz` (+ `.sha256`) ·
[GitHub release](https://github.com/criptofn/Canary/releases/tag/v1.1.0) ·
[CHANGELOG](../CHANGELOG.md) · [README](../README.md)

> Canary is an independent verification layer for coding agents.
> **The agent builds. Canary verifies. NO PROOF, NO DONE.**

This page is the human-readable overview of the current release: what the product
is, what changed, what was actually verified, what the benchmarks really show, and
what is still not claimed. Every number here was produced by an executed reporter;
each section links to the file that carries the raw evidence.

---

## What Canary is

A coding agent saying "done" is not evidence. Canary binds completion to proof.

**Everyday path.** `canary setup` reads the checks your project *already declares*
and wires itself into your agent. When the agent finishes, Canary runs those
checks: all pass → total silence; a check fails → the agent is blocked once and
sent back to repair it, and if it still fails, you are told in plain words.

**Task-aware path.** For work that must be *proven* rather than merely green, the
agent registers the intent, works in an isolated candidate, commits there, and
asks Canary to verify and promote. Canary promotes only the exact verified
committed bytes, and only when the proof holds.

**The rule that makes it different from a test runner.** A green suite is useful
evidence, not proof. If the checks pass on the base commit too, they say nothing
about the change. If a stated requirement is covered by no check, it is not
proven. Canary reports **`NOT PROVEN`** in both cases instead of `READY`.

**Why isn't it just "run tests"?**

| A green suite can be green because… | Canary's answer |
|---|---|
| the checks were already green **before** the change | proof must **discriminate**: fail without the change, pass with it, measured against the sealed base |
| a **stated requirement** has no check at all | each authorized requirement needs a sealed proof binding, or it stays `NOT PROVEN` |
| the requirement was never machine-checkable ("prettier") | subjective duties are a separate human act (`canary accept`, in a terminal) |
| the only evidence is a test **the worker wrote** | the verdict says so (worker-authored-evidence caveat) |

Fail-closed outcomes are first-class, not errors: `NOT PROVEN`,
`NEEDS ATTENTION`, `UNSUPPORTED`, `INCONCLUSIVE`, `BLOCKED`. And **a skip is
never a pass**.

---

## What changed from v1.0

v1.0 bound completion to a declared task with sealed numeric proof bindings.
v1.1 widens that from "one well-understood project" to "any project, with its
proof measured" — and closes two pre-release holes in the completion path
([below](#two-pre-release-blockers-that-were-closed)).

| Area | v1.0 | v1.1 |
|---|---|---|
| **Languages** | Node-based projects | native **Node/JS/TS, Python, Rust, Go** + a **universal** command-driven contract for everything else |
| **Proof** | sealed plan green → READY | sealed plan is re-run against the **sealed base**; a non-discriminating plan is `NOT PROVEN`; an unestablishable comparison is `UNPROVEN`, never a PASS |
| **Requirements** | numeric objective targets could be bound | `canary task --requirement` + the operator's `canary bind` attach **any** stated requirement to a sealed check; uncovered ⇒ `NOT PROVEN` |
| **Candidate path** | verify + promote | `canary work` / `canary finish` with **frozen authority** at isolation, and promotion gated on the same measured discrimination `doctor` uses |
| **Observation** | mocha (repo-pinned) | `node --test`, pytest, unittest channels, each bound to an authority (repo pin, the verifying runtime, or an operator-sealed identity) |
| **Agents** | Claude Code hook | + advisory Codex/generic-agent path, and `canary mcp` as a transport with no extra authority |
| **Interface** | human output | global `--json`, `canary result --json`, compact failure payloads that keep evidence **out of the model's context** |
| **Security** | `LOCAL` | still `LOCAL` — **honest**, with the provider/broker architecture implemented but `HARDENED` reachable only by measurement |

Upgrading an existing 1.0 installation: [`MIGRATION-1.0-TO-1.1.md`](MIGRATION-1.0-TO-1.1.md).

---

## Supported projects

Canary discovers the checks your project already declares — it never invents one.

| Project | Discovered from | What runs |
|---|---|---|
| Node / JS / TS | `package.json` (+ its lockfile) | `test`, `typecheck`, `build`, `bench`, `e2e` scripts |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini`, `requirements*.txt` | `pytest`, `tox`, `unittest`, plus `mypy` / `pyright` / `ruff` |
| Rust | `Cargo.toml` | `cargo test`, `cargo check`, `cargo build` |
| Go | `go.mod`, `go.work` | `go test ./...`, `go vet ./...` |
| **Any other command-driven project** | CI workflow commands, `Makefile`/`Taskfile`/`justfile` targets, CMake+CTest / Meson, `gradlew`/`mvnw`, `pom.xml`, `build.gradle*`, `*.sln`/`*.csproj`, `Package.swift`, `build.zig`, `phpunit.xml`, `composer.json`, `Rakefile`, `mix.exs`, `shard.yml` — or your own `canary.project.json` | those commands, sealed and pinned to absolute paths |

Four capability levels are reported **separately**, so nothing is inflated
([`COMPATIBILITY.md`](COMPATIBILITY.md)):

| Level | Meaning |
|---|---|
| **UNIVERSAL** | any command-driven project: the command really ran, at the authorized absolute path, in the authorized sealed directory, with that exit status, bound to the candidate's bytes — **and the runner's internals were not observed** |
| **NATIVE** | ecosystem-specific discovery and toolchain handling: **node, python, rust, go** |
| **OBSERVED** | Canary watched the runner's own lifecycle from inside the process: **mocha, `node --test`, pytest, unittest** — printed text becomes refutable |
| **STRONG** | a strong verdict may rest on it: an observed runner, bound to an authority |

An unknown runner is `INCONCLUSIVE_ONLY` by construction: a universal check can
verify a build, a lint or a test command honestly and can **never** turn printed
output into a strong verdict.

---

## Proof model

1. **A plan is sealed, not configured at run time.** `setup` records the plan and
   the verbatim text of every script it runs; drift is detected before execution.
   Programs are resolved to absolute paths at setup, so a bare name on the caller
   `PATH` cannot decide a verdict.
2. **A baseline is frozen.** Candidate work is isolated from a specific base
   commit, and the candidate's own intent snapshot (its "frozen authority") is
   taken at isolation. Registering a task *after* isolation can add duties but can
   never retroactively mint authority; the recovery is register + re-isolate.
3. **Proof must discriminate.** The sealed plan is re-run against the sealed base.
   Fail on base + pass on candidate = evidence about the change. Pass on both =
   **`NOT PROVEN`**. The repair is the worker's: add or point a check at the
   behaviour in question.
4. **An unestablished comparison is UNPROVEN, never a pass.** A missing module, a
   worktree that cannot be materialized, a check that cannot be overlaid, a plan
   that cannot run or produces no exit code, an environment-shaped failure, or a
   thrown comparison error all become an objective `UNPROVEN` obligation that
   *names the reason*.
5. **Obligations are one-way.** Every obligation is `met`, `unmet`, or `unproven`;
   nothing is discharged by silence. A changed test *filename* is not regression
   proof by itself.
6. **Only a human can waive a human duty**, and only from a terminal
   (`canary accept`) — and never an objective one.
7. **Precedence is fixed:** `fail` > `unmet` > `unproven` > `pass`. A red plan is
   never softened into "not proven", and a missing authority is never laundered by
   a split verdict.

---

## Candidate workflow

```bash
canary task "make the dialog prettier" --requirement "the button is #D94141"
canary bind e2e --requirement "the button is #D94141"
canary setup                                  # re-seal: the binding becomes frozen authority
canary work fix "make the dialog prettier"    # register + open an ISOLATED candidate
#   ...work and commit only inside the candidate directory Canary printed...
canary finish fix                             # verify from outside; promote only if the proof holds
```

- The candidate is a detached worktree of the **exact** base commit; the base
  stays byte-untouched until a promotion is authorized.
- `finish` re-verifies the **live committed bytes**, then fast-forwards the base —
  and only then. A candidate changed after a PASS is re-decided; a dirty candidate
  is refused.
- Promotion applies committed bytes only, is idempotent (a second run reports
  `ALREADY APPLIED`), and never deletes the candidate.
- `canary finish` refuses to promote what was not proven, and the Stop hook blocks
  the same way, so a worker cannot end a turn on an unproven claim.

---

## Requirement coverage

**A green plan proves the plan, not the task.** A requirement Canary knows about
becomes a **duty**; a requirement it does not know about is prose nobody checks.

- Declare: `canary task "<intent>" --requirement "<one per requirement>"` — it
  prints each requirement's digest, because that digest is what gets bound.
- Bind (the **operator's** act): `canary bind <script> --requirement "<text>"`
  writes the declaration (`package.json` `canary.proofs`, or
  `canary.project.json` for a non-Node project) and refuses a script the sealed
  plan does not run.
- Re-seal: `canary setup`. The declaration alone is not proof — the sealed
  authority must contain it.
- Result: a bound digest is credited by the exit code of the script the sealed
  plan really runs. An unbound requirement stays **`NOT PROVEN`** with the exact
  closing path printed (`canary bind …`, or a human `canary accept`).

**The measured trap: declared but unbound.** In one benchmark, five requirements
declared but never bound cost the guarded arm **1.5–1.7M tokens over 41–45 turns**,
because the worker was left pursuing a duty only the operator could close. Bound,
the same requirements were **cheaper than the unprotected arm** at 100% delivered
correctness. So the recommended order is:

```
operator declares requirements → canary bind → canary setup → worker handoff
```

---

## Subjective vs objective completion

Some results cannot be machine-proven: "make it prettier", "make scrolling feel
faster". Canary separates those from technical evidence instead of faking them.

| Duty | Closed by | Never closed by |
|---|---|---|
| **Objective** (a test, a benchmark target, a numeric threshold, a bound requirement) | the measurement — the sealed plan's exit code | human acceptance, a greener suite, a split verdict, an env var or flag |
| **Subjective / aesthetic** | a human running `canary accept` **in a terminal**, bound to that exact candidate tree | an agent's claim, a pipe, a copied acceptance file, an outdated acceptance |

An acceptance is bound to the exact candidate tree and to a **scope digest** (the
frozen kinds *and* the requirement identities, not their count): a new commit, a
grown or replaced requirement, or a new subjective kind makes it **stale**, and
the duty reopens. When technical evidence is complete but a human duty is open,
the verdict is a **split verdict** — evidence done, `NOT PROVEN` overall,
promotion locked.

---

## Agent integrations

| Agent | Capability | What that means |
|---|---|---|
| **Claude Code** | **GATED** | `canary setup` installs a completion hook; a failing check **blocks** the agent, and the block reason is delivered to the model |
| **Codex**, and any other command-line agent | **ADVISORY** | `canary agents install codex` writes a marked, removable block into this project's `AGENTS.md` telling the agent to consult `canary result --json`. It **cannot block anything**, and it says so |
| **Any MCP client** | **TRANSPORT** | `canary mcp` speaks the Model Context Protocol on stdio, exposing the same operations as tools — every tool runs the same CLI and relays its verdict and exit code unchanged, and `canary accept` is deliberately **not** exposed, because acceptance is a human act |

`canary agents` prints the real table for the repository in front of you. An
advisory integration is never described as a gate.

---

## Security / trust model

**`LOCAL` is what this release honestly claims.** Verified wiring, sealed plans,
pinned toolchain paths, an allowlisted child environment, and evidence bound to
the bytes it observed — all real, all measured. What it is **not**:
an OS isolation boundary.

- **Same-UID limits are documented, not hidden.** A worker running as the same OS
  user can, in principle, replace the local root of trust. `LOCAL` does not
  prevent that, and this document does not claim it does
  ([`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md),
  [`SECURITY.md`](SECURITY.md)).
- **`HARDENED` is not available here, and it is not "installation away".** The
  provider/broker architecture exists in the tree and refuses to start without a
  proven separation, but `HARDENED` is produced by exactly one thing: a boundary
  **measurement** in which every required control is observed present
  (`canary provider status`; the privileged steps are printed by
  `canary provider install-plan` and executed by nobody automatically). On this
  host all six controls measure unavailable, so `HARDENED` stays unreachable
  ([`TRUST-ARCHITECTURE.md`](TRUST-ARCHITECTURE.md)).
- **Evidence is tiered.** Only observed runners bound to an authority can carry a
  strong verdict; a byte-pinned runner with a Canary-injected observer must agree
  with the printed summary, so fabricated output (`node -e "console.log('128
  passing')"`) is `INCONCLUSIVE`, never `PASS`.
- **Bindings are declared coverage inside Canary's model, not semantic truth.**
  Binding a requirement to a check says the sealed plan measures something for it.
  It does not make Canary understand what the requirement *means*, and it is not
  an independent proof of semantic correctness.

---

## Two pre-release blockers that were closed

Both were genuine pre-release blockers in the completion path. Both are now
regression-tested (`apps/cli/test/discrimination-completion.test.ts`,
`tooling/probes/regression-evidence-gate.mjs`, `m10-2-adversarial.mjs`).

**BLOCKER 1 — candidate completion could use weaker obligation logic than the
discrimination gate.**
Candidate verify/finish could reach promotion on a green plan whose checks could
not tell the candidate from its base, while `doctor` (the completion gate) already
refused the same bytes.
*Fixed:* candidate verification and promotion now consume **measured
discrimination against the candidate's frozen isolation base**, inside the same
authority window. A touched or modified test **filename** is no longer proof by
itself; verify, promote, `finish` and the Stop hook read one verdict.

**BLOCKER 2 — an unestablished comparison could improve the verdict.**
A required baseline comparison that could not be established could lose its
obligation entirely — which silently turned `NOT PROVEN` into `READY`.
*Fixed:* required-but-unestablished comparisons remain an objective **`UNPROVEN`**
obligation naming the reason. A missing module, a materialization failure,
unavailable execution, an environment-shaped baseline failure, or a thrown
comparison error can never improve a verdict.

---

## Verification performed

Measured on the final release tree with the repository's own reporters. These are
test-*execution* counts, not a reliability percentage — do not convert them into
one.

**Full unit suite — `npm test`**

| Result | Count |
|---|---|
| tests | **1072** |
| pass | **1068** |
| fail | **0** |
| skip | **4** |

**Productization chain — `npm run verify:productization`** (74 steps, one command)

| Result | Count |
|---|---|
| PASS | **72** |
| host-bound SKIP | **2** |
| FAIL | **0** |
| exit code | **0** |

**`SKIPS ARE NOT PASSES.`** The two skips are host-bound **real-PTY** checks
(`pre10-acceptance` and `f3-acceptance-growth`): every product assertion in them
executed through the repository's in-process terminal driver — the exact gate the
product checks — but the OS-level pty allocation itself is not reproducible on
this host, so it is reported as a SKIP rather than counted as a pass. This release
therefore records **72/74 with 2 disclosed skips**, not "74/74".

**Mutation / adversarial batteries**

| Battery | Result |
|---|---|
| master-pass mutation battery (built dist) | **13/13 caught** |
| trust-boundary mutations | **14/14 killed** |
| architecture closure mutations | **13/13 caught** |

Also green in the same chain: architecture closure matrix **39/39**, packed
architecture matrix against the **installed tarball bytes**, dist-mutation guard
(recovery of an interrupted in-place mutation, byte-exact), requirement coverage
gate, universal requirement binding, regression-evidence gate, clean-room
install/uninstall, documented examples, and the observation-channel wiring suites.

**Reproduce it yourself:**

```bash
npm ci
npm run build
npm test                          # 1072 tests
npm run verify:productization     # 72 PASS / 2 host-bound SKIP / 0 FAIL
```

---

## What was actually tested

Grouped by the question each area answers, rather than by filename. "Test" below
means a real execution against the real CLI on real git — not a restatement.

**Proof / completion**
task identity and requirement digests · candidate isolation (detached worktree of
the exact base) · candidate promotion (live bytes, idempotence, divergence
refusal) · frozen authority at isolation · requirement coverage · requirement
binding (Node and non-Node manifests) · discrimination against the sealed base ·
unavailable / failed baseline comparisons · subjective acceptance split ·
acceptance staleness · precedence (`fail` > `unmet` > `unproven` > `pass`).

**Security / trust**
trust-store attacks (ledger, CAS, signatures, key custody, device names) ·
authority tampering inside the verification window · worker-authored-evidence
caveats · broker/provider refusal paths (unreachable, unauthorized, stale
generation, wrong window) · sealed program and toolchain paths · environment
isolation under a poisoned caller environment (`PATH`, `NODE_OPTIONS`,
`npm_config_*`, `GIT_DIR`) · runner-identity authority.

**Ecosystem / project support**
Node · Python · Rust · Go (each with a real end-to-end setup → doctor run) ·
polyglot and nested scopes · the universal command-driven contract (discovery and
explicit manifest, unknown runner capped at `INCONCLUSIVE_ONLY`).

**Integrations / protocols**
Claude Code hook path (block, repair, loop guard) · generic-agent advisory path ·
MCP transport · the JSON protocol (`--json` never changes a verdict) · compact
failure payload (bounded, names the check, points at the full log on disk).

**Distribution / productization**
package build (`tooling/pack.mjs` → `npm pack`) · packed-artifact clean room on a
path containing spaces (allowlist, no secrets, install from the tarball itself) ·
the full architecture matrix re-run against the **installed tarball bytes** ·
install / update / uninstall lifecycle · mutation batteries · dist-integrity
guard and interrupted-mutation recovery. The standalone single-executable path
(`npm run standalone`) is a separate, self-measuring build and is **not** part of
this release's productization chain.

**Benchmark fixtures** — 13 fixtures across the classes that matter for agent
work: bug fixes · validation · constraints · cross-file refactors · performance
constraints · impossible requirements · injected instructions · regression guards ·
multi-requirement tasks · version-consistency / spec-edge tasks. Each fixture
ships a known-good and a known-bad solution and is validated by its own test, so
the instrument cannot silently stop discriminating
([`fixtures.test.mjs`](../tooling/benchmark/fixtures.test.mjs),
[`BENCHMARKS.md`](../tooling/benchmark/BENCHMARKS.md)).

---

## Benchmarks

**Read this first:** the benchmark corpus is small (13 fixtures, one model, one
host, n=3–10 per cell). It shows a **token** effect under a specific
configuration. It did **not** demonstrate a general correctness advantage, and
nothing here should be read as one.

### The consolidated corpus — a ceiling effect, stated plainly

`bench-final`: 13 fixtures × {plain, guarded} × 3 trials, plus a re-run of two
repaired fixtures, after correcting three defects (one of which had flattered the
product's earlier headline, and was retracted in the file where it was made).

| Arm | Delivered correct | False dones | False greens | Tokens |
|---|---|---|---|---|
| `plain` | **36/36** | 0 | 0 | 136,402 |
| `guarded` | **33/33** | 0 | 0 | 193,519 (**+40.2%**) |

**This corpus did not demonstrate a general correctness advantage for Canary.**
The plain model already hit the ceiling at 36/36 on these small fixtures. What the
matrix does discriminate is raw token cost and the gate's own mechanics.

### Bound requirements — the one measured saving

`bench-r11`: five requirements declared **and bound** to sealed checks.

| Arm | Tokens | vs plain | Delivered correct | False dones | False greens |
|---|---|---|---|---|---|
| `plain` | 125,369 | — | 5/5 | 0 | — |
| `guarded` | **100,812** | **−19.6%** | 5/5 | 0 | 0 |
| `invisible` | **91,439** | **−27.1%** | 5/5 | 0 | 0 |

**The safe public claim, verbatim:** *in one bound-requirement benchmark, Canary
reduced model-token use by **19.6%** while maintaining **100% delivered
correctness**.*

That is **not** "Canary saves 19.6% of tokens", **not** a correctness claim, and
**not** a universal result.

### Declared but unbound — the failure mode to avoid

| Configuration | Tokens | Turns | Correct |
|---|---|---|---|
| `guarded`, 5 requirements registered, **none bound** (`bench-r9`) | **1.72M / 1.52M** | 45 / 41 | 2/2 |

The gate was honest and the delivery was correct; the worker simply could not
close a duty that only the operator could. **Bind requirements before the
handoff.** This is why the recommended order in
[Requirement coverage](#requirement-coverage) is not a style preference.

### Historical configuration results (not the release story)

- `bench-r6` measured **−58.5%** tokens with **correctness unchanged**. It is a
  **historical configuration result**. It must not be the v1.1 headline, and it
  must not be phrased as a universal saving.
- `bench-r5`'s **−56.4%** is explicitly **rejected as a default**: it lost one
  delivered-correct result and produced a false green. **Reliability outranks
  token savings.**

Full ledgers and every denominator: [`tooling/benchmark/RESULTS.md`](../tooling/benchmark/RESULTS.md) ·
method, KPI rules and what the set can/cannot tell you:
[`tooling/benchmark/BENCHMARKS.md`](../tooling/benchmark/BENCHMARKS.md) ·
consolidated matrix and the three corrected defects:
[`V1.1-STATUS.md`](V1.1-STATUS.md).

---

## Known limitations

- **`LOCAL` has documented same-UID / local-root-of-trust limitations.** Canary
  does not claim to prevent a same-UID worker from replacing the root of trust on
  this security level.
- **`HARDENED` requires actual measured OS-level controls** and is **not**
  available in this release. It is not an installation step away, and the
  provider/broker architecture is not marketed as established isolation.
- **A bound check establishes declared proof coverage inside Canary's model; it is
  not magical independent semantic truth.** Canary does not claim that a bound
  check proves the semantic meaning of a requirement.
- Canary does **not** claim it "never fails open" universally, and does **not**
  claim that every promoted change is independently semantically proven.
- Canary does **not** universally reduce tokens or universally improve
  correctness. The measured saving is configuration-specific (−19.6% in one
  bound-requirement benchmark); the correctness corpus showed a **ceiling effect**
  (plain 36/36).
- **−58.5% is not the release headline.** It is a historical configuration result.
- Claim strength is tiered by observation: an unknown runner is
  `INCONCLUSIVE_ONLY`; printed text never upgrades a verdict.
- Host-bound checks that this host cannot run are reported as **SKIP**, and
  **a skip is not a pass** (this release: 2 of 74 productization steps).
- GitHub-hosted CI is separate from the local verification reported here.

---

## Core commands

```bash
# first use
canary setup [--yes]          # detect project + agents, pin toolchain, wire, smoke-run
canary doctor                 # run the checks NOW: READY / NOT PROVEN / NEEDS ATTENTION / UNSUPPORTED
canary status                 # read-only state, runs nothing: CONNECTED / NEEDS ATTENTION / NOT CONNECTED
canary result [--json]        # the same state as one compact JSON object — free, for agents

# task-aware proof
canary task "<intent>" [--requirement "…"]   # declare the parts that must be proven separately
canary bind <script> --requirement "…"       # operator: attach a requirement to a sealed check
canary work <name> "<intent>"                # register + open an isolated candidate
canary finish <name>                         # verify from outside; promote only if the proof holds
canary accept <name>                         # human, in a terminal: close a subjective duty

# integrations and lifecycle
canary agents [install|uninstall <id>]       # which agents work here, at what capability
canary mcp                                   # MCP server on stdio
canary provider <status|install-plan|…>      # the HARDENED provider lifecycle (measured, not claimed)
canary uninstall                             # remove exactly Canary's own changes

# release-grade proof pipeline (a different, stronger promise)
canary run | prove | check <spec.json> · canary report · canary version
```

Exit codes: `0` READY / proof holds · `1` a proof assertion diverged (or `run`
classified PASS) · `2` NOT PROVEN / NEEDS ATTENTION / BLOCKED / UNSUPPORTED /
INCONCLUSIVE / proof INCOMPLETE off the proof host · `3` misuse or a refused bundle.

---

## Where to read the deep evidence

| Question | File |
|---|---|
| What this release is, in full | **this file** |
| What changed, version by version | [`CHANGELOG.md`](../CHANGELOG.md) |
| What was verified, when, and with which defects found | [`V1.1-STATUS.md`](V1.1-STATUS.md) |
| Benchmark method, KPI rules, and what the set cannot tell you | [`tooling/benchmark/BENCHMARKS.md`](../tooling/benchmark/BENCHMARKS.md) |
| Benchmark ledgers: every configuration, denominator and counter-example | [`tooling/benchmark/RESULTS.md`](../tooling/benchmark/RESULTS.md) |
| What can honestly be protected, and at which level | [`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md) |
| What a real OS boundary would require (HARDENED) | [`TRUST-ARCHITECTURE.md`](TRUST-ARCHITECTURE.md) |
| Security contract, tiers and ceilings | [`SECURITY.md`](SECURITY.md), [`../SECURITY.md`](../SECURITY.md) |
| Full support matrix, including what is not supported | [`COMPATIBILITY.md`](COMPATIBILITY.md) |
| Task identity, numeric bindings, input limits, local trust boundaries | [`AUTHORIZATION-1.0.md`](AUTHORIZATION-1.0.md) |
| Strong verdicts and the execution-observation channel | [`EXECUTION-AUTHORITY.md`](EXECUTION-AUTHORITY.md) |
| How test counts are derived | [`TEST-COUNTING.md`](TEST-COUNTING.md) |
| Upgrading a 1.0 installation | [`MIGRATION-1.0-TO-1.1.md`](MIGRATION-1.0-TO-1.1.md) |
| The `spec.json` contract for `run` / `prove` / `check` | [`SPEC-FORMAT.md`](SPEC-FORMAT.md) |
| Contributor loop and repository rules | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
