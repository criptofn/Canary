# Canary

Canary is an independent verification layer for software changes.

It is designed especially for coding-agent workflows, where generated changes
should be verified before they are treated as complete.

> *"Cool diff. Prove that it actually made the project better."*

**Canary checks coding-agent work before completion.** Setup connects
your coding agent to the project's own checks. For isolated changes, the agent
registers the request, works in a candidate, commits it, and asks Canary to
verify and promote. Explicitly subjective results need your review of the
exact clean committed candidate. Acceptance never replaces objective proof.

See [the 1.0 authorization contract](docs/AUTHORIZATION-1.0.md) for task identity,
numeric proof bindings, input limits, and the remaining local trust boundaries.

## 60-second quickstart

1. **Install Canary** (Node.js 22 or newer):

   Download `canary-rn-cli-1.0.0.tgz` from the
   [GitHub release](https://github.com/criptofn/Canary/releases/tag/v1.0.0), then:

   ```bash
   npm install -g ./canary-rn-cli-1.0.0.tgz
   canary --version
   ```

2. **In your project** (a Node.js repo with `package.json`):

   ```bash
   canary setup
   ```

   That is the whole job. Canary detects your package manager from your
   lockfile, infers a verification plan from the `test` / `typecheck` /
   `build` scripts in your `package.json` (showing you exactly what it
   picked), wires itself into Claude Code automatically — merging with, never
   overwriting, your existing hooks — and runs your checks once right there
   as a smoke test.

3. **It worked if it says `READY`.** Unsure at any point later?
   `canary doctor` answers "is Canary really protecting this repo?" with
   READY / NEEDS ATTENTION / UNSUPPORTED and the one command that fixes it.

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
npm test          # 503 tests / 78 suites (offline; symlink-dependent tests skip only when the OS denies link creation)
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
canary doctor                # runs your checks NOW and reports READY/NEEDS ATTENTION/UNSUPPORTED
canary status                # read-only state, runs nothing: CONNECTED / NEEDS ATTENTION / NOT CONNECTED
canary result    [--json]    # the same state as ONE compact JSON object — free, for agents and scripts
canary agents    [install|uninstall <id>]   # which agents work here, and at what capability
canary work <name> "<intent>"  # the ORDINARY path: register the intent + open the candidate in one step
canary finish <name>         # verify the candidate from outside it, then promote if the proof holds
canary uninstall             # remove exactly Canary's own changes (recorded strings, never guesswork)
canary checkpoint            # harness-internal: runs at the agent's completion boundary (Stop hook)
```

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

Release-grade proof pipeline:

```bash
canary run    <spec.json>   # execute, write evidence
canary prove  <spec.json>   # re-run + assert expectations
canary check  <spec.json>   # assert last run's evidence
canary report [evidence.json] [out.html]  # defaults: latest run
canary version
```

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
docs/                           ADR-001 · PLAN · SECURITY · EXECUTION-AUTHORITY
archive/python-golden-prototype/ superseded first prototype (concepts preserved in TS)
archive/prototype-scripts/      superseded M0/ladder harnesses (now the CLI)
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
