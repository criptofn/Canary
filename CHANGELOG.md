# Changelog

All notable changes to Canary are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Numbers quoted here come from executed reporter output, per
[`docs/TEST-COUNTING.md`](docs/TEST-COUNTING.md): this file records *what
changed*; the evidence ledgers record *what was observed*.

## [Unreleased] — v1.1 implementation candidate

**Not released, not tagged.** `HARDENED` is still unreachable (no provider with a
separate OS identity is installed — see
[`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md)). The six probes that
were previously reported as pre-existing host-bound failures are now **closed**
— no assertion was weakened, and none of them was a product defect (see
[`docs/V1.1-STATUS.md`](docs/V1.1-STATUS.md)).

### Fixed — the six previously-red probes

- **`m8-promotion` / `m9-authority`** were FIXTURE defects, not product defects.
  Both sealed steps called bare `git`, which the sanitized step environment
  deliberately does not have on PATH, so the step spawned ENOENT and the
  authority/identity sandwich never got to speak. The fixtures now name git
  absolutely — the same discipline `pinPlanPrograms` already applies to a plan's
  own programs. Both probes report ALL PASS (16/16 each) with the product
  unchanged; `m9-mutation-battery` is 15/15.
- **`pre10-acceptance` / `f3-acceptance-growth`** needed a real pty, which this
  host cannot provide (measured: no `script(1)`, and `winpty` without a console
  aborts on its own size assertion). One terminal provider now drives every
  product assertion through the repo's in-process terminal driver and reports
  the missing pty as an explicit host-bound `SKIP` (exit 3). 8/8 and 10/10 checks
  execute and pass; a `SKIP` is still never a pass.
- **`master-pass-mutations`** had a cascade (its baseline required an owner to
  exit 0, where a host-bound `SKIP` is exit 3) and three source anchors that
  later refactors had moved. Anchors re-pinned; all 13 mutations are caught.
- **`pre10-env-authority`** (fixed earlier): `trustedDirs()` is exported and
  includes the directories `gitExe()` actually executes from.

### Added — runner observation is now provider-neutral

- **`packages/runner/executor/src/runners.ts`**: a registry stating, per runner,
  whether a strong label is reachable and — where it is not — exactly why and
  what would have to exist first. `STRONG` is checked against
  `KNOWN_RUNNER_RELEASES`, the STRONG set is exactly `{mocha}`, and an unknown
  runner answers `INCONCLUSIVE_ONLY` by construction. jest, vitest, ava,
  `node --test`, pytest, `unittest`, cargo and go are registered with their real
  blockers; cargo and go were never executed here (no toolchain on this host) and
  are not claimed as working paths.

### Added — explicit nested ecosystem scopes

- **`canary.scopes.json`** declares `{ path, ecosystem }` scopes such as
  `web` Node, `backend` Python, `service` Go. Declared ⇒ exactly those scopes;
  undeclared ⇒ root only. Nothing is discovered by walking, so an undeclared
  `vendor/`, `archive/` or `examples/` tree can never add a check. An unusable
  declaration stops setup in full instead of shipping a partial plan, and the
  declaration is sealed, so editing it afterwards surfaces as authority drift.

### Added — MCP

- **`canary mcp`** serves six tools over stdio JSON-RPC (result, status, agents,
  doctor, work, finish), each a fixed argv template over an operation the CLI
  already had. It is a transport with no authority of its own: every call runs
  the same CLI and relays its verdict and exit code unchanged, no tool accepts an
  argument that could influence a verdict, and `canary accept` is deliberately
  not exposed — a machine channel must not reach the human terminal act.

### Added — Node-free distribution (host-target only)

- **`tooling/standalone.mjs`** builds a single executable with Node embedded via
  `node --build-sea` (one step on the Node builds this repo targets), and
  **executes** it with every Node directory removed from PATH before reporting
  success, writing the sha256 and the observed runs beside the artifact. Only the
  host's own target can be produced — `--build-sea` embeds the running `node`, so
  Linux and macOS artifacts must be built and executed on those hosts.


### Added — projects

- **Python, Rust and Go adapters** behind the existing `ProjectAdapter` contract:
  discovery from a project's own declarations (pyproject/setup.cfg/tox.ini/
  requirements/Pipfile; Cargo.toml; go.mod/go.work), never invented. A directory
  of `.py` files, or a tool named only in a comment, declares nothing.
- **Deterministic polyglot composition** across ecosystems that declare checks at
  a repository root, with each step carrying its adapter and scope. Nested scopes
  are discovered only when the project declares them in `canary.scopes.json`, so
  an `archive/` or `examples/` directory cannot silently add checks to the
  project containing it (see "Added — explicit nested ecosystem scopes").
- **Toolchain pinning**: at setup, each declared program is resolved once and
  sealed as an **absolute path**; verification later resolves only that path.

### Added — agents

- `canary agents` — every integration with its REAL capability: `GATED` (a
  completion can be blocked; Claude Code only) versus `ADVISORY` (the agent is
  told and may ignore it). `canary agents install codex` writes a marked,
  removable block into the project's `AGENTS.md`; nothing is installed unless
  asked for by name.
- `AGENTS.md` — harness-neutral agent instructions (Claude Code reads the same
  rules through `CLAUDE.md`).

### Added — machine interface and cost

- `canary result [--json]` — the state answer for programs: sealed checks, where
  evidence lives, the measured custody level, harness capability and the last
  recorded completion. Never runs the plan, writes nothing.
- A global `--json` on the everyday commands: stdout carries exactly **one**
  versioned envelope, prose moves to stderr, and exit codes and status words are
  identical with and without the flag.
- **Metrics** (`CANARY_METRICS=<file.jsonl>`) — one model-neutral record per
  invocation (command, flag names, exit code, duration, output sizes). Off by
  default, fail-open so a measurement can never change a verdict, and free text,
  paths and flag values are never recorded. Token counts are deliberately absent:
  they live in the harness.

### Added — workflow

- `canary work <name> "<intent>"` and `canary finish <name>` — the ordinary path.
  `work` registers the intent and opens the candidate in one step (the intent is
  frozen into the candidate's record at isolation, so registering later can only
  add duties). `finish` verifies the committed candidate from outside it and
  promotes only if every objective duty holds; a subjective duty still needs
  `canary accept` in a terminal, and the command says so.

### Added — trust kernel (architecture)

- `authority-envelope.ts` — signing that preserves every key (including
  `__proto__`), refuses accessors, sparse arrays, non-finite numbers and
  documents beyond a bounded depth/size, with the public verifier split out so
  worker-side code can verify without minting.
- `broker.ts` — the authorization kernel: a worker may *request*; only
  controller-held state authorizes. Enrollment pins the subject, digests, duty
  ids and distinct verifier/reviewer keys; receipts bind run, sequence, purpose,
  subject and duties; promotion needs a fresh controller-started window and a CAS
  reservation. It executes nothing.
- `platform-boundary.ts` — the provider contracts plus capability reporting that
  refuses rather than silently downgrading.
- **No installed provider implements any of it**, so the CLI's real paths still run
  on the local sealed store.

### Added — documentation and examples

- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) (per-cell proof status),
  [`docs/CAPABILITY-LEVELS.md`](docs/CAPABILITY-LEVELS.md),
  [`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md),
  [`docs/MIGRATION-1.0-TO-1.1.md`](docs/MIGRATION-1.0-TO-1.1.md),
  [`docs/SPEC-FORMAT.md`](docs/SPEC-FORMAT.md),
  [`schemas/spec.schema.json`](schemas/spec.schema.json),
  [`examples/`](examples/README.md) (Node, Python, Rust, Go, plus the generic
  agent loop), [`CONTRIBUTING.md`](CONTRIBUTING.md), root
  [`SECURITY.md`](SECURITY.md), issue/PR templates and Dependabot.

### Changed

- `canary setup` and `canary doctor` are no longer Node-shaped: they discover
  every ecosystem that declares checks, and a project with no `package.json` is
  set up from its own manifest. `doctor` now distinguishes "nothing here I can
  model" (`UNSUPPORTED`) from "a project is here but not wired" (`NEEDS
  ATTENTION`).
- **Every existing seal stays valid**: `planDigest` adds the new step fields only
  when present, so a 1.0 Node plan hashes exactly as before, and a Node-only
  config written by setup is still byte-shaped like 1.0.
- `status` / `result` / `agents` report the custody level through a **read-only**
  probe (they promise zero writes); `setup` / `doctor` keep the writing
  measurement they are allowed to make.
- Coverage-loss and dependency-manifest predicates now know the other ecosystems'
  conventions (`test_*.py`, `_test.py`, `_test.go`, `_test.rs`, and every
  registered adapter's declared manifests).
- CI: the proof job is no longer gated behind the test matrix (it used to be
  skipped whenever a matrix leg failed), the matrix no longer fails fast, actions
  are pinned by commit SHA, and a tag-driven release workflow builds, checksums,
  attests provenance and uploads the artifact.

### Security

- Trust store hardening: keypair coherence (a mismatched pair used to sign records
  that then read as forged), refusal of symlinked/junctioned/hardlinked key
  material, reserved Windows device names, compare-and-set sequence updates with
  strict record/ledger equality, and a single non-stealing minter lock with a
  bounded wait.
- Capability levels are reported, never inferred. `HARDENED` has no code path that
  could produce it.

## [1.0.0] — 2026-09-10

Initial public release: `canary setup` auto-wiring for Claude Code projects, the
candidate workflow (`task` / `isolate` / `--verify` / `--promote` / `accept`), and
the attested proof pipeline (`run` / `prove` / `check` / `report`) demonstrated on
the committed axios 0.27.2 → 1.0.0 fixture.

Verdict as released: **PASS WITH DOCUMENTED RESIDUALS** — same-UID forgery, PTY
impersonation, test meaning and the other local trust limits remain; skips are not
passes; GitHub-hosted CI is separate from the completed local checks. See
[`docs/RELEASE-1.0-REVIEW.md`](docs/RELEASE-1.0-REVIEW.md) and
[`docs/AUTHORIZATION-1.0.md`](docs/AUTHORIZATION-1.0.md).
