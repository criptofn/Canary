# v0.1 audit remediation — ROUND 3 Ledger — 2026-08-31

Branch: **`reaudit-hardening`** · Continuation base (HEAD at session start):
**`9f474bc7b415ce14b9162bb352ae127bd7f6dd6a`** (round-2 final, marked READY
FOR ROUND 3). Working tree at continuation start carried a large UNCOMMITTED
round-3 remediation (~2.1k insertions / 17 files + 3 new files) left by an
interrupted session; it was recovered, reviewed line-by-line, verified,
hardened by an internal adversarial self-review, and committed here.

## Provenance & interruption note

The prior-session interruption was an execution/billing configuration issue
(project-local Claude Code settings overriding the intended provider), NOT a
product, classifier, proof, or evidence-integrity finding. No credential ever
entered tracked content (verified: `.claude/settings.local.json` is git-
IGNORED + untracked; a tracked-content credential scan is ABSENT).

The round-3 blocker/secondary list below is transcribed from what the
interrupted session recorded IN CODE ("round-3 blocker N" annotations) — the
external finding text was not in the repo, so each item was re-derived from
the implementation and re-verified by execution in this session, not taken on
faith.

## Round-3 blockers (remediation recovered from the dirty tree, verified here)

| ID | Finding | Fix (verified this session) | Status |
|---|---|---|---|
| R3-B1 | Two root-level mocha failures parsed to EMPTY identity sets → equal profiles → false CONFIRMED from zero identity evidence | Root-level `N) title:` extraction; `identityCoverage()` COMPLETE iff uniq(names)==reportedFailing; classifier rule 11 (trustful refused under partial parse); validator independently enforces the same coverage; failureProfile carries coverage | VERIFIED-RESOLVED |
| R3-B2 | "0 passing / 0 failing / N pending" at exit 0 → PASS (pending counted as executed); prose-only summaries; HARD infra patterns scanned whole-blob → false-INFRA on passing titles quoting error phrases | executed-total = passing+failing ONLY; summary-without-machine-counts invalid; HARD matcher line-scoped skipping pass-glyph (√/✓) lines; ✖ (U+2716) kept firing | VERIFIED-RESOLVED |
| R3-B3 | Host-exactness decided from the EVIDENCE's mutable environment block: reseed node/npm versions → every strict check politely skipped → fake PASS exit 0; report rendered forged bundle VERIFIED | `actualHostFingerprint()` samples the REAL runtime (incl. spawned npm --version); `proofHostContext` decides from reality only; new binding assertion evidence-environment↔proofHost; `proofVerdict`: any skip ⇒ INCOMPLETE exit 2 (never PASS); report adds host-attestation note ⇒ UNVERIFIED | VERIFIED-RESOLVED |
| R3-B4 | runId/tarball digest/argv/envKeys/classification-tuple re-sealable coherently (manifest recomputes; no independent source consulted) | verifyRunIdentity (runId↔directory, exp-<id>- prefix, retained fixture.tgz re-hash); required proof pin of tarballSha256; verifyClassificationDerivation (bytes→classify()+guard, full tuple incl. REASON + reproductionCount); hostBoundEvidenceChecks (argv via committed-spec re-expansion, envKeys via sanitizer re-evaluation, proof-host only); exact-SET identity equality vs membership | VERIFIED-RESOLVED |
| R3-B5 | Wrapper-mediated bypass: `cmd /c npm install…`, powershell/env/sh/xargs, pnpm/bun/corepack frontends passed the first-token check and ran package managers with ZERO isolation | `assertSupportedSpecExecutable`: closed literal allowlist (only `node`; `$npm/$yarn/$tsc/$bin:` tokens policed at expansion); everything else fail-closed; `node <pm file>` argument shapes rejected by basename | VERIFIED-RESOLVED |
| R3-B6 | Tree observation discarded after hashing: tree facts (hash/status/copies/drift) referenced no retained bytes → re-sealable at will; version-less nodes flattened to silent `'x'`; descendants of nested copies not recognized by subtree test | per-arm retained snapshots (raw stdout/stderr + canonical flatten, arm-DERIVED names); anomaly vocabulary (`missing-version`/`unwalked-subtree`/`malformed-node`); ANY anomaly caps at INCOMPLETE; trustful verdict requires snapshots + EMPTY anomalies + validator attestation-consistency; independent iterative re-flatten in verify-tree.ts re-derives hash/status/copies/anomalies/drift; `inDependencySubtree` full-segment semantics | VERIFIED-RESOLVED |

Secondaries (same recovery): post-summary fatal-crash signature `crashSignal`
and failed containment sweep `sweepFailed` feed rule 1; fetch/extraction
failures → `InfraAbort` (exit 2) not misuse (exit 3); candidate copy-count
log fixed (real count, not placeholder).

## npm 11.19 compatibility finding (KEEP; deliberately NOT a proof-host migration)

