# Compatibility matrix

What Canary v1.1 supports, and **how each cell was established**. A cell is only
listed as proven when a command actually ran; implemented-but-unproven is a
different, honestly-labelled state. Capability vocabulary:
[`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md).

## Project ecosystems

| Ecosystem | Detected by | Checks discovered | Toolchain | Status on the authoring host |
|---|---|---|---|---|
| **Node / JS / TS** | `package.json` (+ `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`) | `test`, `typecheck`, `type-check`, `build`, `bench`, `benchmark`, `e2e`, `test:e2e` scripts | npm / pnpm / yarn resolved from the running Node install (never PATH) | **Proven**: this repository's own 727-test suite runs through it |
| **Python** | `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini`, `Pipfile`, `requirements*.txt` | `pytest` (declared in a config or a dependency), `tox` (`[testenv]` section), `unittest` (a real `tests/`+`test_*.py` layout), and `mypy` / `pyright` / `ruff` as the static-check step | `python` pinned to an absolute path at setup | **Proven end-to-end with a real interpreter**: `apps/cli/test/python-e2e.test.ts` builds a Node-free project, discovers `unittest`, seals the interpreter path, and reaches `READY` via `setup` and `doctor` |
| **Rust** | `Cargo.toml` (workspace-aware note) | `cargo test`, `cargo check`, and `cargo build` when `src/` exists; `clippy` only when configured (and never twice under one kind) | `cargo` pinned to an absolute path at setup | **Implemented and unit-tested, not executed end-to-end**: no `cargo` on the authoring host. Requires `cargo` on PATH at setup |
| **Go** | `go.mod`, `go.work` | `go test ./...`, `go vet ./...` | `go` pinned to an absolute path at setup | **Implemented and unit-tested, not executed end-to-end**: no `go` on the authoring host. Requires `go` on PATH at setup |

**No check is ever invented.** A directory of `.py` files is not a reason to run
pytest; an ecosystem that declares nothing produces an empty plan, and setup
converts that into `NEEDS ATTENTION`, never `READY`.

### Polyglot

| Layout | Status |
|---|---|
| Several ecosystems declaring checks **at the repository root** (e.g. `package.json` + `pyproject.toml` in one directory) | **Proven** — one composite plan, deterministic order, each step carrying its adapter and scope |
| Ecosystems in **subdirectories** (`web/` Node + `backend/` Python) | **Not yet wired.** The walk exists and is tested (`discoverScopes`), but it is deliberately not the default: a sealed plan must not gain checks from a directory the user does not consider part of the project — this repository's own `archive/python-golden-prototype/pyproject.toml` is the example. Enabling it needs an explicit declaration |

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
- **Standalone (Node-free) binary**: Canary is a Node.js program. A Python or
  Rust *project* needs no `package.json`, but running Canary itself still needs
  Node 22+ on the machine.
