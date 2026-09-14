# Canary

**Canary is an independent verification layer for coding agents.**

The agent builds. Canary verifies.

Its core rule is:

> **NO PROOF, NO DONE.**

A coding agent saying "done" is not evidence. A green test suite is useful
evidence — but if those checks do not prove the change, or do not cover the
stated requirements, Canary reports **NOT PROVEN**.

> *"Cool diff. Prove that it actually made the project better."*

**Why isn't this just "run the tests"?**

| A green suite can be green because… | Canary's answer |
|---|---|
| the same checks were already green **before** the change, so they say nothing about it | proof must **discriminate**: the check has to fail without the change and pass with it, measured against the sealed base commit |
| a **stated requirement** is covered by no check at all | every authorized requirement needs a **sealed proof binding** (`canary bind`), or it stays `NOT PROVEN` |
| "prettier" / "feels faster" was never machine-checkable | subjective duties are a **separate, human act** (`canary accept`, in a terminal) — they can never become a fake technical `PASS` |
| the only evidence is a test **the worker just wrote** | Canary says so out loud, in the verdict (worker-authored-evidence caveat) |

**Canary checks coding-agent work before completion.** Setup connects your coding
agent to the project's own checks. For isolated changes the agent registers the
request, works in a candidate, commits it, and asks Canary to verify and promote.
Explicitly subjective results need your review of the exact clean committed
candidate. Acceptance never replaces objective proof.

New here? → **[`docs/RELEASE-1.1.md`](docs/RELEASE-1.1.md)** is the 2–4 minute
overview of the current release, with links into the deep evidence.

## What's new in v1.1

**1 · Language / project support.** Native discovery and toolchain handling for
**Node / JS / TS**, **Python**, **Rust** and **Go**, plus a **universal
command-driven project contract** that verifies any other ecosystem honestly
about what it actually proved (`canary.project.json`, or discovery from the
commands your CI / Makefile / CMake / Gradle tree already declares).

**2 · Proof discrimination.** The sealed plan is re-run against the **sealed base
commit**. A check that passes on both sides is not evidence about your change —
the verdict is `NOT PROVEN`, not `READY`. A required comparison that cannot be
established (missing module, materialization failure, unavailable execution,
thrown error) is **UNPROVEN — never an accidental PASS**.

**3 · Requirement coverage.** `canary task --requirement "…"` prints each
requirement's digest; the operator's `canary bind <script> --requirement "…"`
attaches it to a check the sealed plan really runs. An objective requirement with
no bound proof stays `NOT PROVEN` — a green plan is not a proven deliverable.

**4 · Candidate workflow.** `canary work` opens an **isolated candidate** from a
frozen base; the worker commits **inside it**; `canary finish` verifies from
outside and **promotes only when the proof holds**, applying the exact verified
committed bytes.

**5 · Subjective acceptance.** Technical proof and human judgment are separate.
Aesthetic or subjective duties cannot be laundered into a technical `PASS`, and a
human acceptance can never close an objective gap.

**6 · Agent support.** Claude Code is **GATED** — a completion hook can block it.
Codex and any other command-line agent are **ADVISORY** (a marked, removable
`AGENTS.md` block that tells the agent what to run and **cannot block anything**
— it says so). `canary mcp` exposes the same operations over MCP for generic
clients. Advisory integrations are never reported as a gate.

**7 · Machine interface.** Global `--json`, `canary result --json` (free — it
writes nothing), and compact failure payloads that name the failing check and
point at the full log **on disk**, so evidence stays outside the model's context.

**8 · Security level.** `LOCAL` is the honest current capability, with documented
same-UID limits. The provider/broker architecture exists, but **`HARDENED` is
reported only when the required OS-level controls are measured present** — it is
not "installation away", and it is not marketed as established isolation.

## 60-second quickstart

