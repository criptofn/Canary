# Changelog

All notable changes to Canary are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Numbers quoted here come from executed reporter output, per
[`docs/TEST-COUNTING.md`](docs/TEST-COUNTING.md): this file records *what
changed*; the evidence ledgers record *what was observed*.

## [Unreleased] — v1.1 implementation candidate

### Fixed — Rust and Go projects can actually be verified now

Both ecosystems could be discovered, planned and sealed, and then never execute,
because a sealed step runs in a **sanitized** environment that the toolchains did
not survive. Found by measuring them inside Canary's own environment rather than
on a developer shell — the same class as the earlier bare-`git`-inside-a-sealed-step
defect.

- **Go** aborted with `build cache is required, but could not be located: GOCACHE
  is not defined and %LocalAppData% is not defined` (HOME is redirected). Fixed by
  an adapter-declared, workspace-scoped `GOCACHE`/`GOPATH`, injected through a
  narrow, allowlisted door whose path values must resolve inside Canary's
  workspace (`ProjectAdapter.toolchainEnv`).
- **Rust** sealed the rustup PATH PROXY, which cannot choose a toolchain under the
  sanitized env, while the real toolchain binary needs no environment at all.
  Fixed by letting an ecosystem DECLARE its literal toolchain directories
  (`RUSTUP_HOME`/`CARGO_HOME` honored) and having setup prefer them over PATH.
- Both paths now have an executed end-to-end proof, and both are oracle steps:
  `tooling/probes/go-project-e2e.mjs` and `tooling/probes/rust-project-e2e.mjs`
  run a real project through `setup` and `doctor` to READY under the sanitized
  environment, then break a test and require the verdict to follow. The Rust probe
  additionally asserts the SEALED program is the toolchain binary, so a regression
  to PATH-first resolution fails loudly.

### Added — the HARDENED provider (implemented; activation is the owner's)

- **`canary provider status|install-plan|uninstall-plan|serve|call`.** The
  provider is real code: a boundary MEASUREMENT (account, elevation, store
  writers via an `icacls` decision that cannot mistake a read ACE for a write
  grant, the broker service and its account, and what a restricted runner could
  be jailed with), an authenticated IPC transport with a CLOSED operation set
  (unknown fields are refused, so a caller cannot smuggle in a command, path,
  env, key or policy), a broker service that refuses to start without a proven
  separation, and a restricted runner that refuses rather than executing
  candidate code as the broker.
- **`HARDENED` is now DERIVED, not unreachable by construction.**
  `measuredCapabilities` is its only producer and requires EVERY control
  observed available; one missing control keeps the level local. On the current
  host six are unavailable (measured), so `LOCAL` is reported for a measured
  reason and `install-plan` prints the exact privileged steps that would change
  it.
- **A Linux provider path** (users, an inspectable systemd unit, `setfacl`,
  `nft` for egress only if HARDENED is to claim it), contract-tested on this
  host and marked `hostVerified: false` because it has never been executed on
  Linux.

### Added — provider-neutral runner observation

- **The observation validator is channel-neutral.** `validateObservation` takes
  an optional neutral channel (runner id, required version, required runner-bytes
  digest, per-round nonce) and keeps the mocha path byte-for-byte unchanged when
  no channel is named. A neutral round that states no requirement is refused.
- **A real Python observation channel.** Canary's `sitecustomize` bytes on the
  child's `PYTHONPATH` hook `unittest.TestResult` and write the same NDJSON
  frames on fd 3 as the mocha observer. Executed here: a real
  `python -m unittest discover` is WATCHED (3 pass, 1 pending, agreeing with the
  interpreter's own summary), printed text cannot mint counts, and a fabricated
  result is rejected live.
- **Rust and Go channels MEASURED, not assumed**: stable libtest exposes no
  per-test event stream (the compiler refuses `--format json` outside nightly),
  while `go test -json` does and `-exec`/`CARGO_TARGET_*_RUNNER` let Canary own
  the test-binary launch. Both remain `INCONCLUSIVE_ONLY` with the exact blocker
  and the fix named.
- **Workspace-local Rust and Go toolchains** (`tooling/toolchains.mjs`): no
  administrator rights, no global machine change, so "no toolchain" is no longer
  a reason these paths go unmeasured.

### Added — cross-platform distribution

- **Real linux-x64 and darwin-arm64 build paths.** `--list-targets` states which
  target this host can build, a cross-build is REFUSED with the reason, and a CI
  `standalone` job builds and EXECUTES the artifact on ubuntu, macOS and Windows
  (the builder will not report success without running it). `distribution.json`
  records what was built where; the npm tarball remains the platform-neutral
  alternate.

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
