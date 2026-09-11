# Examples

Four minimal projects — one per ecosystem Canary supports — plus the generic
agent loop. Each example contains nothing but a declared check and the code that
check exercises, so what Canary discovers is visible at a glance.

| Example | What Canary discovers | Needs |
|---|---|---|
| `node-mini/` | `test` (a `package.json` script) | Node 22+ |
| `python-mini/` | `unittest` (discovered from the `tests/` layout; the `pyproject.toml` declares no test tool) | Python 3.8+ |
| `rust-mini/` | `cargo test`, `cargo check`, `cargo build` | a Rust toolchain |
| `go-mini/` | `go test ./...`, `go vet ./...` | a Go toolchain |
| `generic-agent/` | nothing — it is the loop an agent runs | a wired project |

## Run one

**Copy the example out of this repository first, and `git init` it.** Canary
operates on a git repository, and here that would be *this* repository — a
directory inside a repo resolves to the repo root as the project, which is not
what you want to demonstrate.

```sh
cp -r examples/python-mini /tmp/python-mini && cd /tmp/python-mini
git init -b main && git add -A && git commit -m "example"
canary setup --yes     # discovers `unittest`, pins the interpreter, smoke-runs it
canary doctor          # runs the sealed check again and reports the verdict
canary result --json   # the same state, as one compact object
```

Then break it on purpose — change `add` to return `a - b` — and run `canary
doctor` again. The verdict stops being `READY`, which is the whole point.

## The generic agent loop

`generic-agent/agent-loop.mjs` is the entire integration contract for an agent
that has no hook: ask Canary what it knows, then ask it to run the checks, and
read the compact answer.

```sh
# from a checkout, where `canary` is not on PATH:
CANARY_CLI="$PWD/apps/cli/dist/src/main.js" node examples/generic-agent/agent-loop.mjs /tmp/python-mini
```

It exits with `doctor`'s exit code, so it doubles as a CI step. It cannot mint a
verdict — it only reports the one Canary decided.

## Why examples cannot change this repository's own plan

Canary discovers checks at a project's **root** only. Nested scopes (a `web/` or
`backend/` subdirectory) need an explicit declaration, precisely so that a
directory like `examples/` or `archive/` cannot silently add checks to the
project that contains it — see the polyglot section of
[`docs/COMPATIBILITY.md`](../docs/COMPATIBILITY.md).

## Verified, not asserted

`tooling/probes/examples-smoke.mjs` copies `node-mini` and `python-mini` into
temporary git repositories, sets them up and re-verifies them through the real
CLI. It is part of the productization matrix. The Rust and Go examples are
compiled and tested by their own toolchains, which are **not** present on every
host: they are shipped as the smallest correct project for those ecosystems, and
the probe says plainly when it could not execute them here.
