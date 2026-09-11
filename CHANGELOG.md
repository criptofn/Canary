# Changelog

All notable changes to Canary are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Numbers quoted here come from executed reporter output, per
[`docs/TEST-COUNTING.md`](docs/TEST-COUNTING.md): this file records *what
changed*; the evidence ledgers record *what was observed*.

## [Unreleased] — v1.1 implementation candidate

**Not released, not tagged.** Two things bound every entry below: `HARDENED` is
still unreachable (no provider with a separate OS identity is installed — see
[`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md)), and the
productization oracle still reports six pre-existing host-bound probe failures
(see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

### Added — projects

- **Python, Rust and Go adapters** behind the existing `ProjectAdapter` contract:
  discovery from a project's own declarations (pyproject/setup.cfg/tox.ini/
  requirements/Pipfile; Cargo.toml; go.mod/go.work), never invented. A directory
  of `.py` files, or a tool named only in a comment, declares nothing.
- **Deterministic polyglot composition** across ecosystems that declare checks at
  a repository root, with each step carrying its adapter and scope. Nested scopes
  are deliberately not discovered by default, so an `archive/` or `examples/`
  directory cannot silently add checks to the project containing it.
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
