# Canary — an independent verification layer for AI-written code

> *"Cool diff. Prove that it actually made the project better."*

Canary takes a **baseline** state and a **candidate** change, runs relevant
deterministic checks against both in isolated, security-boundary-enforced
workspaces, reproduces any divergence, and emits a **machine-readable
Evidence Bundle** with a **deterministic classification**. Only after that
may an LLM explain the evidence — the LLM can never render the verdict.

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
tree drift              →  confined to axios subtree     (2 entries, verified)
normalized output       →  byte-identical per arm, across rounds AND runs
classification          →  CONFIRMED_REGRESSION (rule 5) — pure function, no LLM
failing tests           →  "can pass headers to match to a handler" (AxiosHeaders),
                           "handles baseURL correctly" (URL resolution) — genuine
                           axios 1.0.0 behavior changes this project depended on
```

Reproduce it:

```bash
npm install
npm run build
npm test          # 73 tests across 13 packages
npm run prove     # fresh end-to-end run, asserts against committed expectations
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
node apps/cli/dist/src/main.js report <evidence.json> [out.html]
```

Exit codes: `0` proof holds / regression confirmed · `1` PASS / proof failed ·
`2` other classification or infra · `3` misuse.

## Security contract (non-negotiable, enforced in code)

Every downstream repository is **untrusted**. Enforced by
`@canary-rn/support` + `@canary-rn/workspace` on every run
([`docs/SECURITY.md`](docs/SECURITY.md)):

- content fetched **by pinned 40-hex commit SHA** only (tarballs, no git auth)
- **pre-execution audit gate**: refuses repos with install lifecycle hooks
  or shipped `.npmrc`/`.yarnrc` (registry-injection vectors)
- **allowlisted child environment** — Anthropic/GitHub/cloud credentials,
  `NODE_OPTIONS`, SSH agents, user npm auth are *structurally invisible*
  to external processes (deny-by-omission, not a redact-list)
- `--ignore-scripts` on every install; disposable workspace under
  `.canary-runs/`; caches and HOME redirected inside it
- no publish, no push, no external auth, ever
- if the boundary can't hold: `INFRASTRUCTURE_FAILURE`, before executing

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
schemas/evidence.schema.json    published evidence contract
docs/                           ADR-001 · PLAN · SECURITY
archive/python-golden-prototype/ superseded first prototype (concepts preserved in TS)
archive/prototype-scripts/      superseded M0/ladder harnesses (now the CLI)
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
