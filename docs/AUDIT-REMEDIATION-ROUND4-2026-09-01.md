# v0.1 audit remediation — ROUND 4 Ledger — 2026-09-01

Branch: **the round-4 remediation branch**, created from and only from the frozen
pre-remediation candidate **`a0baa0c8bd1000010602a47ed34bbd27d8961d5f`**
(branch `reaudit-hardening`, tracked tree clean at session start — verified
before any change). Scope: the confirmed findings of the final
independent review of that candidate (RB-1, RB-2, M-1, M-2, F1) plus assessed
secondaries. This is NOT a new broad audit; every fix is regression-first
and every red was captured against the frozen behavior before the fix.

Method notes: the empirical npm semantics that drove RB-1 and M-2 were
probed against the REAL package manager on both the drifted dev host
(npm 11.19.0) and the canonical toolchain (npm 11.16.0 from the official
Node v26.3.0 zip, SHA-256 `ec6d0f6b…` verified — zero global config touched).

## Finding table

| ID | Severity | Finding (independently reproduced) | Root cause | Fix (structural) | Status |
|---|---|---|---|---|---|
| RB-1 | RELEASE BLOCKER | npm accepts semantically equivalent config forms after Canary's injected flags: `--no-ignore-scripts`, `--userc=…`, `--reg=…`, `--location=global` all survived the textual denylist; "protective package-manager configuration cannot be overridden" was not structurally guaranteed | The policy was a closed allowlist for EXECUTABLES and SUBCOMMANDS but an EXACT-STRING DENYLIST for OPTIONS, and injection was spliced before user tokens — npm's CLI layer (probe-verified on 11.16 AND 11.19) expands unique-prefix abbreviations (`--ig`→`--ignore-scripts`), applies `--no-` negations, and is LAST-WINS, while ignoring case/camel/ambiguous/unknown forms | (a) install-family options moved to a CLOSED EXACT-SPELLING ALLOWLIST (property-tested prefix-disjoint from the protected key universe; value-taking entries forced to `=` form so no token can swallow the following argv slot); (b) Canary's protected flags now APPENDED AS ARGV SUFFIX — last-wins makes the effective protected configuration structurally Canary's; (c) non-install families reject any option resolving (case-fold, one-`no-` strip, prefix-expansion) toward a protected key, plus the per-package family `--@scope:registry`/`//…:auth` everywhere; (d) `--`/short options stay rejected in install family so nothing can follow the suffix | FIXED |
| RB-2 | RELEASE BLOCKER | Suite collapse produced strong verdicts: 128→1 executed tests → PASS rule 3; unstable repetitions (128,1) → PASS rule 3; 128→1+127 pending → PASS rule 3; 128→1 stable failing → CONFIRMED_REGRESSION rule 5 | The decision table required only ≥1 executed assertion per round (round-3 B2) and reasoned from exit codes + failure profiles, never from COVERAGE TOTALS across arms/repetitions | New invariants computed from the experiment itself (no hard-coded minimum): rule 12 — per-arm repetitions must share executed (passing+failing) and observed (+pending) totals, else FLAKY; rule 13 — PASS/CONFIRMED_REGRESSION/PRE_EXISTING_FAILURE additionally require cross-arm comparability of both totals, else INCONCLUSIVE. validateBundle carries an INDEPENDENT parity mirror (+≥2 trustful rounds, dense indices) so the refusal survives a decision-table change. Legitimate pass→fail transitions at stable totals (Axios 128→125+3) still confirm | FIXED |
| M-1 | MAJOR | Runtime validation accepted resealed evidence missing `commands`/`killedByTimeout`/`startedAt`/`durationMs` (published schema rejects them); the published schema rejected legitimate round-3 evidence (`snapshots`, `observationAnomalies`, `crashSignal`, `sweepFailed`); two independent definitions had drifted | The JSON schema file and validateBundle's hand-written checks had no shared source; unknown-field policy differed (schema strict, runtime permissive) | `packages/evidence/schema/src/contract.ts` is now the single source: `buildPublishedSchema()` GENERATES schemas/evidence.schema.json (committed file regenerated; test deep-compares — drift fails CI in both directions), `structuralIssues()` drives the runtime presence/type/unknown-field floor; trustful-tier fields are declared once and expressed as schema `if/then` + semantic-layer refusal (anomaly-presence/emptiness); intentional-optionality documented by the tier itself; round indices must be dense 1..n per arm | FIXED |
| M-2 | MAJOR | Producer and verifier both treated a generic empty `{}` dependency node as an intentionally-absent optional even without retained evidence supporting optionality (synthetic required-but-empty + no problem info → VALID) | The `{}` exemption keyed only on "zero keys ∧ ¬missing ∧ ¬mentioned-in-problems", reading a MALFORMED or CONTRADICTED problems channel as silence, ignoring the retained stderr channel, and unbounded in depth/size | Narrowest evidence-supported condition (probe-grounded: npm never renders an unmet REQUIRED dep as `{}` — it carries `missing:true`+`problems`+ELSPROBLEMS+exit 1): `{}` is expected-absent only when problems is absent-or-string[] (malformed → `malformed-problems` + no exemption), the error channel is not contradicted (ELSPROBLEMS demands non-empty problems — MONOTONIC, see self-review R4-SR1), the name is token-unmentioned, and the node is flag-free; the studied dependency can never be excused into presence (absence → INCOMPLETE). Both parsers gained identical traversal budgets (200k nodes/depth 128) and the verifier reads the RETAINED stderr artifact (realpath-confined, closing the tree-artifact symlink gap); producer/verifier parity pinned over the full matrix including every channel state | FIXED |
| F1 | MAJOR (report semantics) | A locally self-consistent bundle renders `report → VERIFIED` while `check → FAIL`, because report never compares against the committed proof — the word overstated the property | Naming: status vocabulary conflated "consistent with local artifacts" with "verified" | Status renamed SELF_CONSISTENT / NOT_SELF_CONSISTENT (compile-forced rename at every call site); the banner carries the committed-proof disclaimer in BOTH directions and points at prove/check; CLI help/header/console text updated; exit-code semantics unchanged (0 = self-consistent locally, 3 = otherwise) and now explicit; permanent test proves the distinction on identical bytes (report self-consistent, check FAIL against a diverged proof); absence of any verification render defaults to NOT self-consistent | FIXED |

