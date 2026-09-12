# Compatibility matrix

What Canary v1.1 supports, and **how each cell was established**. A cell is only
listed as proven when a command actually ran; implemented-but-unproven is a
different, honestly-labelled state. Capability vocabulary:
[`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md).

## The support model: what "supported" means, in four levels

Canary is **language-agnostic at the project contract level**. It does not need to
know a programming language to verify a repository — it needs a plan of commands, an
identity per command, and an honest statement of how much of the run it actually
observed. Those are four different claims, and they are reported separately:

| Level | Question it answers | What holds | Where it lives |
|---|---|---|---|
| **UNIVERSAL** | Can Canary verify a repository of ANY command-driven language? | The project contract itself: argv-based checks (never a shell line), each program PINNED to an absolute path at setup, an explicit and sealed working directory (a scope), the plan sealed and drift-checked, candidate identity bound, and every step's executable identity recorded. Exit status, argv and identity are PROVEN; the runner's INTERNALS are not observed. | `apps/cli/src/universal.ts` — discovery from the repository's own evidence, plus the `canary.project.json` escape hatch |
| **NATIVE** | Does Canary have ecosystem-specific discovery and defaults? | Everything above, plus knowing how an ecosystem declares its checks and what its toolchain needs under the sanitized environment. | **node**, **python**, **rust**, **go** |
| **OBSERVED** | Does Canary watch the runner's own lifecycle instead of reading its text? | A Canary-owned observer loaded INSIDE the runner process, writing frames on a dedicated fd, re-counted by Canary. Printed text becomes refutable rather than authoritative. | **mocha**, **`node --test`**, **pytest**, **`unittest`** |
| **STRONG** | May a strong verdict (PASS / CONFIRMED_REGRESSION / FLAKY / PRE_EXISTING_FAILURE) rest on this run? | An OBSERVED channel AND an authority binding the observed runner to bytes or to an install the operator authorized. | the same four runners — `mocha` (repo pin), `node --test` (the verifying runtime itself), `pytest` and `unittest` (an operator-sealed identity) |

The levels are cumulative in what they PROVE, and deliberately NOT in what they are
allowed to claim: a UNIVERSAL check proves that a command ran, that it was the
authorized program at the authorized path in the authorized directory, and what it
exited with — and it may **never** mint a strong label, because nobody independently
watched the tests. `ctest` is a real tool Canary has no adapter for, so a `ctest`
step is executed, sealed and reported, and its verdict stays `INCONCLUSIVE`.

**What Canary does NOT claim:** that it understands every language, or that a
universal repository is as well observed as a native one. "Unknown ecosystem" means
*generic discovery plus an honest evidence level*, never *unsupported*, and never
*strong*.

## Project ecosystems

| Ecosystem | Detected by | Checks discovered | Toolchain | Status on the authoring host |
|---|---|---|---|---|
| **Node / JS / TS** | `package.json` (+ `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`) | `test`, `typecheck`, `type-check`, `build`, `bench`, `benchmark`, `e2e`, `test:e2e` scripts | npm / pnpm / yarn resolved from the running Node install (never PATH) | **Proven**: this repository's own full unit suite runs through it. No count is quoted here on purpose — a number copied into a document is stale the moment the suite grows; read the reporter summary from the command you ran ([`TEST-COUNTING.md`](TEST-COUNTING.md)) |
| **Python** | `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini`, `Pipfile`, `requirements*.txt` | `pytest` (declared in a config or a dependency), `tox` (`[testenv]` section), `unittest` (a real `tests/`+`test_*.py` layout), and `mypy` / `pyright` / `ruff` as the static-check step | `python` pinned to an absolute path at setup | **Proven end-to-end with a real interpreter**: `apps/cli/test/python-e2e.test.ts` builds a Node-free project, discovers `unittest`, seals the interpreter path, and reaches `READY` via `setup` and `doctor`. Its RUNNER is OBSERVED and STRONG too: `python-wiring.test.ts` (9/9) and `pytest-wiring.test.ts` (8/8) drive real runs through the product's own round path (pytest 9.1.1 from a workspace-local venv, so no global Python state is touched), and the identity comes from the operator's sealed setup plan (`runner-authority.test.ts`, 4/4) |
| **Rust** | `Cargo.toml` (workspace-aware note) | `cargo test`, `cargo check`, and `cargo build` when `src/` exists; `clippy` only when configured (and never twice under one kind) | the **real toolchain binary** pinned to an absolute path at setup | **Proven end-to-end with a real toolchain**: `tooling/probes/rust-project-e2e.mjs` takes a real crate through `setup` and `doctor` (`cargo check`, `cargo test`, `cargo build` all executed under the sanitized environment to READY), then breaks a test and requires the verdict to follow — and it asserts the sealed program is `…/toolchains/<tc>/bin/cargo`, NOT the rustup PATH proxy. That distinction is the fix: the proxy cannot run under the sanitized env (`RUSTUP_HOME`/`HOME` are redirected), so sealing it would seal a step that can never execute. The adapter declares the literal toolchain locations (honoring `RUSTUP_HOME`/`CARGO_HOME`) and setup prefers them. Its runner is NOT observed — stable libtest refuses `--format json`, so there is no per-test event stream — and its verdict therefore stays `INCONCLUSIVE` |
| **Go** | `go.mod`, `go.work` | `go test ./...`, `go vet ./...` | `go` pinned to an absolute path at setup, plus a **workspace-scoped `GOCACHE`/`GOPATH`** the Go adapter declares | **Proven end-to-end with a real toolchain**: `tooling/probes/go-project-e2e.mjs` takes a real Go module through `setup` (sealing an absolute `go` path) and `doctor` (executing `go test ./...` and `go vet ./...` under the sanitized environment and reaching READY), and then breaks a test and requires the verdict to follow. The declaration exists because Go aborted with "build cache is required, but could not be located: GOCACHE is not defined and %LocalAppData% is not defined" once `HOME` was redirected. `go test -json` does emit per-test events, but they are derived from the test binary's own output, so subject code can mint them — a Go verdict therefore stays `INCONCLUSIVE` too |
| **Everything else** (C/C++, C#/.NET, Java/Kotlin, Swift, Zig, PHP, Ruby, Elixir, Crystal, …) | **UNIVERSAL**: the repository's own evidence — CI workflow commands, Makefile / Taskfile / justfile targets, a CONFIGURED CMake+CTest or Meson tree, shipped Gradle/Maven wrappers, `pom.xml`, `build.gradle*`, `*.sln`/`*.csproj`, `Package.swift`, `build.zig`, `phpunit.xml`, `composer.json`, `Rakefile`, `mix.exs`, `shard.yml` | whatever the repository itself states, each check carrying the artifact that anchors it; or exactly what `canary.project.json` declares | every program pinned to an absolute path at setup, exactly like a native plan | **Proven with a real unknown tool**: `apps/cli/test/universal-project.test.ts` (19/19) discovers CMake+CTest checks in a synthetic repository, pins a real tool built with the workspace-local Go toolchain, runs it through `doctor`, fails it, and shows that printed text cannot upgrade the verdict. The feature smoke walks the same path end to end |

The escape hatch, `canary.project.json`, takes **argv arrays and nothing else** — no
shell command strings, no environment (the allowlisted toolchain door belongs to
reviewed adapter code, and a project-supplied `env` is REFUSED rather than merged),
no per-check `cwd` (a working directory is a declared, validated, sealed SCOPE), and
no shell wrappers. Each of those refusals has a test.

**Two ceilings stated rather than implied**, in the same spirit as everything else
here:

- **Executable identity is recorded, not re-verified against a setup-time digest.** The
  authoritative binding is the PINNED ABSOLUTE PATH: setup resolves each program once
  and every later run spawns exactly that path, so nothing a candidate controls can
  re-point which executable runs. Each step result additionally records the resolved
  file's sha256 (`exec.digest`), so REPLACING that file is visible evidence in every
  run — measured: rebuilding the fixture tool with different bytes changes the digest.
  Canary does not, however, refuse a run because the program at the pinned path
  changed; that would be a stronger claim than the code makes, and it is listed here
  rather than assumed away.
- **Runner internals are not observed for a universal check.** The command, its argv,
  its working directory, its exit status and its identity are PROVEN; whether the
  tests inside it really ran is not, which is exactly why the verdict stays
  `INCONCLUSIVE` and no printed summary can change that.

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

### The GATED row, measured rather than assumed

Wiring is not enforcement, so the row above was MEASURED end to end on this host with
`tooling/probes/hook-block-contract.mjs` (Claude Code 2.1.268): a throwaway project gets one `Stop`
hook, the probe sends the same stop input the CLI sends, and it records what the CLI did with each
candidate output shape.

| Output shape | Repair turn? | Reason delivered? | Channel | CLI hook-error notice |
|---|---|---|---|---|
| `{"decision":"block","reason":…}` + exit 0 (**Canary's shape**) | yes | **yes** | user message prefixed `Stop hook feedback:` | 1 (cosmetic) |
| exit 2 with the reason on stderr | yes | yes | user message (stderr text, prefixed with the `[node …]` wrapper) | 1 (cosmetic) |
| exit 2 **and** the JSON block | yes | yes | user message | 1 (cosmetic) |
| `{"continue":false,"stopReason":…}` | **no** | **no** | none | 0 |
| `{"systemMessage":…}` (Canary's loop-guard shape) | no | yes | `system/informational` notice | 0 |
| silent exit 0 (Canary's passing shape) | no | n/a | none | 0 |

Two facts a reader should not have to rediscover: the reason reaches the model, and the CLI logs a
`Stop hook error occurred` notification for EVERY blocking shape — it is a property of blocking on
this version, not of Canary's payload. `continue:false` looks like the documented alternative and is
not one here: it neither repairs nor explains. The probe prints the whole table and asserts the
properties, so it can be re-run when the harness changes rather than trusted from this text.

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
