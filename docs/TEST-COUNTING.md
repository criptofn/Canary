# Test counting — one deterministic convention

Added by the 2026-09-05 post-night re-audit: the F6 report cited numbers
(`438 baseline`, `64 -> 71 suites`) that no reproducible command produced.
This file is the convention that prevents that class of error. Rule:
**numbers in reports come from an executed command's reporter output, never
from static grep/`it()` counting and never copied from a stale index.**

## The command

```
npm ci
npm test
```

`npm test` (root `package.json`) is exactly:

```
npm run build && node --test "packages/**/dist/test/*.test.js" "apps/**/dist/test/*.test.js"
```

i.e. `tsc -b` over the whole workspace graph, then **one** `node --test`
invocation whose two glob patterns select every compiled `dist/test/*.test.js`
under `packages/` and `apps/`. Package scope: every workspace that has such
files (workspaces: `apps/*`, `packages/core/*`, `packages/runner/*`,
`packages/evidence/*`, `packages/registry-npm`, `packages/github`,
`packages/ai`, `packages/support`).

## What counts as what

The **only** source of truth is the spec reporter's summary block of that
single invocation:

- `ℹ tests` — one test = one `test()`/`it()` case the runner executed
  (the runner's own definition; do not re-derive by counting source `it()`
  occurrences — pending/renamed/commented cases drift).
- `ℹ suites` — one suite = one `describe()` (plus whatever the runner groups;
  again: read the line, don't count braces).
- `ℹ skipped` — cases that called `t.skip()`, including platform
  self-skips (e.g. F6a link tests when link creation is denied — see
  `docs/EXECUTION-AUTHORITY.md` coverage sentinel). A skip is **visible
  coverage loss**, never "passed".
- `ℹ todo`, `ℹ cancelled`, `ℹ fail` — same rule: reporter lines only.

## Pass-claim convention

A run may be called green **only** if `fail = 0` **and** `cancelled = 0`.
`skipped`/`todo` must be `0`, **or** each nonzero skip must be explicitly
expected and named in the report (a platform skip is an exception only where
a sentinel makes the lost coverage loud — a silent nonzero `skipped` on a
security regression is UNKNOWN, and UNKNOWN never becomes PASS).

## Observed results (all re-derived at their stated tree, 2026-09-05)

| Tree | tests | suites | pass | fail | skipped | Proof |
|---|---|---|---|---|---|---|
| `34cf515` (pre-F6 baseline) | 465 | 71 | 465 | 0 | 0 | clean detached worktree re-run: `docs/night-evidence/2026-09-05-F6/reverify-baseline-34cf515-suite.log` (self-proves via `TREE:` line); cross-check: `git show -s --format=%B 34cf515` records "Full suite 465/465 pass." |
| `d327e71` (night F6 final) | 472 | 71 | 472 | 0 | 0 | TREE-pinned clean-worktree re-derivation `reverify-head-d327e71-treepinned-suite.log` (first line `TREE: d327e71… @ canary-head-d327e71`, EXIT:0); agrees with night log `final-full-suite.log` and un-pinned re-run `reverify-head-suite.log` |
| `d327e71` + F6a sentinel | 473 | 71 | 473 | 0 | 0 | `reverify-postchange-suite.log` (sentinel adds one test) |

The earlier `438 tests / 64 suites` figure was from the **Sept-2**
night index at HEAD `b3a5069` — a different commit; it was stale-copied
into the Sept-5 report (corrected in its errata section).
