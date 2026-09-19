# Canary

**Canary is an independent verification layer for coding agents.**

The agent builds. Canary verifies.

> **NO PROOF, NO DONE.**

A coding agent saying "done" is not evidence. A green test suite is useful
evidence — but if those checks **cannot tell your change from the code that was
already there**, they prove nothing about it, and Canary says `NOT PROVEN`.

> *"Cool diff. Prove that it actually made the project better."*

## What Canary does

Install it once in a repository. Then use your coding agent exactly as you
already do.

- It **finds your project's own checks** — the `test` / `typecheck` / `build`
  scripts you already declare, or your ecosystem's own test command — and writes
  nothing you have to maintain.
- When the agent says it is finished, Canary **runs those checks itself**, outside
  the agent's context.
- If they fail — **or if they are green for a reason that has nothing to do with
  the change** — it **blocks the completion** and hands back one short, actionable
  message.
- It also **answers the agent directly** (an MCP tool, registered for you) when the
  agent wants to know whether it is done, so it does not have to re-run your suite
  to find out.

There is no Canary command in the ordinary loop, and you do not have to learn
Canary's vocabulary to use it.

**Why isn't this just "run the tests"?**

| A green suite can be green because… | Canary's answer |
|---|---|
| the same checks were already green **before** the change, so they say nothing about it | proof must **discriminate**: the check has to fail without the change and pass with it, measured against the sealed base commit |
| a **stated requirement** is covered by no check at all | every authorized requirement needs a **sealed proof binding** (`canary bind`), or it stays `NOT PROVEN` |
| "prettier" / "feels faster" was never machine-checkable | subjective duties are a **separate, human act** (`canary accept`, in a terminal) — they can never become a fake technical `PASS` |
| the only evidence is a test **the worker just wrote** | Canary says so out loud, in the verdict (worker-authored-evidence caveat) |

## Install

```bash
npm install -g ./canary-rn-cli-1.2.0.tgz     # Node.js 22 or newer
canary --version                             # canary 1.2.0
```

