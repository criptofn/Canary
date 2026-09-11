# Contributing to Canary

Thanks for looking. Canary is an evidence-first project: a change is judged by
what a command actually did, not by how convincing the description is. The
process below is deliberately small, and the rules are strict.

## The loop

```sh
git clone https://github.com/criptofn/Canary.git
cd Canary
npm ci                                 # lockfile-exact; no lifecycle scripts needed
npm run build                          # tsc -b over the workspace graph
npm test                               # the full unit suite — read the reporter summary
                                       # (never trust a count copied into a document)
npm run verify:productization          # build + contracts + every probe, one command
```

`npm run verify:productization` is the single command covering the productization
surface (`tooling/verify-productization.mjs`). It prints a per-step
`PASS` / `SKIP` / `FAIL` table; exit `0` means every step passed or ended in an
explicit, listed host-bound `SKIP`.

Requirements: Node.js 22 or newer (CI tests 22; the committed *proof host* is
Windows + Node 26.3.0 + npm 11.16.0). There are no runtime dependencies — the CLI
ships as one esbuild bundle.

**Known, pre-existing reds.** Six probes in the oracle fail on the current
Windows host and failed identically before the v1.1 work began:
`m8-promotion`, `m9-authority`, `pre10-env-authority`, `pre10-acceptance`,
`f3-acceptance-growth`, `master-pass-mutations` (the last cascades: its baseline
arm is red, so it aborts). They are host-bound (git resolving outside the trusted
dirs, PTY-driven acceptance). Fix them if you can — but never by weakening an
assertion or a gate. Record what you changed; do not "green" them by deletion.

## Rules that are not negotiable

1. **No numbers without an executed command.** Read
   [`docs/TEST-COUNTING.md`](docs/TEST-COUNTING.md) first. Counts come from the
   spec reporter's summary block of a single `node --test` invocation — never
   from static counting, never copied from a stale index. A skip is visible
   coverage loss, never a pass.
2. **No inline interpreters for multi-step verification** (`node -e`, `python -c`,
   `bash -c` with generated code). Write a probe under `tooling/probes/` or a
   fixture under `tooling/test-support/fixtures/`. Probes are deterministic,
   self-cleaning, and exit `0` only when everything they executed passed.
3. **Fail closed.** `INCONCLUSIVE`, `NOT PROVEN`, `BLOCKED` and `UNSUPPORTED` are
   correct outcomes. Never widen a path to a strong verdict, and never weaken a
   gate to turn a test green.
4. **Claims and evidence stay separate.** The classifier
   (`packages/core/classification`) is pure, total and deterministic — no LLM, no
   network, no clock, no filesystem in the verdict path. An agent's claim is an
   untrusted hint that can add obligations and can never lift one.
5. **Discovery declares, it never invents.** A check appears only when a project
   actually declares it. A tool named in a comment, a description or a README is
   *prose*; if discovery picks it up, that is a bug (it happened — see
   `git log --grep="mention is not a declaration"`).
6. **A claim change needs a contract change.** If you alter what Canary promises,
   update the owning document in the same PR:
   [`docs/EXECUTION-AUTHORITY.md`](docs/EXECUTION-AUTHORITY.md) (what is
   attested), [`docs/SECURITY.md`](docs/SECURITY.md) (enforced vs convention),
   [`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md) (what is protection
   vs what is only a contract), [`docs/CAPABILITY-LEVELS.md`](docs/CAPABILITY-LEVELS.md)
   (what a level means), [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) (what is
   supported and how it was established), [`docs/AUTHORIZATION-1.0.md`](docs/AUTHORIZATION-1.0.md)
   (what completion authorizes). Stated ceilings stay stated.

## What a good PR looks like

- **One concern.** A fix and its evidence, or one seam with its tests.
- **Tests proportional to the claim.** End-to-end guarantees get a probe under
  `tooling/probes/` (real git, real bytes, real subprocesses). Interfaces get a
  contract test next to the owning package or app file. Adding a *strong* verdict
  path requires showing the observation gate still holds.
- **Evidence in the description.** Paste the reporter summary of the command you
  ran (`npm run verify:productization`), including `SKIP` lines and why they are
  host-bound. "Tests pass" is not evidence; the reporter output is.
- **Conventional commit subject** (`fix(m7):`, `docs:`, `chore(ci):` …).
- A probe is preferred over a screenshot: if you cannot reproduce it in a command,
  it is not yet reviewable.

## Where to extend what

| Seam | Files | Notes |
|---|---|---|
| A new project ecosystem | `apps/cli/src/ecosystems.ts`, `apps/cli/src/project.ts` | Add an `Ecosystem` declaration (manifests, dependency paths, programs, a pure `discover()`), then a `commandAdapter` entry. Discovery must be root-scoped by default and must not invent checks. |
| Polyglot composition | `apps/cli/src/project.ts` (`discoverScopes`, `composePlan`) | Deterministic order is a requirement, not a nicety: the plan is sealed. |
| An agent harness | `apps/cli/src/agents.ts`, `apps/cli/src/onboarding.ts` | Add an `AGENT_INTEGRATIONS` entry with its REAL capability (`gating` true only if a hook can actually block). Advisory integrations write a marked AGENTS.md block via `installAdvisory`. |
| Machine-readable output | `apps/cli/src/protocol.ts` | One envelope, versioned schema, facts and a next action — never a log dump. `--json` must never change a verdict. |
| Trust store / authority | `apps/cli/src/trust-store.ts`, `authority-envelope.ts` | Security-critical: read [`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md) first, and add an assertion to `trust-store-attacks.test.ts` for any new forging route. |
| Authorization kernel / providers | `apps/cli/src/broker.ts`, `apps/cli/src/platform-boundary.ts` | The kernel executes nothing; keep that property transitive. Update the capability report when a provider lands. |
| The ordinary workflow | `apps/cli/src/orchestrate.ts` | Orchestration only — delegate to the primitives; never re-implement a gate. |
| Experiment specs | `packages/core/planner`, [`schemas/spec.schema.json`](schemas/spec.schema.json), [`docs/SPEC-FORMAT.md`](docs/SPEC-FORMAT.md) | The published schema and the runtime validator must agree; the validator wins. |
| Runner observation | `packages/support/src/knownRunners.ts`, `packages/runner/executor/src/observation.ts` | A new runner version needs a pin **and** its review manifest; the offline test fails if they diverge. |

## Reporting a security issue

Do not open a public issue. See [`SECURITY.md`](SECURITY.md), and read the
ceiling sections of [`docs/SECURITY.md`](docs/SECURITY.md) and
[`docs/TRUST-ARCHITECTURE.md`](docs/TRUST-ARCHITECTURE.md) first — the local
limits are documented deliberately, and a report that a *documented* bound is
weaker in practice than claimed is very welcome.

## Code of conduct

Be direct about code and generous with people. Evidence-based disagreement is the
point of this project; contempt is not.
