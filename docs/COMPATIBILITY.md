# Compatibility matrix

What Canary v1.1 supports, and **how each cell was established**. A cell is only
listed as proven when a command actually ran; implemented-but-unproven is a
different, honestly-labelled state. Capability vocabulary:
[`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md).

## Project ecosystems

| Ecosystem | Detected by | Checks discovered | Toolchain | Status on the authoring host |
|---|---|---|---|---|
| **Node / JS / TS** | `package.json` (+ `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`) | `test`, `typecheck`, `type-check`, `build`, `bench`, `benchmark`, `e2e`, `test:e2e` scripts | npm / pnpm / yarn resolved from the running Node install (never PATH) | **Proven**: this repository's own full unit suite runs through it. No count is quoted here on purpose — a number copied into a document is stale the moment the suite grows; read the reporter summary from the command you ran ([`TEST-COUNTING.md`](TEST-COUNTING.md)) |
| **Python** | `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini`, `Pipfile`, `requirements*.txt` | `pytest` (declared in a config or a dependency), `tox` (`[testenv]` section), `unittest` (a real `tests/`+`test_*.py` layout), and `mypy` / `pyright` / `ruff` as the static-check step | `python` pinned to an absolute path at setup | **Proven end-to-end with a real interpreter**: `apps/cli/test/python-e2e.test.ts` builds a Node-free project, discovers `unittest`, seals the interpreter path, and reaches `READY` via `setup` and `doctor` |
| **Rust** | `Cargo.toml` (workspace-aware note) | `cargo test`, `cargo check`, and `cargo build` when `src/` exists; `clippy` only when configured (and never twice under one kind) | the **real toolchain binary** pinned to an absolute path at setup | **Proven end-to-end with a real toolchain**: `tooling/probes/rust-project-e2e.mjs` takes a real crate through `setup` and `doctor` (`cargo check`, `cargo test`, `cargo build` all executed under the sanitized environment to READY), then breaks a test and requires the verdict to follow — and it asserts the sealed program is `…/toolchains/<tc>/bin/cargo`, NOT the rustup PATH proxy. That distinction is the fix: the proxy cannot run under the sanitized env (`RUSTUP_HOME`/`HOME` are redirected), so sealing it would seal a step that can never execute. The adapter declares the literal toolchain locations (honoring `RUSTUP_HOME`/`CARGO_HOME`) and setup prefers them |
| **Go** | `go.mod`, `go.work` | `go test ./...`, `go vet ./...` | `go` pinned to an absolute path at setup, plus a **workspace-scoped `GOCACHE`/`GOPATH`** the Go adapter declares | **Proven end-to-end with a real toolchain**: `tooling/probes/go-project-e2e.mjs` takes a real Go module through `setup` (sealing an absolute `go` path) and `doctor` (executing `go test ./...` and `go vet ./...` under the sanitized environment and reaching READY), and then breaks a test and requires the verdict to follow. The declaration exists because Go aborted with "build cache is required, but could not be located: GOCACHE is not defined and %LocalAppData% is not defined" once `HOME` was redirected |

**No check is ever invented.** A directory of `.py` files is not a reason to run
pytest; an ecosystem that declares nothing produces an empty plan, and setup
converts that into `NEEDS ATTENTION`, never `READY`.

### Polyglot

| Layout | Status |
|---|---|
| Several ecosystems declaring checks **at the repository root** (e.g. `package.json` + `pyproject.toml` in one directory) | **Proven** — one composite plan, deterministic order, each step carrying its adapter and scope |
| Ecosystems in **subdirectories**, explicitly declared in `canary.scopes.json` (`web/` Node + `backend/` Python) | **Proven** — the declaration is sealed at setup, and the plan contains EXACTLY the declared scopes plus the root when it declares something. Nothing is discovered by walking, so `archive/`, `examples/` or `vendor/` cannot add a check. A step runs in its own scope directory and with its own scope's package manager, both sealed with the step. An unusable declaration stops setup in full rather than shipping a partial plan |

### Toolchain pinning

At setup — the one human-authorized moment — each explicit program is resolved
**once** and sealed as an **absolute path**. Verification later resolves only
that path, so PATH is never consulted during a check run and nothing a candidate
controls can re-point which executable runs. A program that cannot be found is
refused at setup with a message naming it; it is never silently skipped.

## Agents

| Agent | Capability | How | Verified by |
|---|---|---|---|
| **Claude Code** | **GATED** — a completion can be blocked | `Stop` hook installed by `canary setup`, merged into `.claude/settings.json` without clobbering user entries | the onboarding contract suites (install, idempotent re-setup, uninstall, malformed settings, merged foreign hooks) |
| **OpenAI Codex CLI** | **ADVISORY** — the agent is told and may ignore it | `canary agents install codex` writes a marked, removable block into the project's `AGENTS.md`; the agent is told to consult `canary result --json` / `canary doctor --json` and never to restate its own test output as proof | `apps/cli/test/agents.test.ts` (idempotency, exact removal, foreign content preserved, refusal to write through a link) |
| **Any command-line agent** | **ADVISORY** | the machine-readable protocol: `canary result --json`, `canary doctor --json`, and the expert commands | `apps/cli/test/protocol.test.ts` (one JSON object on stdout, prose on stderr, exit code and status identical without `--json`) |
| **Any CI system** | **ADVISORY** (a non-agent gate) | run `canary doctor` as a build step; it exits non-zero when the sealed checks fail | covered by the `doctor` contract tests |

`canary agents` prints this table for the repository in front of you, with what
was actually detected. An integration that cannot gate is never reported as if
it could.

## Commands

| Command | Promise |
|---|---|
| `setup` / `doctor` / `status` / `result` / `agents` / `uninstall` | the everyday tier: detect, wire, run your own checks, report honestly |
| `checkpoint` / `claim` / `task` | the agent-facing tier: completion boundary, untrusted hints, task intent |
| `work` / `finish` | the ordinary path: register the intent and open the candidate in one step, then verify from outside it and promote only if every objective duty holds. A subjective duty is never closed here — that stays `accept`, in a terminal |
| `isolate` / `accept` | the candidate tier: isolated worktree, obligations, human acceptance, guarded promotion |
| `run` / `prove` / `check` / `report` | the attested pipeline: repeated baseline/candidate execution with a deterministic classification |

## Not supported, and not claimed

- **Subdirectory (nested) ecosystem scopes** — see Polyglot above.
- **Windows device-name, symlink/junction and hardlink attacks on the store** are
  refused, but a same-UID process can still replace the store wholesale: the
  capability is `LOCAL`, never `HARDENED`. See
  [`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md).
- **npm registry install**: the CLI ships as a release tarball; there is no
  `npm install canary` yet.
- **Standalone (Node-free) binary**: **built and executed for win32-x64** via
  `npm run standalone` — one executable with Node embedded, proven by running it
  with every Node directory removed from `PATH`. `--build-sea` embeds the running
  `node` binary, so **linux-x64 and darwin-arm64 must be built and executed on
  those hosts and are NOT claimed from here**. Running Canary no longer requires a
  Node installation for the supported host; a *Node project's* checks still need
  that project's own Node/npm, because Canary runs the project's scripts.
