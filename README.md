# Canary — an independent verification layer for AI-written code

> *"Cool diff. Prove that it actually made the project better."*

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

## The golden proof (v0.1 scope, working today)

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
npm test          # 438 tests / 64 suites (offline; 1 skip when the OS denies symlink creation)
npm run prove     # fresh end-to-end run; PASS requires the committed proof host (36 assertions
                  # executed, zero skips). On any other runtime it honestly exits 2 (INCOMPLETE):
                  # the 22 portable assertions must all hold, the 6 host-exact ones are skipped,
                  # never silently passed.
npm run report    # no args: renders the latest run's evidence. Exit 0 means SELF-CONSISTENT:
                  # byte + run-identity + tree-snapshot + classification re-derivation checks
                  # passed ON THIS MACHINE — it does NOT mean the committed proof was consulted
                  # (that is prove/check; post-sol F1). Otherwise NOT SELF-CONSISTENT, exit 3.
```

Also demonstrated by this fixture: **Canary does not manufacture
regressions.** An earlier candidate (axios-cookiejar-support @ f1e045d4)
came back PASS — honestly reported, ledger in
[`fixtures/axios-0.27-to-1.0/README.md`](fixtures/axios-0.27-to-1.0/README.md).

## CLI

```bash
node apps/cli/dist/src/main.js run    <spec.json>   # execute, write evidence
node apps/cli/dist/src/main.js prove  <spec.json>   # re-run + assert expectations
node apps/cli/dist/src/main.js check  <spec.json>   # assert last run's evidence
node apps/cli/dist/src/main.js report [evidence.json] [out.html]  # defaults: latest run
```

Exit codes: `0` proof holds fully (on the committed proof host) / regression
confirmed / self-consistent report · `1` a proof assertion diverged (or `run`
classified PASS) · `2` other classification / infra / proof INCOMPLETE (this
runtime is not the proof host — host-exact assertions unverifiable, never a
PASS pretense) · `3` misuse, refused bundle, or a NOT-SELF-CONSISTENT report.

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
  subcommand, and since post-sol RB-1, exact option spellings — npm's
  abbreviations, negations and last-wins ordering make textual denylists
  bypassable, so Canary's isolation flags are appended as the argv *suffix*
  and npm's own last-wins makes them the effective config); raw
  `npm`/`npm-cli.js` forms, wrapper-mediated execution and `--`-bypass shapes
  are rejected (audits B5/B5.1, post-sol RB-1); disposable workspace under
  `.canary-runs/`; caches and HOME redirected inside
- **evidence is bound to reality, not just self-consistent** (audit B1–B4,
  post-sol RB-2/M-1, post-GLM A+B): failing-test identities are suite-qualified
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

**What v0.1 does NOT claim** (read the tiered section): there is no filesystem
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
