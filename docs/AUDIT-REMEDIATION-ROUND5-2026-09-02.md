# v0.1 audit remediation — ROUND 5 (POST-AUDIT SELF-FALSIFICATION) Ledger — 2026-09-02

Branch: **an observation-hardening branch** (lineage: frozen base `c1ff4e7`,
commits 1–4 = RED tests / attested-execution channel / matcher view /
execution-authority docs, commit 5 = `a87ae7f` pin forensics + review-manifest
anchor). Scope: the findings of an adversarial self-falsification pass over
the branch itself (producer-forgery pass, trust-boundary classification pass,
mutation/guard-removal pass, plus a 7-finding workflow panel whose output was
independently verified before any fix was accepted). This is NOT a new broad
audit; every fix is regression-first and lands with permanent tests.

## Finding table

| ID | Severity | Finding (verified) | Root cause | Fix (structural) | Status |
|---|---|---|---|---|---|
| P1 | HIGH (operational, proven live) | The `mocha@10.8.2` tree pin (`68a0a02c…`, recorded at probe time into `2f4a706`) matches NOTHING — no install, no tarball, ever produced it — so the golden proof could never reach the attested channel and the branch's own headline claim ("legitimate golden works via real mechanism") was false off paper | The pin hash was a single human/probe recording with NO offline anchor: nothing in the repo allowed a reviewer (or a test) to check what bytes the hash was supposed to describe | Root-caused three independent ways: golden-era fixture tree, clean `npm install --ignore-scripts mocha@10.8.2` (69 files), and the official registry tarball (sha256 `59884ed9…`, whose sha512 equals the registry `dist.integrity`) all fold to treeSha256 `4b811f5a…`. Pin corrected; committed review manifest `packages/support/test/fixtures/runner-manifests/mocha-10.8.2.npm.txt` (per-file digests + provenance header) is now the anchor and `known-runners-manifest.test.ts` RECOMPUTES every npm-pin's treeSha256 from manifest bytes (same fold encoding), demands the header's integrity record, and pins that the canary-double has NO manifest (it is not registry content) | FIXED (`a87ae7f`; live-verified: canonical prove exit 0, 36/36, 5× VALID, 130 frames/round, fixtures diff empty) |
| P2 | MAJOR (docs truth) | The only claimed pin-drift guard was a "proof-host test" that did not exist — the failure class could recur silently and docs asserted the guard | Documentation of a guard without the guard | Same architectural fix as P1 (offline anchor + recompute test); every doc claim about pin provenance updated to describe what is actually enforced vs. what human review of the manifest guards (a faithfully-recorded hash for a malicious release remains a TOFU ceiling — said plainly in EXECUTION-AUTHORITY §3) | FIXED |
| F1 | MEDIUM | A would-be PRE_EXISTING_FAILURE whose candidate fails an identity the baseline never saw fail (watched pass→fail, or disjoint failing sets {A} vs {B} at equal totals — baseline 1P+1F vs candidate 0P+2F) was labeled PRE_EXISTING_FAILURE: a regression swallowed into "already broken", contradicted by Canary's own retained identities | Rule 13 checked cross-arm cardinality only; "same experiment" was never enforced on the failing-identity side where Canary HAS authority (observed failing identities are in the contract) | Rule 13 extended: containment over failing sets (`candidate ⊆ baseline` observed failing identities) fires for the would-be-PEF path; `validateBundle` panel-H restates it (bypass detection); honest PEF/CR pinned to keep flowing. Deliberately NOT extended to passing-side identities — that would deny legitimate renames and needs a semantic root Canary lacks; the substitution ceiling is codified by a permanent test and §7/§8 wording | FIXED |
| F2 | HIGH (trust boundary) | The schema mirror's "independent enforcement" was partly borrowed: `validateBundle` imported `STRONG_EXECUTION_LABELS` from the classifier, so deleting the classifier's constant list (or drifting it) silently re-keyed the mirror too | Mirror keyed on the very code it was supposed to independently re-derive | `STRONG_MIRROR_LABELS` declared INDEPENDENTLY in the schema package; a test pins notStrictEqual + sorted deep-equality with the classifier list — neither silent drift nor silent divergence. §3/§11 wording made true | FIXED |
| F3 | MEDIUM | EXECUTION-AUTHORITY §11 row 2 promised unparseable frames, `adapter-error` and masked-exit were permanently pinned; four validator branches (`unparseable-frame`, `frame-not-object`, `adapter-error`, `exit-contradiction-masked`) were live but reached by NO test anywhere | Coverage claim outran coverage fact | Layer-1 test (xi) in `attested-channel.test.ts` condemns the round via each branch (garbage line, bare `5`, adapter-error frame, exit-0-with-failing-counts at agreeing channels) | FIXED |
| F4 | MEDIUM | Rule-14 routing tests covered strong producers and FLAKY producers 2–5 only; deleting the gate for producers 6/7/8/12 passed the entire suite (mutation-proven) — exactly the asymmetry F2 names | "all strong + FLAKY producers" was claimed but only half pinned | Four routing tests, each with an ATTESTED-TWIN test proving the fact shape genuinely reaches its producer before the gate is applied (a dead routing path would flip the twin red) | FIXED |

