# Canary 1.0 closure evidence

The final commit containing this report is the release subject. Its exact SHA
and tree are recorded in the release metadata and delivery message (embedding
a commit's own SHA in its tracked contents would be self-referential).

## Baseline and ownership

- Required baseline HEAD: `ec73ab7f6060a0fefd53cc2634fccd3aba4bd6af`.
- Baseline parent: `e28b4f3c80d597880eda2e1898ee398212962e17`.
- Baseline tree: `0481ddc96ee33f3185502aa1af801bb67914c471`.
- Starting worktree: `/home/jan/qwen-builder-cage/astra-pre1-closure`,
  branch `astra-pre1-closure`, clean index and tracked files; exact baseline verified.
- Final closure parent is exactly the baseline HEAD; one closure commit, no merge.
- Original `qwen-builder` remains at `1e276af10c58bdb12bad7efdb0d1fc18292de76c`,
  clean and untouched. The frozen audit worktree was never a writable builder.
- Baseline unit suite: 667 tests, 666 PASS, 0 FAIL, 1 SKIP.
  Baseline acceptance-growth and M10.2 adversarial probes passed.
- Later human authorization explicitly permitted publishing 1.0 and installing
  it for Claude Code. GitHub's separate documentation-only main branch is
  preserved; the closure is published on its own branch and release tag.

## Authorization invariant and closed findings

Completion can authorize promotion only for the exact clean committed candidate,
against its frozen base and applicable sealed authority, for the canonical
material request and requirement multiset. Every objective duty must independently
hold; every remaining subjective duty must be accepted for that same subject.

| Work-order item | Implementation and observed result |
|---|---|
| A: reviewed bytes | Git commit/tree plus clean index/worktree are reconstructed before and after confirmation. Dirty W cannot accept H. Changed HEAD, tree, staged bytes and working-tree bytes block; prompt-time HEAD/dirt/task races write no acceptance. |
| A: equality semantics | Restoring the exact accepted committed subject cleanly intentionally restores freshness. No historical revocation is claimed. Honest acceptance, ff-only promotion and exact post-apply tree verification pass; re-promotion is idempotent. |
| B: material task | The full canonical task digest survives registration, reading, freezing, acceptance and consumption. Warm red to cool blue under the same kind blocks old acceptance and requires re-isolation. Identical/whitespace-equivalent re-registration stays fresh. |
| C: UI intent | An explicit aesthetic duty stays non-objective even with a green functional e2e. Mixed bugfix/aesthetic work needs both regression evidence and acceptance; a red technical plan still dominates. |
| Performance | Unbound numerical targets remain objective UNPROVEN even with a green bench and an acceptance record. An explicit task/requirement-digest-to-script mapping sealed at setup permits the matching threshold fixture to complete objectively. Human acceptance cannot substitute. |
| Requirements | Frozen identities must remain represented with multiplicity. A→B at the same count and A+B→A block; A→A+B grows scope and stales consent; reorder-only is inert. |
| Input envelope | 64 requirements accepted; 65 refused with no partial write. Complete whitespace-normalized UTF-8 text is hashed, including suffixes beyond 4000 characters. Malformed and incomplete legacy identities fail closed. |
| F4-GATE-1 | Post-isolation registration cannot create missing frozen task authority. |
| F4-GATE-2 | Missing/deleted/malformed frozen intent cannot restore a legacy PASS. |
| Evidence attacks | Planted or stale PASS bundles never authorize promotion. Live verification is always repeated. |
| Environment | Trusted npm/Git resolution survives PATH liars. NODE_OPTIONS, NODE_PATH, npm_config and GIT environment poison do not reach proof-authoritative children. |
| Recognition | Bare Canary calls the same status implementation. Untrusted/corrupt config, missing wiring, linked worktrees, nested repositories and missing project state receive honest recognition. Status makes no project command and no write call. |
| Persistence | Live observation is authoritative; bundles are best-effort. A deliberately unavailable evidence store can retain a live candidate PASS with an explicit storage-unavailable warning, never a fabricated durable artifact. |

`canary-acceptance/3` binds candidate name, commit/tree, frozen base commit/tree,
sealed authority identity (including Git store, plan, script digests and proof
bindings), complete frozen/live task identities, and subjective duty IDs.
`at` and `acceptedBy` describe the record but are not cryptographic identity.
The canonical subject digest excludes timestamps, display notes and evidence paths.

Changed subject bytes, material task, requirement identities, applicable authority
or duty set stale consent. Frozen replacement/removal requires re-isolation;
growth requires new consent where subjective scope is present. Acceptance only
marks non-objective UNPROVEN duties met; objective failure and missing objective
evidence remain blocking independently.

## Executed proof

| Check | Result |
|---|---|
| Linux full unit suite | 668 tests: 667 PASS, 0 FAIL, 1 SKIP (Windows reserved-device-name case) |
| Architecture composition matrix | 39 PASS, 0 FAIL, 0 SKIP; covers A–H plus unavailable evidence storage |
| New architecture mutations | 13/13 behavioral assertion kills; syntax/load/runtime errors do not count as kills |
| Master-pass mutations | 13/13 caught; baseline owner suites green first |
| M7–M10 legacy mutations | M7: 13 caught / 1 Windows-only SKIP; M8: 10/10 caught; M9: 15/15 caught; M10: 22/22 caught; 0 survivors |
| Productization | 37 PASS, 0 FAIL, 1 SKIP across 38 steps |
| HoldTheGoblin host-bound step | 16 risk checks executed; two explicit layers skipped: installed Linux engine lacks the newer classifier export; Windows-owned wrapper engine unavailable on Linux. Neither layer is counted as PASS. |
| Linux packed artifact | 7/7 clean-room acceptance steps: exact tarball, zero runtime dependencies, install into a path containing spaces, setup/doctor/checkpoint/repair loop/uninstall and preservation of unrelated hooks |
| Packaged architecture (Linux) | 39/39 attacks passed against the installed tarball, including acceptance and promotion |
| Native Windows | 670 unit tests: 666 PASS, 0 FAIL, 4 POSIX-only SKIP; source matrix 39/39; packaged matrix 39/39; clean-room packaging 7/7; status 1 subprocess / 0 write calls |

Commands: `npm test`; `npm run verify:productization` (full unit suite, all M7–M10
real-Git probes, F4, environment, real-PTY acceptance and growth, status, new
matrix/mutations/metrics, clean rooms); `node tooling/probes/legacy-mutations.mjs`;
native Windows `npm test`, `node tooling/probes/architecture-closure.mjs`,
`node tooling/probes/architecture-metrics.mjs`, and
`node tooling/probes/cleanroom-packed-artifact.mjs`.

Native Windows acceptance identity/race tests use a test-only terminal adapter
around the production command; they do not claim a real Windows PTY session.
POSIX acceptance batteries separately exercise real PTYs. The adapter is never
packaged. Four Windows unit skips are POSIX-only `ps`/shell containment harnesses;
Windows environment shape and trusted resolution run natively. No skip is a pass.
The pinned historical golden dependency experiment is not recertified as a
host-exact run on Node 26.7; its designated-host CI remains explicitly pinned.

### New mutation results, individually

| Mutation | Behavioral owner | Result |
|---|---|---|
| M1 remove dirty-accept refusal | A1 | CAUGHT |
| M2 remove post-confirmation comparison | A6-head | CAUGHT |
| M3 omit candidate tree from subject digest | A3 | CAUGHT |
| M4 drop material task digest | B1 | CAUGHT |
| M5 drop frozen requirement identity comparison | C1 | CAUGHT |
| M6 allow same-kind task replacement and stale consent | B1 | CAUGHT |
| M7 generic e2e erases aesthetic duty | D1 | CAUGHT |
| M8 generic bench proves arbitrary numerical target | E1/E3/E5 | CAUGHT |
| M9 restore silent requirement slicing | C7 | CAUGHT |
| M10 restore 4000-character digest prefix | C8 | CAUGHT |
| M11 acceptance closes objective duties | E1/E3/E5 | CAUGHT |
| M12 explicit kind suppresses inferred kinds | B4 | CAUGHT |
| M13 remove frozen task-authority gate | F1 | CAUGHT |

The old M8 head/dirty mutations were retargeted to the earlier verification
stability gate. Removing only the redundant later promotion check no longer
opens the original attack. Tests now assert the stronger behavior: an unstable
candidate does not receive candidate PASS in the first place. Legacy mutation
copies are force-built from source, avoiding copied mutable build artifacts.

## Friction and complexity

Measured with `architecture-metrics.mjs` on fresh equivalent real-Git fixtures,
baseline versus final. Counts are Node child-process API calls, including metadata
probes but excluding spawned grandchildren; writes are instrumented synchronous
filesystem mutation calls, not an OS-wide tracing claim.

| Measurement | Baseline | Final |
|---|---:|---:|
| Status subprocesses | 1 | 1 |
| Status write calls | 2 temporary-directory mkdir calls | 0 |
| Canonical workflow subprocesses (setup/status/task/isolate/verify/promote) | 87 | 95 |
| Verify subprocesses | 21 | 25 |
| Promote subprocesses | 39 | 43 |
| Passing verification stdout bytes | 217 | 217 |
| Subjective split-verdict stdout bytes | 1212 | 1393 |
| Status stdout bytes | 586 | 583 |

The eight extra workflow subprocesses establish the final clean committed
identity at both verification invocations. Split output grows by 181 bytes to
name the independent aesthetic duty. Status byte differences include fixture
path length. These are byte counts, not inferred model-token counts.

Happy path: five Canary commands including one-time setup, then four on later
tasks. Subjective path: one additional `accept` command and one typed candidate
name. Commit the actual reviewed state before acceptance; dirty review no longer
authorizes different committed bytes. Numerical targets use the inspectable
sealed mapping described in [AUTHORIZATION-1.0.md](AUTHORIZATION-1.0.md).

One canonical module replaces the superseded `intentDigestOf` and
`acceptanceScopeDigestOf` helpers. Frozen task types use the same `TaskIdentity`.
Bare-command recognition no longer owns a weaker implementation. No new runtime
or development dependency, daemon, server, model/API call or account system was
added. Release version is 1.0.0 in the CLI, workspace metadata and packed manifest.
CI covers the new matrix and packaging on Linux and Windows.

## Remaining findings and verdict

- High: none observed within the supported-interface/local trust contract.
- Medium: no unresolved actionable closure finding observed. Explicit proof
  bindings still trust the approved test's semantic correspondence; test-path
  changes are regression-evidence proxies, not semantic correctness proof.
- Low/environment limits: the two host-bound HoldTheGoblin layers and the named
  platform-only cases are not claimed as reproduced. They do not grant promotion
  authority. Readiness is bounded by the documented local model.
- Residuals: same-UID total forgery, writable local runtime, PTY automation,
  executable/change-and-revert races inside sampling windows, candidate-authored
  test meaning and lifecycle code, undeclared intent, and the weaker dependency
  isolation of candidate verification versus the experiment pipeline remain.
- Known supported-interface false-PASS path after this closure: none observed.
- Known remaining release blocker in this closure: none observed.
- Ready for independent re-audit; no independent third-party audit is claimed.
- Final verdict: **PASS WITH DOCUMENTED RESIDUALS**, subject to the exact clean
  release commit and test results recorded here.

Changed-file inventory and exact line delta are the containing commit's
`git show --stat` / `git show --numstat`; source, tests, probe runners, contracts,
CI and version metadata are included. No edits are made after the final commit.

Installed CLI payload SHA-256 (identical on Windows and WSL):
`69fa9dbe6279c38f40d3fd0a784e77d2e918b5d798b7654a4404fafe85eb9390`. This is a byte checksum, not a signature.

## Changed files

- `.github/workflows/ci.yml`
- `README.md`
- `apps/cli/package.json`
- `apps/cli/src/authorization.ts`
- `apps/cli/src/candidate.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/onboarding.ts`
- `apps/cli/src/pipeline.ts`
- `apps/cli/test/acceptance-scope.test.ts`
- `apps/cli/test/m10-obligations.test.ts`
- `apps/cli/test/m6-proof-orchestration.test.ts`
- `docs/AUTHORIZATION-1.0.md`
- `docs/RELEASE-1.0-REVIEW.md`
- `docs/SECURITY.md`
- `package-lock.json`
- `package.json`
- `packages/support/src/index.ts`
- `packages/support/test/env.test.ts`
- `tooling/probes/architecture-closure-mutations.mjs`
- `tooling/probes/architecture-closure.mjs`
- `tooling/probes/architecture-metrics.mjs`
- `tooling/probes/f3-acceptance-growth.mjs`
- `tooling/probes/lazy-connect-status.mjs`
- `tooling/probes/legacy-mutations.mjs`
- `tooling/probes/m10-mutation-battery.mjs`
- `tooling/probes/m10-obligations.mjs`
- `tooling/probes/m8-mutation-battery.mjs`
- `tooling/probes/m8-promotion.mjs`
- `tooling/probes/master-pass-mutations.mjs`
- `tooling/probes/packed-architecture.mjs`
- `tooling/probes/pre10-acceptance.mjs`
- `tooling/test-support/fixtures/accept-review-driver.mjs`
- `tooling/test-support/fixtures/environment-driver.mjs`
- `tooling/test-support/fixtures/metrics-driver.mjs`
- `tooling/verify-productization.mjs`