npm ≥ 11.19 renders NOT-installed OPTIONAL dependencies as empty `{}` nodes.
The flatten treated every version-less node as a hole → false INCOMPLETE
observations → trustful golden runs became INCONCLUSIVE on newer hosts.
Fix: a version-less, flag-less, subtree-less, zero-key node whose name is
token-anchored in NO `problems` entry is an expected-absent optional (no
anomaly, no flat entry); genuinely-missing required deps keep
`missing:true`/problems entries and FAIL CLOSED. Encoded independently in
BOTH flatten implementations (pipeline recursive, verify-tree iterative) and
pinned by a cross-implementation PARITY suite. The canonical proofHost
(win32/x64, node v26.3.0, npm 11.16.0) was NOT re-cut: 11.16 never emits the
`{}` shape, the golden normalized hashes remain reproducibly exact there,
and the drifted 26.7.0/11.19.0 host is recorded as ADDITIONAL cross-version
robustness evidence (22 portable assertions executed, 6 host-exact skipped →
honest INCOMPLETE).

## Internal adversarial self-review (this session) — findings-first record

Method: role-switch to a reviewer who did NOT write the fixes; per invariant
— state it, hypothesize ≥2 violations, inspect code + tests, probe the BUILT
dist, then record → remediate → regression-test. 22 targeted mutations run
against compiled output (restored by forced rebuild; zero residue verified).