## Panel kill (recorded, NOT fixed)

| Claim | Adjudication |
|---|---|
| Panel-H mirror accepts a VALID observation with `frameCount: 0` / `framesSha256: EMPTY_SHA256` on clean rounds | **VACUOUS — killed before fix.** The mirror has no frame bytes to compare against; a forger smart enough to write the zero-frame variant writes `hello`+`bye` with matching fields instead. This is the §8 total-forgery ceiling restated, not a new hole. Calling it a finding would mis-spend the ceiling contract; no code changed. |

## Regression-first record

- F1/F4 reds were confirmed against frozen `a87ae7f` by the panel's
  adversarial verification step before any fix.
- **Guard-removal battery (PASS 3) — 10/10 CONFIRMED-RED:** each guard was
  neutralized in a type-valid way (one-line mutation: gate→null; `false`-
  condition / `Number('mutant') < 0`-condition to skip a block while keeping
  flow-narrowing; hash char-flip; constant-list element drop) and its named
  battery went RED, then `git checkout -- .` restored — **no mutation exists
  in any committed tree.** M1 gate (classify 98 + exec-authority 8 red
  marks); M2 panel-H block (schema 4); M3 prove attest-bytes binding
  (verify-tree 6 — see below); M4 matcher view→identity (ANSI/LF battery 11);
  M5 pin ignores tree hash (executor 6 + attested-channel 6 — the tampered-
  double e2e catches it, i.e. a version-only pin would have INJECTED the
  observer into non-canonical bytes); M6 rule-13 containment (classify 6);
  M7 mirror containment restatement (schema 4); M8 classifier list loses
  FLAKY (classify 13); M9 pin/manifest divergence (both pin batteries 4+4);
  M10 mirror list loses FLAKY (equivalence test, 4).
  Two battery lessons recorded honestly: (i) a `false &&`-prefixed condition
  silently removes TS flow-narrowing and fails the BUILD, not the battery —
  an untype-valid mutation proves nothing; (ii) M3 initially GREEN against
  `prove.test.js` because the discriminating test lives in
  `verify-tree.test.ts` ("caught ONLY by the bytes binding") — the guard is
  protected, the first battery targeted the wrong file. A battery's file
  choice is itself a claim that needs mutation-checking.
- P1's red is the strongest kind: the canonical golden proof running
  INCONCLUSIVE on the exact pinned toolchain pre-fix (attestation ABSENT —
  version matched, hash did not), exit 0 post-fix.

## Accounting

Suite baseline: `423/60/422/0/1` (end of commits 1–4) → `425/61/424/0/1`
(commit 5, manifest anchor +2) → `438/64/437/0/1` (this commit: +9 classify
[F1 ×5, F4 ×4], +3 schema [equivalence, containment refusal, honest-PEF],
+1 attested-channel [(xi])). The 1 skip remains the platform-conditional
symlink test. Golden expectations untouched: 36 assertions, `proof.json`
byte-identical, `fixtures/axios-0.27-to-1.0/specs/` never edited (F1's
containment cannot fire on the golden shape — baseline failing set is ∅).