1. **Install Canary** (Node.js 22 or newer):

   Download `canary-rn-cli-1.1.0.tgz` from the
   [v1.1.0 release](https://github.com/criptofn/Canary/releases/tag/v1.1.0), then:

   ```bash
   npm install -g ./canary-rn-cli-1.1.0.tgz
   canary --version        # canary 1.1.0
   ```

   The package is ONE self-contained bundle with **zero runtime dependencies**
   (check the download against the published `.sha256`). Prefer source?
   `npm ci && npm run build`, then `node apps/cli/dist/src/main.js`.

2. **In your project** — any supported repo, Node or not:

   ```bash
   cd your-repo
   canary setup      # detect the project + the agents, pin the toolchain, wire, smoke-run
   canary doctor     # run your own checks NOW: READY / NOT PROVEN / NEEDS ATTENTION / UNSUPPORTED
   ```

   That is the whole first-use path. Canary detects your package manager from
   your lockfile and infers a verification plan from the checks your project
   **already declares** — the `test` / `typecheck` / `build` scripts in
   `package.json`, the ecosystem's own test command for Python / Rust / Go, or
   the commands your CI or build files anchor (showing you exactly what it
   picked). It wires itself into Claude Code automatically — merging with, never
   overwriting, your existing hooks — and runs your checks once right there as a
   smoke test.

3. **It worked if it says `READY`.** Unsure at any point later?
   `canary doctor` answers "is Canary really protecting this repo?" with
   READY / NEEDS ATTENTION / UNSUPPORTED and the one command that fixes it.

### The task-aware path (when the work must be *proven*, not just green)

Not part of your first 30 seconds — this is what you reach for when a change
needs evidence rather than a green suite.

```bash
# operator, BEFORE the handoff — declare each stated requirement, then bind it
canary task "make the dialog prettier" --requirement "the button is #D94141"
canary bind e2e --requirement "the button is #D94141"   # attach it to a sealed check
canary setup                                            # re-seal: the binding becomes frozen authority

# worker
canary work fix "make the dialog prettier" --kind ui    # register + open an isolated candidate
#   ...work only inside the candidate directory printed above, then commit THERE...
canary finish fix                                       # verify from outside; promote only if the proof holds
```

**Bind the requirements before you hand off — measured, not stylistic.** In one
benchmark, five requirements that were *declared but never bound* cost the
guarded run **1.5–1.7M tokens and 41–45 turns**, because the worker was left
pursuing a duty only the operator could close. The same five requirements
**bound** to sealed checks came out **cheaper than the unprotected arm** at 100%
delivered correctness (see [what the benchmarks actually show](#what-the-benchmarks-actually-show)).

**What you get after that single command:**

- *automatic* — the agent finishes → Canary runs your checks → all pass:
  total silence (you are not interrupted); a check fails: the agent is
  blocked once and sent back to repair it, and if it still fails, you are
  told in plain words. The automatic hook checks the configured plan; task-aware candidate
  completion also requires registration and isolation.
- *self-healing* — re-run `canary setup` any time; it repairs its own wiring,
  never duplicates a hook, never destroys your edits.
- *reversible* — `canary uninstall` removes exactly Canary's own changes
  (identified by recorded command strings, never by guesswork) and keeps every
  other settings entry (content preserved — re-serialization may reformat
  whitespace). If cleanup can't fully succeed it keeps its ownership record so
  the advertised retry actually works.

**Supported today.** Canary discovers the checks your project already declares —
and it never invents one:

| Project | Discovered from | Checks |
|---|---|---|
| Node / JS / TS | `package.json` (+ its lockfile) | `test`, `typecheck`, `build`, `bench`, `e2e` scripts |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini`, `requirements*.txt` | `pytest`, `tox`, `unittest`, plus `mypy` / `pyright` / `ruff` |
| Rust | `Cargo.toml` | `cargo test`, `cargo check`, `cargo build` |
| Go | `go.mod`, `go.work` | `go test ./...`, `go vet ./...` |
| **Any other command-driven project** | the executable truth you already declare — CI workflow commands, `Makefile` / `Taskfile` / `justfile` targets, CMake+CTest or Meson, a shipped `gradlew` / `mvnw`, `pom.xml`, `build.gradle*`, `*.sln` / `*.csproj`, `Package.swift`, `build.zig`, `phpunit.xml`, `composer.json`, `Rakefile`, `mix.exs`, `shard.yml` — or your own `canary.project.json` (argv arrays, never a shell line) | those commands, **sealed and pinned** to absolute paths, verified as **UNIVERSAL**: the command really ran, with that exit status, bound to the candidate's bytes — but the runner's internals were **not** observed |

Agents are reported by what they can actually do, not by what we wish they could:

| Agent | Capability |
|---|---|
| Claude Code | **GATED** — `canary setup` installs a completion hook, so a failing check blocks the agent |
| Codex, and any command-line agent | **ADVISORY** — `canary agents install codex` adds a marked, removable block to `AGENTS.md` telling the agent to consult `canary result --json`; it cannot block anything, and it says so |

`canary agents` prints that table for the repository in front of you. Security
capability is reported the same way: **`LOCAL`** is what this build can honestly
claim today, and `HARDENED` is not available yet
([why](docs/CAPABILITY-LEVELS.md), and
[what a real boundary would require](docs/TRUST-ARCHITECTURE.md)). Full matrix,
including what is deliberately *not* supported:
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). Upgrading an existing
installation: [docs/MIGRATION-1.0-TO-1.1.md](docs/MIGRATION-1.0-TO-1.1.md).

**What `READY` means — and what it does not.** READY is printed only when
Canary's wiring was verified to exist *and* your detected checks were
actually executed and passed in that run. Nothing executed → NEEDS
ATTENTION, never a fake green. This auto-watched plan runner is the everyday
path; the much stronger **attested proof pipeline** (`canary prove` /
`canary check`, below) is a separate, different promise for release-grade
claims.

## What the benchmarks actually show

Short version, with the full ledgers linked below — and stated the way the
evidence supports it:

**This corpus did NOT demonstrate a general correctness advantage for Canary.**
On the consolidated 13-fixture matrix the plain model already hit a ceiling:
**36/36 delivered correct**, with zero false dones and zero false greens in
*both* arms. What the measurements do show is a **token** effect that depends
entirely on whether the operator bound the requirements:

| Configuration (one benchmark, one model, one host) | Measured result |
|---|---|
| 13 fixtures, **no declared proof** (`bench-final`) | plain **36/36** correct · `guarded` **33/33** correct · 0 false dones, 0 false greens in both arms · `guarded` **+40.2%** tokens |
| requirements declared **and BOUND** to sealed checks (`bench-r11`) | plain 125,369 tokens → `guarded` **100,812 (−19.6%)**, `invisible` 91,439 (**−27.1%**) · **5/5 correct in every arm**, 0 false dones, 0 false greens |
| requirements declared and **NOT bound** (`bench-r9`) | `guarded` **1.5–1.7M tokens over 41–45 turns** — the worker pursuing a duty only the operator can close |

**The safe claim is exactly this:** *in one bound-requirement benchmark, Canary
reduced model-token use by 19.6% while maintaining 100% delivered correctness.*
It is **not** "Canary saves 19.6% of tokens", it is **not** a correctness claim,
and it is **not** a universal result. An earlier configuration measured −58.5%
tokens with correctness unchanged (`bench-r6`); that is a **historical
configuration result**, not the v1.1 headline. A −56.4% configuration
(`bench-r5`) is explicitly **rejected as a default** because it lost one
delivered-correct result and produced a false green. **Reliability outranks
token savings.**

Numbers, denominators and the counter-examples: [`tooling/benchmark/RESULTS.md`](tooling/benchmark/RESULTS.md) ·
what the set can and cannot tell you: [`tooling/benchmark/BENCHMARKS.md`](tooling/benchmark/BENCHMARKS.md) ·
the consolidated matrix and its three corrected defects: [`docs/V1.1-STATUS.md`](docs/V1.1-STATUS.md) ·
**v1.2's false-done corpus and its result — which is that no correctness advantage was demonstrated**:
[`docs/V1.2-BENCHMARK.md`](docs/V1.2-BENCHMARK.md).

> **The v1.2 result, in one line, so it cannot be missed:** five fixtures were authored for the failure
> classes v1.1 had no coverage of. In the configuration the harness accepts, the guarded arm was
> **correct on all seven fixtures measured** — the completion path works end to end — and it cost **more
> than the bare agent on every one of them**, by an amount that depends heavily on the task: **+3.2% to
> +408.7%**, with four paired fixtures totalling **+115.1%** (539,419 → 1,160,170 tokens). **The plain
> agent was correct in every trial; no correctness advantage was demonstrated, and Canary's own KPI
> reads FAILS THE TOKEN REQUIREMENT.** The three measured reasons the corpus cannot show an advantage,
> and the caveats that limit each number, are in that document.

## Known limitations (v1.1)

- **`LOCAL` is not an OS isolation boundary.** A same-UID worker can replace the
  local root of trust; those limits are documented, not papered over
  ([`docs/CAPABILITY-LEVELS.md`](docs/CAPABILITY-LEVELS.md)).
- **`HARDENED` is not available in this release.** The provider/broker
  architecture exists and refuses to serve without a proven separation, but
  `HARDENED` is only ever produced by a boundary **measurement** in which every
  control is observed present (`canary provider status`).
- **A bound check is declared proof coverage inside Canary's model — not
  semantic truth.** Binding a requirement to a sealed check says the plan
  measures something for it; Canary does not thereby *understand* the
  requirement.
- Canary does **not** claim to "never fail open" universally, nor that every
  promoted change is independently **semantically** proven.
- Claim strength is tiered: only the observed runners (`mocha`, `node --test`,
  `pytest`, `unittest`) bound to an authority can carry a strong verdict; an
  unknown runner is `INCONCLUSIVE_ONLY` by construction, and printed text never
  upgrades a verdict.
- `NOT PROVEN`, `NEEDS ATTENTION`, `UNSUPPORTED`, `INCONCLUSIVE` and `BLOCKED`
  are first-class outcomes — and **a skip is not a pass**.

Full list: [`docs/RELEASE-1.1.md`](docs/RELEASE-1.1.md).

---

## For the proof-minded: what Canary fundamentally is

Canary takes a **baseline** state and a **candidate** change, runs relevant
deterministic checks against both in disposable, sanitized (process/env-boundary
enforced) workspaces, reproduces any divergence, and emits a
**machine-readable Evidence Bundle** with a **deterministic classification**.
Only after that may an LLM explain the evidence — the LLM can never render the
verdict.

```
Classification ∈ PASS | CONFIRMED_REGRESSION | PRE_EXISTING_FAILURE
                 | FLAKY | INFRASTRUCTURE_FAILURE | INCONCLUSIVE
```

Canary is an orchestrator, not a re-implementation of your toolchain: real
test frameworks are the evidence engines (RepoWise, Semgrep, CodSpeed,
Playwright, … may later feed evidence behind optional adapters — the core
runs with zero integrations).

## The dependency proof pipeline

A controlled, historical verification domain: the dependency update
**axios 0.27.2 → 1.0.0**, judged by a *real* downstream project's *real*
test suite — `ctimmerm/axios-mock-adapter` pinned at commit
`b8804442` (its own devDep was exactly `axios ^0.27.2`).

What Canary reproduces on demand, from scratch each time:

```
baseline  axios 0.27.2  →  128 passing, 0 failing        (exit 0) ×2
candidate axios 1.0.0   →  125 passing, 3 failing        (exit 3) ×3 unanimous
tree drift              →  confined to axios subtree     (2 entries, verified; re-derived from retained npm-ls snapshots)
normalized output       →  byte-identical per arm, across rounds AND runs ON THE PROOF HOST (host-exact assertions
                           are gated on the actual runtime; off-host the proof honestly reports INCOMPLETE)
classification          →  CONFIRMED_REGRESSION (rule 5) — pure function, no LLM
failing tests           →  "can pass headers to match to a handler" (AxiosHeaders),
                           "handles baseURL correctly" (URL resolution) — genuine
                           axios 1.0.0 behavior changes this project depended on
```

Reproduce it:

```bash
npm ci            # lockfile-exact, reproducible install
npm run build
npm test          # 1072 tests / 0 failures (offline; symlink-dependent tests skip only when the OS denies link creation)
npm run prove     # fresh end-to-end run; PASS requires the committed proof host (36 assertions
                  # executed, zero skips). On any other runtime it honestly exits 2 (INCOMPLETE):
                  # the 22 portable assertions must all hold, the 6 host-exact ones are skipped,
                  # never silently passed.
npm run report    # no args: renders the latest run's evidence. Exit 0 means SELF-CONSISTENT:
                  # byte + run-identity + tree-snapshot + classification re-derivation checks
                  # passed ON THIS MACHINE — it does NOT mean the committed proof was consulted
                  # (that is prove/check; round-4 F1). Otherwise NOT SELF-CONSISTENT, exit 3.
```

Also demonstrated by this fixture: **Canary does not manufacture
regressions.** An earlier candidate (axios-cookiejar-support @ f1e045d4)
came back PASS — honestly reported, ledger in
[`fixtures/axios-0.27-to-1.0/README.md`](fixtures/axios-0.27-to-1.0/README.md).

## CLI

The two tiers share one binary; `canary` below is the linked command, or
`node apps/cli/dist/src/main.js` straight from a checkout.

Everyday automatic path (the quickstart above):

```bash
canary setup     [--yes]     # detect the project + the agents, PIN the toolchain, wire, smoke-run
canary doctor                # runs your checks NOW: READY / NOT PROVEN / NEEDS ATTENTION / UNSUPPORTED
canary status                # read-only state, runs nothing: CONNECTED / NEEDS ATTENTION / NOT CONNECTED
canary result    [--json]    # the same state as ONE compact JSON object — free, for agents and scripts
canary agents    [install|uninstall <id>]   # which agents work here, and at what capability
canary task "<intent>" [--requirement "…"]  # OPTIONAL: declare the parts that must be proven separately
canary bind <script> --requirement "…"       # the OPERATOR's act: attach a stated requirement to a sealed check
canary work <name> "<intent>"  # the ORDINARY path: register the intent + open the candidate in one step
canary finish <name>         # verify the candidate from outside it, then promote if the proof holds
canary mcp                   # MCP server on stdio: the same operations as tools, for any MCP client
canary provider <sub>        # status | install-plan | uninstall-plan | serve | call — the HARDENED provider lifecycle
canary uninstall             # remove exactly Canary's own changes (recorded strings, never guesswork)
canary checkpoint            # harness-internal: runs at the agent's completion boundary (Stop hook)
```

`canary provider status` MEASURES the boundary rather than asserting it: which
account this process is, whether the store can be written by a worker identity,
whether a broker service exists and as which account, and what a restricted
runner could actually be jailed with. `HARDENED` appears only when every one of
those controls is observed available. `canary provider install-plan` prints the
exact privileged steps (creating the identities, installing the service,
rewriting the store's ACL, and the rollback) and executes none of them — routine
Canary use after activation needs no elevation, because the service holds the
privileged identity, and the broker never executes candidate code with it.

`canary mcp` speaks the Model Context Protocol on stdio so a generic agent can
drive Canary without a bespoke integration. It is a **transport, not a second
authority**: every tool runs the same CLI and relays its verdict and exit code
unchanged, no tool takes an argument that could influence a verdict, and
`canary accept` is deliberately not exposed — acceptance is a human act in a real
terminal, so a machine channel must not be able to reach it.

### More than one ecosystem in one repository

A repository whose checks live in subdirectories — `web/` Node, `backend/`
Python, `service/` Go — declares them once, at the root:

```json
{ "schema": "canary-scopes/1",
  "scopes": [ { "path": "web", "ecosystem": "node" },
              { "path": "backend", "ecosystem": "python" },
              { "path": "service", "ecosystem": "go" } ] }
```

`canary.scopes.json` is **sealed** by `setup` like every other declaration. What
is declared is what counts: nothing is discovered by walking, so an undeclared
`vendor/`, `archive/` or `examples/` tree can never add a check to your plan. A
declaration Canary cannot honour stops setup instead of shipping a partial plan.

### Any language — the universal project contract

Canary is **language-agnostic at the project contract level**. It does not need to
know your build system to verify your repository, and you do not need to know
Canary's adapter model to use it:

```sh
cd your-repo && canary setup
```

`setup` reads the project's **existing, executable truth** — the commands in your CI
workflows, your `Makefile` / `Taskfile` / `justfile` targets, a configured
CMake+CTest or Meson build tree, a shipped `gradlew`/`mvnw` wrapper, `pom.xml`,
`build.gradle*`, `*.sln`/`*.csproj`, `Package.swift`, `build.zig`, `phpunit.xml`,
`composer.json`, `Rakefile`, `mix.exs`, `shard.yml` — and proposes the plan those
artifacts anchor. Every proposed check says which artifact anchors it. Nothing is
guessed: a command with no anchor is not proposed (setup reports `NEEDS ATTENTION`
instead of inventing one), and if two equally-anchored interpretations exist, Canary
asks **one** concise question rather than picking for you. The plan is then pinned
(every program sealed to an absolute path), sealed and drift-checked exactly like a
native one.

If discovery cannot see your commands, state them yourself — argv arrays, never a
shell line:

```json
{ "schema": "canary-project/1",
  "scopes": [ { "path": ".",
                "checks": [ { "name": "build", "kind": "build", "argv": ["cmake", "--build", "build"] },
                            { "name": "tests", "kind": "tests", "argv": ["ctest", "--test-dir", "build"] } ] } ] }
```

`canary.project.json` refuses a project-supplied environment and a per-check `cwd`
(a working directory is a declared scope, which is validated and sealed), refuses
shell wrappers, and can never name Canary's own `$` tokens.

**What that buys, stated exactly.** Four levels, reported separately:

| Level | Meaning |
|---|---|
| **UNIVERSAL** | Any command-driven project: the command really ran, at the authorized absolute path, in the authorized sealed directory, with that exit status, bound to the candidate's bytes — **and the runner's internals were not observed**. |
| **NATIVE** | Canary has ecosystem-specific discovery and toolchain handling: **node**, **python**, **rust**, **go**. |
| **OBSERVED** | Canary watched the runner's own lifecycle from inside the process: **mocha**, **`node --test`**, **pytest**, **`unittest`**. Printed text becomes refutable. |
| **STRONG** | A strong verdict may rest on it: the observed runners above, each bound by an authority (a repo pin, the verifying runtime itself, or an operator-sealed identity). |

An unknown runner is `INCONCLUSIVE_ONLY`, by construction — so a universal check can
verify a build, a lint or a test command honestly and can **never** turn printed
output into a strong verdict. Canary does not claim to understand every language; it
claims to verify any command-driven project honestly about what it proved. See
[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

Every command accepts `--json`: the human prose moves to stderr and stdout
carries exactly one versioned object (`{"schema":"canary-status/1", …}`). Exit
codes and status words are identical with and without the flag — asking for JSON
never changes a verdict, and the envelope names the files evidence lives in
instead of pasting logs into an agent's context.

`setup` / `doctor` never print READY without having executed the detected
checks and seen them pass *in that same invocation* — `doctor` runs the plan
every time it is called, so a stored or hand-edited record can never produce a
green answer; re-running `setup` heals its own wiring idempotently; nothing
about this tier claims the attested-proof strength of the commands below — it
is a transparent plan runner over *your* scripts.

**A green plan is not a proven task.** `doctor` answers `NOT PROVEN` (exit 2)
and the Stop hook blocks the completion in two cases the old READY hid: when a
stated requirement is registered but no sealed check covers it (bind it in
`package.json` `canary.proofs`, or a human accepts it in a terminal), and when
the sealed checks pass on the base commit too — i.e. they cannot tell your
change from no change, so they carry no regression evidence for it. The repair
is to make the proof discriminate: a check that fails without the change and
passes with it. Only a human can waive either duty, and `canary accept` does
that, in a terminal.

Release-grade proof pipeline:

```bash
canary run    <spec.json>   # execute, write evidence
canary prove  <spec.json>   # re-run + assert expectations
canary check  <spec.json>   # assert last run's evidence
canary report [evidence.json] [out.html]  # defaults: latest run
canary version
```

### Installing, updating and removing Canary

Three ways to get it, in increasing order of what you must already have:

| You have | Use | Result |
|---|---|---|
| A Node.js 22+ installation | install `canary-rn-cli-1.1.0.tgz` from the [v1.1.0 release](https://github.com/criptofn/Canary/releases/tag/v1.1.0) (check it against the published `.sha256`), or build it yourself with `node tooling/pack.mjs`, or run straight from a checkout with `node apps/cli/dist/src/main.js` | one self-contained bundle, zero runtime dependencies |
| No Node.js, and a supported host | `npm run standalone` (see `tooling/standalone.mjs`) | ONE executable with Node embedded |
| A source checkout | `npm ci && npm run build` | the development tree |

`tooling/standalone.mjs` builds for **the host it runs on** and then executes the
artifact with every Node directory removed from `PATH` before it reports success,
so the result is a measured fact rather than a build log. It writes the artifact,
its sha256 and the observed runs under `pack/standalone/`. `--build-sea` embeds
the running `node` binary, so a Linux or macOS artifact must be built and executed
*on* Linux or macOS; no other target is claimed from here.

- **Install**: copy the single executable into a directory of its OWN and put it
  on `PATH`. The directory matters: Canary fingerprints its own bytes as the
  verifier's code, and under a single-executable build that is the file itself —
  a directory shared with unrelated files would make unrelated edits look like
  verifier tampering.
- **Update**: replace the executable, then re-run `canary setup --yes` in each
  wired repository. The plan and its seal are re-derived; nothing about the old
  binary is trusted afterwards. Upgrading an existing 1.0 installation is
  documented separately in [`docs/MIGRATION-1.0-TO-1.1.md`](docs/MIGRATION-1.0-TO-1.1.md).
- **Uninstall**: `canary uninstall` in each wired repository removes exactly
  Canary's own recorded changes (hook entries, config, its own ignore line) and
  refuses to delete `.canary` while candidates exist; then delete the executable.
  Both directions are exercised end to end by the feature smoke.

Note what a standalone build does *not* change: a **Node project's** checks still
need that project's own Node/npm to run, because Canary runs *your* scripts. The
standalone build removes Node as a requirement for **running Canary** — which is
what makes Canary usable on a Python, Rust or Go project that has no Node at all.

Exit codes: `0` proof holds fully (on the committed proof host) / regression
confirmed / self-consistent report / onboarding READY · `1` a proof assertion
diverged (or `run` classified PASS) · `2` other classification / infra /
proof INCOMPLETE (this runtime is not the proof host — host-exact assertions
unverifiable, never a PASS pretense) / onboarding NEEDS ATTENTION or
UNSUPPORTED · `3` misuse, refused bundle, or a NOT-SELF-CONSISTENT report.

## Security contract — enforced at the process/env boundary, tiered elsewhere

Every downstream repository is **untrusted**. Enforced by
`@canary-rn/support` + `@canary-rn/workspace` on every run
([`docs/SECURITY.md`](docs/SECURITY.md), which tiers every claim):

- content fetched **by pinned 40-hex commit SHA** only (tarballs, no git auth)
- **pre-execution audit gate**: refuses repos with install lifecycle hooks
  or shipped `.npmrc`/`.yarnrc` (case-insensitively, recursively) —
  registry-injection vectors
- **allowlisted child environment** — Anthropic/GitHub/cloud credentials,
  `NODE_OPTIONS`, SSH agents, user npm auth are *structurally invisible*
  to external processes (deny-by-omission); Windows session-identity vars the
  OS loader injects are *neutralized* so observed == declared (proven by test)
- `--ignore-scripts` on every install — semantically un-losable: package
  managers run only through **closed allowlists at three levels** (executable,
  subcommand, and since round-4 RB-1, exact option spellings — npm's
  abbreviations, negations and last-wins ordering make textual denylists
  bypassable, so Canary's isolation flags are appended as the argv *suffix*
  and npm's own last-wins makes them the effective config); raw
  `npm`/`npm-cli.js` forms, wrapper-mediated execution and `--`-bypass shapes
  are rejected (audits B5/B5.1, round-4 RB-1); disposable workspace under
  `.canary-runs/`; caches and HOME redirected inside
- **evidence is bound to reality, not just self-consistent** (audit B1–B4,
  round-4 RB-2/M-1, independent-audit A+B): failing-test identities are suite-qualified
  (no leaf-title collapse); a zero-test / no-summary / infra-at-exit-0 run can
  never become PASS; **suite collapse is never a verdict** — strong verdicts
  require stable-across-repetitions and comparable-across-arms test-execution
  coverage, and "comparable" includes failing-set containment (a candidate
  failure the baseline never saw fail is never "pre-existing"; classifier
  rules 12/13 + an independent validator gate); **a
  strong verdict additionally requires that Canary WATCHED the execution** —
  a byte-pinned runner with a Canary-injected in-process observer, whose
  private-channel lifecycle counts agree with the text summary on every round
  (rule 14; `node -e "console.log('128 passing (1s)')"` → INCONCLUSIVE, never
  PASS — [docs/EXECUTION-AUTHORITY.md](docs/EXECUTION-AUTHORITY.md)); every
  artifact path is derived from its round (traversal/ownership rejected) and
  confined to the run dir; a manifest digest makes single-field rewrites
  detectable; the bundle's structural floor and the published JSON schema are
  **one generated contract** (`packages/evidence/schema/src/contract.ts`);
  and `prove`/`check`/`report` re-derive each round's summary, counts,
  failing-test identities and execution observation **from the artifact
  bytes**, so the bundle cannot lie about what it recorded — and what it
  recorded can only carry strength if the observation channel backs it
- no publish, no push, no external auth, ever
- if a *Tier-A (code-enforced)* bound can't hold: `INFRASTRUCTURE_FAILURE`,
  before executing

**What 1.0 does NOT claim** (read the tiered section): there is no filesystem
jail and no network egress allowlist — a fixture's own test code runs with the
operator's OS permissions. The evidence manifest is tamper-*evidence* /
cross-field integrity, **not authenticated provenance** (no signing key /
external trust root); a forger who controls the whole file recomputes it, which
is exactly why the byte re-derivation, the execution-observation channel (an
integrity bound, not a trust root — its exact ceilings are stated verbatim in
docs/EXECUTION-AUTHORITY.md §7–8) and the committed proof do the real binding.
Isolation is real at the process/environment boundary and a deliberate
best-effort convention beyond it.

## Layout

```
apps/cli/                       run / prove / check / report
packages/core/                  planner · comparator · classification (pure, tested)
packages/runner/                executor · workspace · environment (security + isolation)
packages/evidence/              normalizers · hashing · schema · report
packages/registry-npm/          (reserved — npm resolution adapter, next milestone)
packages/github/                pinned-SHA tarball fetch
packages/ai/                    optional explain-only adapter (noop shipped)
fixtures/axios-0.27-to-1.0/     golden fixture: spec + committed proof expectations
schemas/evidence.schema.json    published evidence contract (GENERATED from packages/evidence/schema/src/contract.ts — the single source of truth)
docs/                           ADR-001 · PLAN · SECURITY · EXECUTION-AUTHORITY · RELEASE-1.1
                                V1.1-STATUS · CAPABILITY-LEVELS · TRUST-ARCHITECTURE
                                AUTHORIZATION-1.0 · COMPATIBILITY · MIGRATION-1.0-TO-1.1
                                TEST-COUNTING · SPEC-FORMAT
tooling/benchmark/              BENCHMARKS (method) · RESULTS (per-configuration ledgers)
archive/python-golden-prototype/ superseded first prototype (concepts preserved in TS)
archive/prototype-scripts/      superseded M0/ladder harnesses (now the CLI)
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
