# Golden fixture search: axios 0.27.2 → 1.0.0

The mandated golden experiment: a real downstream repository, pinned to an
exact commit, whose real test suite must deterministically classify as

```
baseline  axios 0.27.2  -> unanimous PASS
candidate axios 1.0.0   -> unanimous FAIL across reruns
=> CONFIRMED_REGRESSION
```

Selection is empirical: every candidate is executed under the security
contract (`docs/SECURITY.md`) by the dry-run harness before being trusted.
Memory and GitHub lore are hypotheses, never evidence.

## Isolation protocol (all candidates, "build-once / run-twice")

1. Fetch repo content by pinned commit SHA (codeload tarball, no branch refs).
2. Static pre-execution audit: lifecycle install hooks must be absent.
3. Install the era-consistent dependency tree from the repo's committed
   `package.json` with a time pin (`npm install --before=2022-10-04 …
   --ignore-scripts` — no dependency lifecycle code; the repo's own
   `package-lock.json` is not used, the date pin stands in for era parity).
4. Build/compile once against the BASELINE type/runtime contracts.
5. Run the identical artifacts ×2 → baseline arm.
6. Replace ONLY the axios subtree (`npm install --no-save --ignore-scripts
   axios@1.0.0`), verify the installed version from node_modules.
7. Run the byte-identical artifacts ×3 → candidate arm.
8. Deterministic classification (docs/PLAN.md §6); degenerate-run guard
   blocks "failed without substantive test output" from becoming a signal.

## Candidate ledger

| Candidate | Commit | M0 result | Classification | Verdict |
|---|---|---|---|---|
| `3846masa/axios-cookiejar-support` | `f1e045d4` (v4.0.2) | baseline [0,0] (18/18 pass) · candidate [0,0,0] | **PASS** | ✗ demoted — historical breakage not covered by its own suite |
| `contentful/contentful.js` | — | static audit: `postinstall` hook present | **REFUSED (contract)** | ✗ security contract rejects lifecycle hooks |
| `ctimmerm/axios-mock-adapter` | `b8804442` (v1.21.1) | baseline [0,0] (128 passing) · candidate [3,3,3] (125 passing / 3 failing) | **CONFIRMED_REGRESSION, rule 5** | ★ **GOLDEN FIXTURE** |

## Golden fixture proof (2026-08-30)

Three fully independent from-scratch runs (fresh fetch → fresh era install →
baseline ×2 → swap → candidate ×3) produced:

- identical classification: `CONFIRMED_REGRESSION` (rule 5)
- tree drift **confined** to `axios 0.27.2→1.0.0` + new transitive `proxy-from-env` (2 entries, verified)
- byte-identical **normalized** stdout per arm, across rounds AND across runs
  ON THE PROOF HOST (the proof-host gate is decided by the actual runtime —
  round-3 B3; off-host those assertions skip and the verdict is INCOMPLETE)
- same failing downstream tests every time, as THREE suite-qualified
  identities (audit B1: `handles baseURL correctly` appears in two different
  suites and must stay distinct):
  `MockAdapter basics > can pass headers to match to a handler`,
  `passThrough tests (requires Node) > handles baseURL correctly`,
  `onNoMatch=passthrough option tests (requires Node) > handles baseURL correctly`
- committed expectation file: `specs/axios-mock-adapter.proof.json`
- machine check: `npm run prove` (CLI: `canary prove`) → 36/36 assertions with
  ZERO skips on the designated proof host (win32/x64, node v26.3.0, npm
  11.16.0); on other hosts every portable assertion (22) still executes and
  the run reports INCOMPLETE (exit 2) instead of claiming PASS
- dependency versions **attested at runtime** from the fixture's own module
  resolver (both arms), nested copies counted and recorded in the bundle
- sample evidence artifacts: not committed (they are generated run outputs
  containing machine-local paths) — `npm run prove` writes the fresh bundle
  and HTML report under `.canary-runs/` on every run

One era-faithful toolchain override is declared in the spec and recorded in
every bundle: `yargs@16.2.2` (the May-2022 patch of mocha@10's CLI dep; the
`--before` pin otherwise selects 16.2.0, whose exports map breaks under
Node 20+). Both arms always receive the identical override.

## Why the demotion matters

A fixture that "should" fail because of a changelog entry is a story; a
fixture that observably fails — same commit, same artifacts, one swapped
subtree, unanimous across reruns — is proof. Canary exists to make that
distinction mechanical, and the first candidate was rejected by exactly the
mechanism the product promises.