| # | Severity | Finding | Why tests missed it | Remediation + regression |
|---|---|---|---|---|
| N1 | MINOR (test-coverage) | npm-11.19 `{}` exemption on the PIPELINE flatten had no direct unit test (only the verifier side did); the canonical 11.16.0 CI host never emits `{}` → the false-INCOMPLETE bug could silently regress with green CI | pipeline `treeHash` was unexported and only exercised live | Extracted pure `flattenNpmLsJson()`; new `tree-flatten.test.ts` (25 tests) incl. 13-case cross-implementation parity; mutation M14/M1 confirms 4 detections |
| N2 | MAJOR (prove/check inconsistency) | Unparseable npm-ls output: pipeline recorded anomalies `[]`, verifier derives `['json-parse-failure']` → verifyArm anomaly-equality FALSELY rejects an honest INCONCLUSIVE bundle: a truthful garbage-tree run could never be proved/reported (exit 3 / permanently UNVERIFIED) | No test fed garbage `npm ls` output through BOTH paths | Pipeline now records the same parse markers; parity suite pins both spellings; mutation removing markers fails 3 tests |
| N3 | MAJOR (validator bypass) | A fabricated **PASS** bundle omitting `infraSignal` on every round validated CLEAN (`isTrustworthy()`==true): the §4 "cannot re-derive" refusal named only CONFIRMED_REGRESSION/PRE_EXISTING_FAILURE — PASS skipped the classifier re-derivation entirely | sparse-facts test used a CONFIRMED label only | §4 now rejects ANY trustful label (§3's own set); repro P1 before-fix, regression test after (M-reversal verified: restoring the old clause fails the new test) |
| N4 | MINOR (docs-in-code truth) | Executor comment claimed "Failure glyphs (✗/×) deliberately EXCLUDE" — false: ✗/× ARE in the SOFT-skip set; only ✖ (U+2716) is excluded (the behavior is right; the comment lied) | Comments aren't executed | Comment corrected to actual semantics; glyph-boundary test pins ✖ fires / ✗ title prose does not |
| N5 | DOCUMENTATION (conservative limit) | Two REAL distinct failures with genuinely identical suite-qualified titles (legal in mocha: same describe/it in two files) dedupe to 1 identity < reportedFailing → rule 11 INCONCLUSIVE where a human would confirm | No fixture exercised duplicate legal identities | Accepted (never false-trust; the safe direction), documented in ledger + pinned by probe-P4 test |
| N6 | MINOR | V8 native CHECK-failure banner `# Fatal error in…` matched NO crash pattern — a post-summary native abort could pose as an ordinary failing round (byte-re-derivation can only flag what the matcher sees) | Crash tests covered OOM/segfault/core-dumped phrasing only | CRASH_LINE extended with anchored `^\s*#\s*Fatal error in[ ,]` (comma anchor prevents `# Fatal error info` false-fire); 4 new assertions |
| N7 | (resolved-as-design) | prove REFUSES an un-anchored non-trustful bundle (exit 3) where report merely says UNVERIFIED — intentional: prove asserts a committed expectation and refuses to certify anything it cannot fully re-derive; documented in code + this ledger | — | no change |
| N9 | MINOR (trust-bearing input unpinned) | `assertProof` consumed `proof.schema` without ever validating it — a proof file authored for another expectation layout would be silently interpreted under v1 semantics (proof-version confusion) | golden proof is schema:1 and no negative test existed | new portable assertion `proof schema == 1` (+ test for schema 2/0/missing) |
| N10 | MAJOR (test-coverage, mutation-discovered) | Deleting the experiment-identity pin from `assertProof` left ALL 320 tests green, yet it is load-bearing for the standalone API (a copied+renamed run directory with coherently resealed runId/experimentId/manifest satisfies verifyRunIdentity — only the proof's own identity anchor refuses it) | CLI-flow tests hit EARLIER guards; the unit layer was never isolated | new direct assertProof unit test; mutation re-run now detected (was 0/3 suites failing → 1 failing) |
| N21 | DOCUMENTATION | README/SECURITY/PLAN/fixture README/prove-notes carried round-2-era numbers (196 tests, 13 packages, 16/24 assertions, "two hash assertions", "skips off-Linux", "across rounds AND runs") — all stale/wrong after round-3 code landed uncommitted | the interrupted session never reached its docs step | full truth pass: 320/45 counts, 36 canonical / 22+6 off-host (live-verified), proof-host scoping of cross-run claims, symlink-privilege skip named correctly, six-assertion host-exact set, exit-code semantics incl. report-UNVERIFIED=3 |
| N22 | DOCUMENTATION (integrity precision) | `sweepFailed` comment called it "same class as killedByTimeout" — overstated: killedByTimeout is pinned THROUGH proof-pinned exitCode −1; sweepFailed has NO independent anchor (integrity-only) | comment never audited against the pinning layers | comment corrected; SECURITY.md gains an explicit "Honest integrity limits" paragraph naming the residual |

## Mutation battery (22 mutations, compiled-dist only, all restored)

M1 leaf-collapse→12 fail · M2 zero-exec→5 · M3 infra-ignore→1 · M4 crash-
recheck→1 · M5 ownership-check→5 · M6 unknown-sub fail-open→3 · M7 empty-tree
→2 · M8 anomaly-cap→5 · M9 manifest→4 · M10 dup-round→1 · M11 trustful-tree
→1 · M12 skip-to-PASS→5 · M13 coverage-always-COMPLETE→7 · M14 11.19-exempt
off→4 · M15 exact-set→tautology→2 · M16 experimentId-pin removal→**0 (N10!)**
then 1 after fix · M17 verifyRunIdentity→4 · M18/20 snapshot/trustful-3b→4 ·
M19 rule-10→2 · M21 tarball-pin→1 · M22 always-skip→7. Post-battery forced
rebuild + full suite 319/1skip + source-hash comparison: no residue.

## Canonical-host reproducibility record (this session)

- Provisioning: OS-temp disposable toolchain (repo untouched, NOTHING committed,
  no global config touched). Official `nodejs.org/dist/v26.3.0/` win-x64 zip,
  SHA256 **ec6d0f6b056c89498a9b26c4d5c77a31fd0b7fe45ba8a45fa87d26f66c3ebce4**
  verified against the official SHASUMS256.txt (HTTPS). Bundled npm 11.16.0
  (exact canonical pin — no extra install). `node.exe` digest
  `35d366f67382f0ba791dcabeded8f6a6d5c77efee4d833f38c1dd3a1e6f160f8`.
- Proof run 1: **PASS 36/36, zero skips, exit 0** — host-exact assertions
  EXECUTED (normalized hashes byte-exact vs committed golden f37a8fb0/5e538c0b;
  env binding; runtime match; 5×argv + 5×envKeys re-derivations).
- Proof run 2: PASS 36/36, exit 0. Recursive comparison: every trust-bearing
  field byte-identical (classification tuple, counts, identities, tree facts,
  normalized hashes); only volatile fields differ (timestamps, durations,
  run-directory paths inside raw bytes/argv and their digests).
- Third run after the N9 proof-schema addition: PASS 36/36 again (35→36).
- Cross-version: on node v26.7.0/npm 11.19.0 the golden experiment still
  classifies CONFIRMED_REGRESSION rule 5 with VALID/VALID observations, ZERO
  anomalies, identical tree hashes to the 11.16.0 runs (logical flatten is
  representation-invariant), 22 portable assertions held, 6 host-exact
  skipped, INCOMPLETE exit 2 — current-host compatibility evidence, NOT a
  new canonical host.
- CI remains the designated standing proof-host environment (exact pins +
  npm@11.16.0; a drifted pin now makes `check` exit 2 and FAIL the job rather
  than skip-to-green). CI itself was NOT executed this session (push is out
  of scope) — statically inspected only.

## Final status (this ledger)

Suite 320 tests / 45 suites (319 pass, 1 Windows symlink-privilege skip);
typecheck clean; golden proof 36/36×runs on the canonical toolchain and
honestly INCOMPLETE(2) on the drifted host with all 22 portable assertions
executing; report VERIFIED on-record and UNVERIFIED for reseeded-host
evidence. Ten new self-review findings recorded; none unresolved as a release
blocker. See README/SECURITY for claims; see this ledger's N-table for what
the internal adversarial pass found and fixed BEFORE the independent Round-3
re-audit.

VERDICT: candidate frozen for independent re-audit (see final report).