## Self-review findings discovered BY the remediation itself

| # | Finding | Resolution |
|---|---|---|
| R4-SR1 | The first M-2 corroboration rule required problems⟺ELSPROBLEMS BIDIRECTIONALLY — the golden drift e2e flipped rule 9→10: probe showed npm's extraneous-only trees list `problems: ["extraneous: …"]` while exiting 0 with EMPTY stderr (report channel vs error channel). Bidirectional consistency would cap every honest extraneous tree at INCOMPLETE | Contradiction made MONOTONIC (ELSPROBLEMS ⇒ non-empty problems, never the reverse); both parsers updated identically; behavior pinned by a dedicated test naming the extraneous-only shape; re-verified live on the golden fixture on both hosts |
| R4-SR2 | RB-2 fixture archaeology: several long-standing test fixtures encoded incomparable coverage (baseline 5 executed vs candidate 5+3 etc.) because the old table ignored totals; naive application of rule 13 would have masked their ACTUAL subjects (rule 8/11 behavior) behind coverage refusals | Fixtures rebalanced to comparable totals with inline comments explaining the invariant; rule ORDER chosen so diagnostics stay specific: 12/13 fire only where nothing more-specific fired (8/11 precede them; 13 gates only strong outputs). The RB-2 section's four red cases were confirmed against the FROZEN classifier before the fix (all four reproduced exactly) |

## Regression-first record (red captured BEFORE each fix)

- RB-1: old `pmArgvPolicy` ACCEPTED all of `--no-ignore-scripts`,
  `--userc=evil.npmrc`, `--reg=https://evil.example/`, `--location=global`
  (and the untested `--@x:registry=…`) — output recorded, then fixed; the
  new property test generalizes over every prefix/negation/case/`=` spelling
  of every protected key, in both argv positions.