Download that tarball from the
[v1.2.0 release](https://github.com/criptofn/Canary/releases/tag/v1.2.0) and check
it against the published `.sha256`. It is ONE self-contained bundle with **zero
runtime dependencies**.

> **Honest version note.** `v1.2.0` is the newest *published* artifact. This
> document describes the **source tree**, which is ahead of it — so a few
> behaviours below (the agent-facing instruction, the tool registration, the
> `edit` primitive in the confined worker) are in this repository and not in that
> tarball. Build from source for exactly what is described here:
> `npm ci && npm run build`, then `node apps/cli/dist/src/main.js`. No v1.3
> artifact has been published.

## Use your coding agent normally

```bash
cd your-repo
canary setup --yes      # detect the project, seal its checks, wire your agent
```

That is the whole first-use path. `setup` prints the checks it found, smoke-runs
them once, and ends in `READY` — or tells you exactly what it could not do. It
wires Claude Code automatically (merging with, never overwriting, your existing
hooks), registers Canary's tools for the agent, and touches nothing else.

Then just ask your agent for the change. You do not run anything else.

## What Canary actually catches

This is the behaviour the whole product exists for, and it is measured end to end
by [`tooling/probes/v13-journey-baseline.mjs`](tooling/probes/v13-journey-baseline.mjs)
(section F), which drives the real completion hook:

| your agent changed… | what Canary does |
|---|---|
| behaviour, and some check **fails without the change and passes with it** | allows the completion — the checks are evidence about this change |
| behaviour **no declared check can see** (suite green on both sides) | **blocks** it: `Canary blocked completion: NOT PROVEN — the sealed checks pass on the base commit too, so they carry no evidence about this change (greeting.cjs)` |
| only prose, licences or docs | allows it — no behaviour moved, so nothing is asked to discriminate itself |

That middle row is the point. A green suite that cannot tell your change from the
base is not evidence about your change, and Canary will not let it be reported as
if it were.

## Two minutes, end to end

```bash
cd your-repo
canary setup --yes
```

```
repo: /home/you/your-repo
package manager: npm (package-lock.json found)
verification plan (from what this project already declares — Canary runs only your own checks; change them in their own files):
  ✓ tests: npm run test
harness: Claude Code — hook installed into this project
harness: OpenAI Codex CLI — detected, NOT integrated — no reliable blocking hook exists yet
Claude Code will run Canary automatically when the agent finishes a turn here.
agent tools: registered in .mcp.json — your agent can now ask Canary whether it is done, instead of guessing. Your other MCP servers are untouched; `canary uninstall` removes exactly this entry.

smoke test (running your own project scripts):
✓ tests: npm run test (exit 0)

READY — Canary is active here: it will run these checks whenever the AI agent says it is done, and will interrupt the human only when something needs them.
next: try it: break a test on purpose and let the agent finish — Canary will say so. doctor: canary doctor
```

Then ask your agent for the change, and let it finish. Three things can happen:

1. **Everything is fine** → you hear nothing. Canary is silent when there is
   nothing to say, and the agent's completion is allowed.
2. **A check fails** → the agent is blocked once and told exactly what failed, in
   one short message that names the check and the failing test — with the full
   runner output left **on disk**, not pasted into your conversation.
3. **The change is real but nothing checks it** → blocked as `NOT PROVEN`, with the
   one thing that would prove it. See
   [What Canary actually catches](#what-canary-actually-catches).

At any point, `canary doctor` answers "is Canary really protecting this repo, and
do the checks run?" with `READY` / `NOT PROVEN` / `NEEDS ATTENTION` / `UNSUPPORTED`
and the one command that fixes it. `canary status` answers the same question about
**state** without running anything, and `canary result --json` gives an agent the
same answer compactly and for free.

## Expert mode — when a change must be *proven*, not just green

Not part of the ordinary loop, and **measured to cost more than the everyday path**
(see [the arm map](#what-the-benchmarks-actually-show): the `work` → `finish`
ceremony ran at **177.8 %** of a plain agent's tokens, where the everyday shape ran
at **92.7 %**, with identical correctness). Reach for it when a change needs
evidence rather than a green suite — for example when someone else's work must be
verified before it reaches your branch.

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

**The arm map — which Canary *shape* costs what.** Same three fixtures, same
model, same starting bytes, same hidden oracle, and `canary setup` executed for
**every** arm (`tooling/benchmark/run-trial.mjs`), so Canary is wired in all of
them. What differs is the shape, and one paragraph of instruction:

| task | plain agent | **everyday shape** | ceremony (`work`→`finish`) | confined transport |
|---|---|---|---|---|
| bound-requirements | 126,977 | **105,255** | 200,565 | 20,472 |
| bug-sum | 70,070 | **70,083** | 153,178 | 26,970 |
| stateful-replay | 212,777 | **204,454** | 374,821 | 595,419 |
| **total** | **409,824** | **379,792 — 92.7 %** | **728,564 — 177.8 %** | **642,861 — 156.9 %** |
| correctness | 12/12, 15/15, 406/406 | *same* | *same* | *same* |

Read it this way, because it is the only reading the numbers support:

- **The everyday shape — install once, then use your agent normally — is the only
  configuration cheaper than working without Canary (92.7 %), at equal
  correctness, with no false done.** That is the shape this README describes, and
  the long stateful task does **not** explode on it (17 turns, 96.1 % of plain).
- **The ceremony costs more than it saves** (+77.8 %) with identical correctness,
  which is why it is documented here as expert mode rather than the ordinary path.
- **The confined transport is a trade, not a win**: 2–6× cheaper on short,
  well-specified changes, and much more expensive on the long one.

**No configuration here reached the ≤75 % token target.** The best measured shape
is 92.7 %.

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

## Known limitations

What Canary does **not** claim is as much a part of the product as what it does.

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
- **On the everyday path the agent's own file edits are not confined.** Canary
  gates the *completion* and can refuse it; it does not put Claude Code's native
  tools inside an OS boundary. The confined executor exists (see
  [`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md)) and is driven by
  Canary itself, not by your editor.
- **A completion is blocked at most once per stop.** Canary will not fight the
  harness in a loop: after one repair attempt it reports honestly and lets the
  turn end, so a stubborn failure reaches you instead of spinning.
- **Canary sends nothing anywhere.** There is no telemetry and no network
  dependency; the only measurements are local ones you can read
  (`CANARY_METRICS=<file>` writes one local record per invocation).

Full list: [`docs/RELEASE-1.1.md`](docs/RELEASE-1.1.md) ·
[`docs/V1.3-PRODUCT-AUDIT.md`](docs/V1.3-PRODUCT-AUDIT.md).

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

**Everyday** — what an ordinary user actually types:

```bash
canary setup     [--yes]     # detect the project + the agents, PIN the toolchain, wire, smoke-run
canary doctor                # runs your checks NOW: READY / NOT PROVEN / NEEDS ATTENTION / UNSUPPORTED
canary status                # read-only state, runs nothing: CONNECTED / NEEDS ATTENTION / NOT CONNECTED
canary result    [--json]    # the same state as ONE compact JSON object — free, for agents and scripts
canary agents    [install|uninstall <id>]   # which agents work here, and at what capability
canary mcp                   # MCP server on stdio: the same operations as tools, for any MCP client
canary uninstall             # remove exactly Canary's own changes (recorded strings, never guesswork)
```

**Expert** — the isolated-candidate lifecycle and the proof obligations. Measured
to cost **more** than the everyday path (see the arm map above), and only needed
when a change must be *proven* rather than merely green:

```bash
canary task "<intent>" [--requirement "…"]  # declare the parts that must be proven separately
canary bind <script> --requirement "…"       # the OPERATOR's act: attach a stated requirement to a sealed check
canary work <name> "<intent>"  # register the intent + open an ISOLATED candidate in one step
canary finish <name>         # verify the candidate from outside it, then promote only if the proof holds
canary accept <name>         # close a SUBJECTIVE duty — in a terminal, by a human
canary isolate <name> [--verify|--promote|--list|--remove]   # the primitives work/finish delegate to
canary provider <sub>        # status | install-plan | uninstall-plan | serve | call — the HARDENED provider lifecycle
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
| A Node.js 22+ installation | install `canary-rn-cli-1.2.0.tgz` from the [v1.2.0 release](https://github.com/criptofn/Canary/releases/tag/v1.2.0) (check it against the published `.sha256`), or build it yourself with `node tooling/pack.mjs`, or run straight from a checkout with `node apps/cli/dist/src/main.js` | one self-contained bundle, zero runtime dependencies |
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
