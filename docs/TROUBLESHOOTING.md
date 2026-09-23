# Troubleshooting

Every entry below is a failure that has actually been observed, with the exact
message Canary prints and the smallest thing to do about it. If your problem is
not here, the [issue template](../.github/ISSUE_TEMPLATE/bug_report.md) asks for
the four commands that make a report diagnosable in one round-trip.

**First, always:** `canary doctor`. It runs your project's own checks and prints
the verdict. `canary doctor --json` gives the same answer as one machine-readable
envelope; `--verbose` adds the detail behind any message.

---

## "no supported AI harness detected"

```
NEEDS ATTENTION — no supported AI harness detected (Claude Code and OpenAI
Codex CLI are supported today; others get an explicit message, not a fake
integration).
next: install Claude Code or OpenAI Codex CLI (or open the project inside one),
then run setup again
```

**Why it matters.** Canary verifies completions by running when your agent says
it is done. That requires a harness with a completion hook Canary can install
into. Without one, there is nothing to hook, and Canary refuses rather than
pretending it wired something.

**How it is detected.** The presence of a harness directory — `.claude/` or
`.codex/` in your project, or `~/.claude` / `~/.codex` in your home directory.
Cursor is *detected* and reported as **UNMEASURED**, because this project has not
reproduced its documented hook import on a real install; see
[supported agents](../README.md#supported-agents).

**What to do.** Install Claude Code or OpenAI Codex CLI, or open the project
inside one once, then run `canary setup --yes` again. Canary never fakes this
integration: a repository with no harness stays unwired, and `canary doctor`
keeps saying so. Codex adds one step of its own — the hook it writes is not run
until you review and trust it (`/hooks` in a Codex session) — and `setup` prints
that in plain words rather than letting a written file read as protection.

---

## "this project declares no check Canary recognizes"

```
NEEDS ATTENTION — this project declares no check Canary recognizes — a statement
about what is DECLARED here, not about your stack. Canary reads: Node
package.json scripts (...) ... and the universal contract — a Makefile, Taskfile
or Justfile target, a shipped gradlew or mvnw wrapper, a configured CMake,
Meson, Zig, Swift, Elixir, Crystal, Rake, Composer or PHPUnit project, or a check
your CI configuration already runs.
```

**Why it matters.** Canary runs **your** checks. It does not invent checks, and it
will not authorise proof for a requirement it cannot measure. A project with no
recognizable check has no evidence to offer, so Canary refuses at setup rather
than wiring a gate that can never verify anything.

**What to do.** Point Canary at a check you already have. If you have one and
Canary did not find it, that is a bug worth reporting — the message above lists
everything Canary reads, so if your check is in that list and was missed, say so.

**If the message above it says the check is *ambiguous*:** Canary found two
equally-authoritative candidates and **refused to choose between them** —
choosing would be Canary deciding what your project means. It prints both, with
the evidence for each. Declare the intended one and run setup again.

---

## "your project's own checks did not pass"

```
NEEDS ATTENTION — Canary is wired here, but your project's own checks did not
pass (test, build). That is your project talking, not Canary.
```

**Why it matters.** This is not a Canary failure. The checks you declared are
already failing on the current working tree, which means the gate would block
every completion until they pass. Canary says so at setup instead of letting you
discover it mid-task.

**What to do.** Fix the failing checks (or ask your agent to), then `canary
doctor`. The full runner output is written to disk and its path is printed — read
that file, not the summary.

---

## "NOT PROVEN" — the checks pass, but they cannot tell your change apart

```
NOT PROVEN — the checks passed, but the task is not proven: N objective
obligation(s) have no adequate proof — a green plan is not a proven deliverable
(NO PROOF, NO DONE).
```

**Why it matters.** This is the single most important thing Canary does, and it is
not an error. Canary runs your sealed checks against the **base commit** as well
as your working tree. If they pass on **both** sides, they cannot distinguish your
change from no change at all — so a green suite is not evidence *about your
change*. The verdict is `NOT PROVEN` and the completion is blocked.

**What to do.** Add or point a check at the behaviour you changed, so it **fails
without your change and passes with it**. A pure refactor needs a check that pins
the behaviour you preserved. The repair is the worker's job, and Canary names what
is missing.

Two things this gate never asks: a change touching only checks, prose, licences
or generated files is exempt; and only a human can waive it (`canary accept`,
from a real terminal).

---

## The hook never runs — nothing is ever blocked

**Check the wiring first:** `canary agents`. It reports whether a hook is actually
installed here, and it refuses to call detection "protection":

```
Claude Code — detected, hook NOT installed here
```

**Why it matters.** A harness that is *installed* is not a repository that is
*gated*. If `.claude/` exists but holds no hook, nothing will run at the end of a
turn, and no completion will ever be blocked.

**What to do.** `canary setup --yes`. Then `canary doctor` — "Canary is installed
here but was never executed — protection is wired, NOT yet verified" means setup
wrote the wiring but the smoke run did not happen; `canary doctor` runs it.

**If your harness prompts you to review or trust a hook,** that prompt is real and
you should read it: an untrusted hook does not execute. Canary's hook runs
`canary checkpoint`, which only ever runs your own declared checks and reports.

---

## It works on my machine and is red in CI

This is a documented class of failure in this project, not a mystery. Fixtures and
tests can accidentally encode properties of the **developer's** machine — most
commonly a home directory that has Claude Code installed, which makes
`<root>/.claude` unnecessary. Canary's own CI had exactly this defect, and v1.4
fixed it by making fixtures declare their own harness.

**What to do.** If a test passes locally and fails on a clean runner, check
whether it depends on something in your home directory or on a tool version the
runner does not have. `docs/V1.4-GAP-AUDIT.md` (Gap G) records the five distinct
causes found in this repository and how each was classified.

---

## The Windows CI leg is slow or cancelled

Known and explicit: the GitHub-hosted Windows runner stalls on a handful of
pipeline tests that take 115 ms – 2.2 s on a developer Windows machine and
92 s – 24 min there. This is classified as a **host limitation**, is documented
with its measured profile in `.github/workflows/ci.yml`, and has a budget that
lets the leg run to completion and report a named verdict rather than being
cancelled. No assertion is skipped to make it green.

---

## What to include in a bug report

Four commands, and nothing that contains your source code:

```sh
canary --version
canary status --json
canary doctor --json
canary agents
```

The JSON envelopes name the files that hold the full evidence, so the report
stays small and you do not have to paste logs. Add `--verbose` to any command if
you want the detail behind a message.