- RB-2: frozen classifier returned `PASS rule 3 / PASS rule 3 / PASS rule 3 /
  CONFIRMED_REGRESSION rule 5` for the review's four cases and `CONFIRMED_REGRESSION
  rule 5` for the Axios shape — all four reproduced against the compiled
  candidate, then fixed; 9 new red tests went green with the rules.
- M-1: deletions of `commands`/`killedByTimeout`/`startedAt`/`durationMs`
  from a valid bundle were runtime-accepted pre-fix (confirmed by review); the required-field
  matrix test now proves every always-required contract field is enforced at
  runtime, and the committed schema file is deep-compared against the
  generated one.
- M-2: malformed-string `problems` producer/verifier differential and
  silent-problems-under-ELSPROBLEMS both fail closed now; the real captured
  11.19 fsevents/ws `{}` samples stay VALID (compatibility kept, canonical
  hashes unchanged).
- F1/secondaries: old `actualHostFingerprint` CRASHED with a poisoned
  inherited `NODE_OPTIONS` (recorded pre-fix); old matchers missed
  lone-CR summary lines (recorded by the new CR test failing pre-fix logic);
  tree-artifact reads had no realpath confinement.

## Verification results (this session, on this branch)

- Full suite: **371 tests / 52 suites / 370 pass / 0 fail / 1 skip**
  (skip = pre-existing unprivileged-Windows symlink case). Prior candidate:
  320/45. No prior coverage removed; every changed fixture is documented
  (R4-SR2) and the historical suites all still assert their originals.
- Golden fixture (ctimmerm/axios-mock-adapter @ b8804442, axios 0.27.2→1.0.0,
  tarball pinned 1343cae70b70d682ab6bfd46d7707d29403ed60a089ef2029a5c7bbf368ff640):
  CONFIRMED_REGRESSION rule 5; baseline 128 passing ×2, candidate 125 passing /
  3 failing ×3; three distinct suite-qualified identities — reproduced fresh on
  BOTH hosts.
- Canonical proof host (win32/x64, node v26.3.0, npm 11.16.0 via official zip,
  SHA verified, zero global changes): `prove` = **36/36 assertions, zero
  skips, exit 0 — expectation file UNCHANGED** (no re-anchoring; the suffix
  argv shape is self-derived on both sides; normalized hashes unaffected).
  RB-1's semantic premises (abbreviation/negation/last-wins/scoped-registry/
  case-ignore) re-probed on 11.16 and identical to 11.19.
- Drifted current host (node v26.7.0, npm 11.19.0): fresh full prove run →
  all 22 portable assertions held (incl. rule 5 + exact identities + tree
  VALID via live 11.19 `{}` nodes under the narrowed rule), 6 host-exact
  SKIPPED → **INCOMPLETE, exit 2 — host mismatch cannot produce PASS**;
  `check` against the canonical evidence behaves identically.
- `report` on real canonical-host evidence: **SELF-CONSISTENT** banner with
  committed-proof disclaimer, exit 0; word VERIFIED gone (CLI + HTML).
- Mutation sample (7 mutations applied to dist-compilable source, each
  restored immediately; post-run git clean, suite green): M1 suffix-placement
  → detected (tests fail), M2 rule-13 gate → detected, M3 runtime floor
  removed → detected, M4 corroboration gate → detected, M5 validator mirror
  removed → detected, M6 report default-status flip → detected, M7 install
  allowlist enforcement → detected. **7/7 detected.**

## Secondary findings — assessment

| Item | Decision | Why |
|---|---|---|
| Deep dependency-tree inputs unbounded | FIXED | small budgets + fail-closed anomalies + parity-pinned constants (part of M-2 commit) |
| String-valued `problems` producer/verifier differential | FIXED | channel now requires absent-or-string[]; the whole malformed class fails closed identically in both parsers |
| Host sampling inherited verifier env | FIXED | sanitizedEnv at the spawn; regression test with poisoned NODE_OPTIONS |
| CR-only line endings asymmetry | FIXED | CR/CRLF→LF at every fact-matcher/parse entry (artifacts stay byte-exact; prove re-derives through the same functions) |
| Tree snapshot reads lacked realpath confinement | FIXED | readArtifact mirrors the audit-B3 discipline (basename + realpath containment) |
| runId primarily bound to workspace basename | **DEFERRED** | a content-derived run identity (e.g. digest over spec+first-round bytes embedded in the directory naming convention) changes the workspace layout, the run-directory convention, verifyRunIdentity, and the proof's provenance records simultaneously — not small, not invariant-clear without that layout decision; today's binding (runId↔directory + convention + tarball-bytes + committed proof pins) fails closed against reseals; documented |
| Validator accepted 1-round/gapped arms (audit residual) | FIXED (this round) | ≥2 rounds per arm under trustful labels + dense 1..n indices — both landed as part of RB-2/M-1 |

## Remaining limitations (deliberate, documented)

- `{}`-as-optional remains by construction indistinguishable from a forged
  complete tree with a consistent fake stderr — integrity-only ceiling
  (SECURITY.md "Honest integrity limits after rounds 3–4"); the studied
  dependency can never be excused into presence, and the proof-host argv
  re-derivation stands behind tree claims on the designated host.
- RB-2 comparability reasons from run summaries; a suite that shrank before
  BOTH arms ran carries no cross-arm signal — the committed proof's pinned
  summaries are the anchor there.
- Install-family POSITIONAL package specs remain spec-authored (out of RB-1
  scope: the isolation CONFIG is protected; arbitrary-position drift is
  caught by the confinement rules; scripts are disabled regardless).
- npm ≥12 will hard-reject unknown CLI flags (deprecation warnings observed);
  Canary's allowlist never sends unknown flags, so this future-tightens
  rather than breaks. The policy's abbreviation universe is npm 11.x's;
  new npm majors must be re-probed (SECURITY/PLAN do not claim otherwise).
- Cross-platform: Linux paths remain written-not-executed (unchanged posture;
  CI's ubuntu legs run on push only).

## Commits on this branch (since a0baa0c8)

1. RB-1 fix — semantic package-manager policy + CR-ending parity
2. RB-2/M-1/M-2 fixes — coverage-consistency verdicts, one evidence
   contract, evidence-backed empty nodes
3. F1+secondaries fixes — SELF-CONSISTENT report wording, env-safe
   host sampling
4. Docs — this ledger + documentation truth pass
