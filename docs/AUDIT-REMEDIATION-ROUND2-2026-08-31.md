# Canary v0.1 Audit Remediation — ROUND 2 Ledger — 2026-08-31

Audited baseline (frozen, untouched): **`f823b98a9a8e6da75384192f65b946af4bc3ee75`**
Working branch: **`reaudit-hardening`** (created exactly at the audited SHA).
Authority: independent Codex RE-AUDIT (round 2) finding list, relayed by the
operator 2026-08-31. Status legend: OPEN · FIXED · PARTIALLY_FIXED ·
ACCEPTED_LIMITATION · REJECTED_WITH_EXECUTION_EVIDENCE.

## Reproduction (execution evidence at the frozen baseline)

All six release blockers were reproduced against the BUILT snapshot before any
change (script run 2026-08-31; output recorded in the session and summarized):

| ID | Reproduction result at `f823b98` |
|---|---|
| B1 | CONFIRMED — `extractFailingTestNames` on a two-suite/two-failure mocha log returned `["handles baseURL correctly"]` (2 distinct suite-qualified failures collapsed to 1). The REAL golden run shows this live: 3 failures / 2 distinct leaf titles / 3 distinct suite-qualified identities (`passThrough tests (requires Node) > handles baseURL correctly` vs `onNoMatch=passthrough option tests (requires Node) > handles baseURL correctly`). The committed proof itself asserts only 2 of the 3 identities. |
| B2 | CONFIRMED — `classify` over 4 zero-execution rounds (summary line present, no tests run) → `PASS rule 3`; rounds with NO runner summary at all, exit 0 → `PASS rule 3`. Executor computes `infraSignal` only when `exitCode !== 0`, so infra-shaped output at exit 0 is invisible to the classifier. |
| B3 | CONFIRMED (policy) — `verifyArtifacts` resolved `../baseline-1.stdout.log` OUTSIDE the artifacts dir and reported no containment issue for the file it found (only missing siblings); `logPath` is never checked against the round's own `arm`/`round`, so cross-round swaps (`candidate#1` claiming `candidate-2.stdout.log` with consistently swapped digests) verify clean. |
| B4 | CONFIRMED (by code path, full mutation matrix lands with the fix milestone): no digest binds cross-field claims; `check` never asserts `schema`/`experimentId`; persisted per-round facts (counts/names/summary/infra flags) are never re-derived from the artifact BYTES except for round-1 logs. |
| B5 | CONFIRMED — `$npm ins evil` and `$npm ii evil` (npm's real aliases of `install`) executed with `--ignore-scripts? false` (silent no-injection); raw `npm install x` and `node npm-cli.js install x` bypass the entire guard (guard only fires on `$npm`/`$yarn` tokens); `$npm install pkg -- x` appends all isolation flags AFTER the user `--`, where npm treats them as positional args → bypass. |
| B6 | CONFIRMED — `diffTrees({}, {}, 'axios')` returns `confined: true`: an empty/partial dependency-tree observation vacuously "proves" confinement. treeHash's `npm ls` exit status and `problems` array are never evaluated. |

## Release blockers

| ID | Finding | Status |
|---|---|---|
| B1 | Suite-qualified canonical test identity; no leaf-title collapse; proof updated to the REAL three golden identities | FIXED @ this commit |
| B2 | Execution-validity taxonomy: zero-test and no-summary runs can never PASS; infra-shaped output at exit 0 never PASS (without misclassifying benign prose) | FIXED @ this commit |
| B3 | Artifact paths canonical (derived from arm/round, not trusted strings) + resolved-path containment + ownership binding | FIXED @ d5512ea |
| B4 | Evidence bound to bytes: manifest integrity digest, per-round fact replay against artifacts, report verifies-or-labels, proof asserts schema/experimentId/repo/environment/tarball | FIXED @ this commit |
| B5 | Canonical package-manager policy: closed subcommand allowlist (no alias blacklist), raw npm forms rejected, `--`-in-install rejected, isolation flags in effective position by construction | FIXED @ a4bb6cf |
| B6 | Tree observations typed VALID/INCOMPLETE/INVALID; only VALID supports trustful labels. Principled rule: a parsed non-empty tree CONTAINING the studied dependency is VALID regardless of npm ls exit/problems (Axios has known version-invalidity); `problems` recorded, never used to downgrade | FIXED @ this commit |

## Secondary round-2 findings

| ID | Finding | Status |
|---|---|---|
| S1 | F10-adjacent: POSIX sweep ignores session-level lineage (setpgid-escapees within the child's session missed) | FIXED @ this commit |
| S2 | proof schema/experimentId not asserted (folds into B4) | FIXED @ B4 commit |
| S3 | CI/clean-room use `npm install`, not `npm ci` | FIXED @ this commit (lockfile synced; clean-room runs `npm ci`) |
| S4 | README test count stale; PLAN historical claims to re-check | OPEN (final doc pass) |
| S5 | report renders without any artifact verification (folds into B4) | FIXED @ B4 commit |

## Milestone log

(append one dated entry per milestone: reproduction → change → regression +
adversarial tests → mutation evidence → gates → commit SHA)

### 2026-08-31 — B1 canonical identity @ 80b4f31 (+ scratch cleanup 99178a6)
Root cause: `extractFailingTestNames` captured only the leaf title (mocha
regex group on the continuation line), collapsing same-leaf/different-suite
failures; the real Axios run has two (`passThrough… > handles baseURL
correctly` and `onNoMatch=passthrough… > handles baseURL correctly`).
Change: deterministic canonical "Suite > … > test" from the full failure
block + ava path normalisation; identical ids dedupe, different ids never;
progress-list markers yield no id. Regression/adversarial: comparator (5
cases) + executor real-subprocess cross-round (FLAKY vs CONFIRM). Proof file
→ 3 canonical identities. Mutation (leaf-only collapse): 7 tests fail →
restored 0. Gate: suite 134→140, typecheck clean, golden proof 16→17/17
(the 2 collapsed leaf names are now 3 distinct identities), host-exact.

### 2026-08-31 — B2 execution validity @ this commit
Root cause: a `PASS`/`CONFIRMED` only required exit-code unanimity; a run
with no summary or "0 passing" at exit 0 hit rule 3 PASS, and infra output
was only examined when exit!=0 (executor: `exitCode !== 0 && isInfraOutput`).
Change:
- classifier `infraCause()` — a round is invalid if killed, infraSignal
  (ANY exit code), no runner summary, observed-and-zero executed tests,
  masked failure (exit 0 + failures) or died-outside-tests (exit!=0 + zero
  failing). rule 1 now reports the specific cause.
- executor: `infraSignal` computed at any exit code; `isInfraOutput` split
  HARD (module/ERR/ERESOLVE/npm-error …) vs SOFT errno codes that must
  co-occur with an error shape on the same non-progress-glyph line, so
  "√ retries after ECONNREFUSED" is benign but "Error: connect ECONNREFUSED"
  is infra.
- facts/evidence/schema/published-JSON round-trip reportedPassing/pending so
  validateBundle's re-derivation stays faithful.
Regression/adversarial: 6 classify cases (zero-test, no-summary, infra-at-0,
zero-candidate, positive PASS control) + 3 real-subprocess executor cases +
matcher benign/hostile pair. Live: broadened matcher re-checked against all 5
golden artifacts → all infraSignal=false (no false infra). Mutation: removing
the zero-exec guard fails 2 tests; reverting infra-at-0 fails 1; restore 0.
Gate: suite 140→149, build+typecheck clean, golden Axios proof PASS 17/17.

### 2026-08-31 — B3 artifact confinement + ownership @ d5512ea
Root cause: verifyArtifacts derived filenames by slicing the attacker-supplied
`logPath`, so `../`/absolute/separator-variant paths read arbitrary external
files, and cross-round/cross-type swaps verified when digests were swapped too.
Change: filenames DERIVED from structured arm/round (a bare basename cannot
carry a separator → containment is structural); `logPath` must equal the
canonical `${arm}-${round}.stdout.log` (ownership); lexical `withinDir` +
`fs.realpathSync` re-check reject symlink escapes; arm/round validated before
any path build; schema `semanticChecks` rejects a non-canonical logPath too.
Tests: prove.test B3 suite (external-identical refusal, absolute refusal,
cross-round both directions, baseline→candidate, canonical clean, missing+
modified, symlink escape). Mutation: disabling the ownership check fails 5
tests; restore 0. Suite 149→155(+1 skip); typecheck clean; proof PASS 17/17.

### 2026-08-31 — B5 canonical package-manager policy @ a4bb6cf
Root cause (reproduced): only install|i|ci|add triggered injection, so npm
aliases `ins`/`ii`/`it` installed with NO isolation; raw `npm install` /
`node npm-cli.js install` / `$bin:npm install` skipped the guard entirely;
a user `--` made end-appended flags dead weight.
Change: closed-allowlist design (no growing alias blacklist).
assertCanonicalPmForm (runs for EVERY command): raw npm/npx/yarn/npm-cli.js
and $bin:npm/yarn/npx rejected. pmArgvPolicy: subcommand must be in
install/run-script/info allowlists or it is REJECTED (fail-closed → unknown
aliases can't escape); install/update family gets isolation flags SPLICED
IMMEDIATELY AFTER the subcommand (incl. a new --registry pin defeating
host-global npmrc), and `--` is rejected for install-family. F8 grammar rules
(short options, conflicts anywhere, case-folding) retained.
Tests (+8): all aliases inject; unknown subs rejected; every raw form +
$bin:npm rejected; `--`-in-install rejected while run-script `--` passes
uninjected; PROPERTY invariant (accepted install → controls after subcommand,
before any `--`); family classification. Mutation: removing raw-form check
fails 1, neutralizing install-`--` throw fails 1, restore 0. Suite 155→162
(+1 skip); typecheck clean; proof PASS 17/17 (byte-exact hashes held under the
splice + registry pin).

### 2026-08-31 — B6 dependency-tree completeness @ this commit
Root cause (reproduced): diffTrees({},{},'axios') → confined:true, so an
empty/partial tree observation (npm ls parse failure, or a tree not containing
the studied dep) vacuously "proved" comparability and let a trustful verdict
stand on no data.
Change: classifyTreeObservation() returns VALID (parsed, non-empty, contains
studied dep) / INCOMPLETE (parsed but dep absent) / INVALID (unparseable/
empty). treeHash carries status per arm → bundle.treeComparison.
observationStatus (schema-required). applyConfinementGuard gained rule 10
(either arm != VALID → INCONCLUSIVE, takes precedence over rule 9),
INFRA kept. validateBundle independently rejects a trustful label with a
non-VALID observation and accepts rule 10 only when genuinely unjustified-to-
trust (rejects fabricated rule 10).
PRINCIPLED, not exitCode-based: npm ls `problems`/nonzero exit (the Axios
fixture's known version-invalidity) is recorded but NEVER downgrades, because
the studied dependency is present in a parsed tree. Verified: golden proof
stays rule 5 (VALID), not rule 10.
Tests: comparator (6, incl. the exposed vacuous-confinement property + scoped
presence), classification (2 rule-10 cases + precedence), schema (4: trustful+
INCOMPLETE/INVALID rejected, legit rule-10 accepted, fabricated rule-10
rejected, status mandatory). Mutation: guard rule-10 branch disabled fails 2;
validator status check disabled fails 1; restore 0. Suite 162→174 (+1 skip);
build+typecheck clean; golden Axios proof PASS 17/17.

### 2026-08-31 — B4 bind evidence to reality @ this commit
Four layers (schema gains `integrity`; pipeline seals the manifest before
validating):
(a) verifyArtifactSemantics(artifactsDir, bundle): re-derives each round's
    hasRunnerSummary/counts/failingTestNames from the RAW stdout+stderr bytes
    (same combined concatenation + same matchers as the executor) — recorded
    facts must equal the bytes, even if the forger recomputed the manifest.
(b) assertProof now also pins: experiment identity, evidence schema, fetch
    method, repository URL, commit, tree observation VALID, and (optional)
    tarball digest + runtime platform/arch (node/npm host-gated like hashes).
(c) manifest: integrity.manifestSha256 = sha256(canonicalJson(bundle minus
    integrity)) — covers every field incl. round digests, so any single-field
    rewrite without full recompute fails validateBundle. Documented as content
    INTEGRITY/coherence, NOT authenticated provenance (no trust root; a total
    forger recomputes it — that residual is covered by (a)+(b), not the hash).
(d) cmdReport verifies artifacts+semantics and stamps VERIFIED / UNVERIFIED
    (exit 3 + red banner on any mismatch); still refuses invalid bundles.
Honest limits (documented in code + here): resealed rewrites of host-absolute
argv, per-run runId, and the not-proven-cross-host-reproducible tarball digest
are integrity-only (the pinned commit SHA remains the content anchor); the
golden proof deliberately does NOT hard-pin the tarball digest.
provenance.test.ts = the forgery matrix (17 cases): every Codex accepted-
forgery class (runtime, repo URL, IDs, argv, env keys, tarball digest, failure
counts, failure identities, tree data) run naive AND resealed, asserting the
rejecting layer; +2 novel forgeries (relabel-PASS, per-round name
disagreement). Mutation evidence (§10): disabling verifyArtifactSemantics
fails 2 matrix tests; vacuous manifest check fails 4; restore -> 0.
Suite 174→191 (+1 skip); build+typecheck clean; golden Axios proof PASS 24/24
(was 17: +7 identity/provenance assertions; byte re-derivation green on real
run data).
