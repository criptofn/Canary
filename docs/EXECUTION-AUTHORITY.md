# Canary Execution Authority — what a strong verdict actually proves

**Scope:** v0.1, branch lineage post-GLM observation hardening (base `c1ff4e7`;
commits `d8fbcdb` RED batteries → `2f4a706` channel → `eb61f61` matcher
symmetry). This document is the *claim contract*: it states, for each class of
evidence, **who produced it and what it can and cannot prove**. The security
contract that also covers process/env isolation lives in
[`SECURITY.md`](SECURITY.md); execution authority is the part of it that
decides whether a run *counts as a test run*.

## 1. Why this document exists

A GLM-5.3 audit (2026-08-31, finding A, HIGH) demonstrated that the shipped
classifier could return **PASS** for:

```
node -e "console.log('128 passing (1s)')"
```

with **no test runner installed at all**. Nothing was wrong with the
byte-level evidence layer — the bundle faithfully recorded exactly what the
process printed. The layer's implicit premise was wrong: **printed text was
being treated as proof that tests executed.**

The governing principle, now structural:

> **NO PROOF, NO DONE.** A subject must not be able to create strong positive
> evidence merely by printing text that looks like test output. **A producer
> cannot certify its own execution.**

The fix is at the level of **evidence authority**, not output heuristics: no
`passing > 0` threshold, no keyword blacklist, no `node -e` special case —
those are treadmills a hostile string can cross. Instead: a **strong verdict
requires every execution fact to be Canary-controlled or independently
derived**, and text is demoted to a claim that must *agree* with what Canary
watched. If no trustworthy observation adapter exists for a round, a strong
verdict is **structurally unreachable** — the run degrades to
INCONCLUSIVE/INFRASTRUCTURE_FAILURE. There are no confidence scores: a verdict
is either backed by this authority chain or it is weak. Prefer narrow +
correct over broad + fake.

The exact counterexample is a **permanent regression test**
(`apps/cli/test/execution-authority.test.ts`), as are its prose variants and
the printed-failing-summary variant (which previously produced
CONFIRMED_REGRESSION from text alone — now rule 14).

## 2. The trust ladder — four distinct facts, never conflated

```
PROCESS-LAUNCHED          Canary spawned this argv with Canary-derived argv
                          (sanitized-env record; the only tier that is fully
                          Canary-side by construction).
PINNED-RUNNER-EXECUTED    that argv ran inside a runner whose ON-DISK BYTES
                          match a Canary-pinned release (treeSha256), with a
                          Canary-authored in-process observer injected via a
                          protected, last-position --require.
RUNNER-CLAIMED-N          the runner's stdout text summary says "N passing".
                          A claim. Downgrade-only: text may refute the
                          channel, never establish counts.
CANARY-OBSERVED-N         Canary's observer, running inside the pinned
                          process, watched per-test lifecycle events on a
                          private channel (fd 3) and recounted N itself.
```

These are **different**: launching a process does not mean a test runner ran
it; a runner executing does not mean the counts are its; and the runner
claiming 128 does not mean 128 tests ran. A strong label requires
**PINNED-RUNNER-EXECUTED + CANARY-OBSERVED-N with cross-channel agreement**
against RUNNER-CLAIMED-N on every round of both arms (rule 14, §5).

The tier was deliberately *not* called "TEST-RUNNER-EXECUTED": the surviving
design attack (`attack:forger`, HIGH) was a **shipped `node_modules/mocha`
double** — a program that is API-faithful enough to hold the observer's hooks
without ever running the suite. That is exactly why the tier names
**bytes-pinned releases**, not "a test runner", and why the honest ceiling of
the whole channel is stated in §7.

## 3. The attested-execution channel (mechanism, truthfully)

- **Where observation is born:** `Recorder.expandArgvWithPlan`
  (`packages/runner/executor/src/`) resolves `$bin:mocha` to the real
  package directory; it computes the package's canonical **treeSha256**
  (sorted `path \0 sha256(bytes) \n` over regular files, excluding
  `<pkg>/node_modules/**` and the root `.package-lock.json`; a symlink
  anywhere throws → treated as a pin miss) and compares `(name, version,
  hash)` against `KNOWN_RUNNER_RELEASES` (`packages/support/src/knownRunners.ts`).
- **Injection is the whole gate:** injection credit additionally requires the
  token to OCCUPY THE EXECUTED RUNNER POSITION (post-GLM F1): expanded argv
  must be `[execPath, <pinned bin>, …]`, i.e. `$bin:mocha` must be spec argv[0].
  A trailing token is inert script argv — `['node','-e',<forger>,'$bin:mocha',…]`
  runs the forger, and the appended `--require` lands in the script's own
  argv — so an off-position token is refused fail-closed
  (`mocha-bin-not-executed` → InfraAbort), the same posture as
  `subject-require-refused`: subject-controlled argv is refused, not parsed.
  Then, and only on a pin hit, Canary appends
  `--require <canaryPreloadPath>` **last** inside argv, for a Canary-authored
  preload written outside the artifacts dir. **Miss ⇒ no injection at all ⇒
  ABSENT ⇒ strong labels structurally unreachable.** Unpinned is never an
  error — the subject simply cannot earn strength. Any supported future
  mocha release = one added line to the pin table.
- **Pinned releases today (TOFU):** `mocha@10.8.2` and
  `mocha@0.0.0-canary-double` (Canary's own offline test double,
  byte-identical to its fixture under `.gitattributes` `text eol=lf`). The
  npm pin's hash is anchored **offline**: the committed review manifest
  `packages/support/test/fixtures/runner-manifests/mocha-10.8.2.npm.txt`
  records the official registry tarball's per-file digests (tarball sha256 +
  registry sha512 integrity in its header), and a test recomputes
  `treeSha256` from those bytes and demands equality with the pin — so a
  mis-recorded hash (the round-5 `68a0a02c` incident, which matched nothing)
  cannot survive review. A hash can still be *faithfully recorded for a
  malicious release*: human review of the manifest is what guards that, not
  code. The table is **trust-on-first-use**: human-reviewed additions,
  **no cryptographic trust root — we say so plainly** (§6).
- **The channel:** every measurement spawn pipes child fd 3 back to the
  parent (even un-injected ones — an unrequested write to fd 3 is *adapter
  emulation* and is retained forensically as `strayFd3Bytes`/
  `strayFd3Sha256`). The preload emits NDJSON frames — `hello`, `pass`,
  `pending`, `fail`, `retry`, `reject`, `bye`, `adapter-error` — with
  identity = non-empty `titlePath()` joined by `' > '`. Only the preload
  writes fd 3, exactly once, after flushing `bye` on `process.on('exit')`.
- **Vocabulary:** **ABSENT** = Canary attempted no observation (no
  injection: `absentKind ∈ {not-mocha-bin, runner-identity-unpinned, …}`);
  **INVALID** = Canary attempted one and the channel failed to produce a
  trustworthy result (`invalidReason`, e.g. `empty-stream`,
  `hello-bye-boundary`, `bye-vs-recount`, `mochaVersion-vs-pin`,
  `pid-mismatch`, `duplicate-pass`, `rejected-event`, `flood-truncated`).
  A `reject` frame is treated as **evidence of attack, never of execution**.
- **Validation is one shared pure function** —
  `validateObservation` (`packages/runner/executor/src/observation.ts`) —
  used at capture, at prove-time derivation replay, and by the golden proof
  floor. No second implementation to drift.
- **The gate:** `observationGateIssue` / `STRONG_EXECUTION_LABELS`
  (`packages/core/classification/`): every round VALID; per round
  `observedCounts == text counts` under the audit-F1 `?? 0` semantics;
  failing-identity **set equality**; no exit contradiction (`failing==0`
  with `exit!=0`, or `failing>0` with `exit==0` — defense-in-depth). Malformed
  observations are a **refusal, never a crash**.
- **Independence, thrice over:** the gate lives inside `classify()` (pure, so
  all three re-derivation sites agree); `validateBundle`
  (`packages/evidence/schema/`) restates it from the bundle's own fields,
  keyed on `STRONG_MIRROR_LABELS` — its **own copy** of the strong-label
  constant (declared independently in the schema package; equality with the
  classifier's `STRONG_EXECUTION_LABELS` is pinned by a test, so the mirror
  can neither silently drift nor silently diverge); and additionally
  requires VALID rounds to name a pin-table release with both expected and
  observed runner hashes equal to the pin, and restates the
  PRE_EXISTING_FAILURE failing-set containment of rule 13 (§5)
  (`panel H`); `verifyArtifacts`
  (`apps/cli/src/prove.ts`) binds the per-round bytes — the artifact tuple
  grew 4 → 5 with `<arm>-<round>.attest.ndjson`, and `framesSha256` is bound
  to those bytes like every other digest. A bundle that reseals everything
  *except* the observation is refused (proven by test).
- **Subject-controlled argv is refused, not parsed:** a spec argv carrying any
  `--require` (or unambiguous abbreviation) targeting mocha makes Canary
  throw at expansion → `InfraAbort` → **INFRASTRUCTURE_FAILURE, exit 2**
  (policy refusals never crash as unexpected errors and never proceed).
- **Matcher symmetry (finding B):** infra/crash/summary matchers fold case
  and strip ANSI **at entry, view-only** — artifacts stay byte-exact — so
  neither `NPM ERROR` nor color escape sequences can hide an infrastructure
  failure or a crash, and colored pass titles cannot *fake* one (the glyph
  skip sees the same stripped view). A presentation property of text can only
  ever **weaken** a verdict, never strengthen it.

## 4. Claim scope — the honest label for the capability

What Canary now proves about a **PASS / CONFIRMED_REGRESSION /
PRE_EXISTING_FAILURE / FLAKY** verdict is precisely:

> **SUPPORTED TRUSTED MOCHA ADAPTER**: the experiment ran a Canary-pinned-
> bytes mocha release, Canary injected the observer, and Canary's in-process
> watcher counted lifecycle events that agree with the runner's own text
> summary — with all bytes bound into the evidence and re-derived at prove.

It is **not** "GENERIC TEST EXECUTION PROVEN". It does not attest jest/vitest/
ava/pytest execution (their adapters do not exist; rounds with them are ABSENT
— by design, fail-closed). It does not attest what the tests *mean* (§7).

## 5. Classifier rules 0..14 (full table)

Evaluation: gate computed first from raw per-round fields; if it holds, the
identity/coverage math reads **attested** counts/identities (the two channels
are equal wherever the gate holds — the switch is non-circular); then the
table runs; then rules 9/10 confinement guard on the post-gate result.

| Rule | Fires when | Label |
|---|---|---|
| 0 | missing baseline or candidate rounds | INCONCLUSIVE |
| 1 | any required round is not a valid test run (killed / crash sig / sweep fail / infra sig / no summary / no machine-readable counts / zero executed / exit-vs-summary contradiction) | INFRASTRUCTURE_FAILURE |
| 2 | baseline rounds disagree | FLAKY ⟶ gated |
| 3 | baseline clean + candidate clean | PASS ⟶ gated |
| 4 | broken before, broken after, **and** every candidate failing identity was already failing in baseline (rule-13 containment) | PRE_EXISTING_FAILURE ⟶ gated |
| 5 | baseline clean, all candidate rounds fail identically | CONFIRMED_REGRESSION ⟶ gated |
| 6 | baseline fails + candidate not uniformly failing | FLAKY (gated) / INCONCLUSIVE (passes through) |
| 7 | baseline clean, candidate mixed | FLAKY ⟶ gated |
| 8 | within an arm, failing rounds differ in count/identity (exit unanimity not sufficient) | FLAKY ⟶ gated |
| 9 | tree drift outside the studied dependency subtree (guard, after table) | INCONCLUSIVE |
| 10 | either arm's tree observation not VALID (guard, after table) | INCONCLUSIVE |
| 11 | failing round under-accounts its identities (partial parse) | INCONCLUSIVE |
| 12 | repetitions of an arm differ in executed/observed coverage | FLAKY ⟶ gated |
| 13 | arms' coverage totals differ under a would-be-strong result (suite collapse is never a verdict), **or** a would-be PRE_EXISTING_FAILURE whose candidate fails identities baseline never saw fail (post-GLM F1: a watched pass→fail transition is never swallowed, and disjoint failing sets describe no comparable transition) | INCONCLUSIVE |
| 14 | **post-GLM:** execution unattested / channel contradicted — strong or execution-claim label without VALID observation on every round (reason embeds "previously rule N LABEL") | INCONCLUSIVE |

Gating direction is **fail-closed only**: the gate can turn a strong label
weaker (rule 14), never a weak label stronger. Rules 0/1, 6's INCONCLUSIVE
arm, 11 and 13 are already weak and pass through ungated. FLAKY is gated
because it still *claims execution* ("tests ran, with differing results");
`TRUSTFUL_LABELS` (bundle-retention tier) and `STRONG_EXECUTION_LABELS`
(execution-claim tier) are two constants, never conflated.

**Channel precedence (post-GLM F4):** once the gate holds — every round
VALID and channel-agreeing — an infra-flavored KEYWORD in untrusted stdout
cannot veto the attested evidence: `attestedView` neutralizes the
`infraSignal`-only clause of rule 1, so an honest failing test titled
"(ERR_REQUIRE_ESM)" cannot bury a CONFIRMED_REGRESSION as
INFRASTRUCTURE_FAILURE. Signal death, crash signatures, and failed
containment sweeps stay in rule 1 unconditionally — they are trusted
process/forensic facts, or (crash) round-3 hardening prose can never
override. Text NEVER upgrades a verdict; this only removes prose's power
to suppress one.

## 6. Integrity ≠ provenance ≠ authenticated provenance

The manifest digest, byte re-derivation, and path confinement give **internal
consistency + tamper-evidence**: after the fact, one cannot alter a bundle
without detection **by the consumer who re-derives**. `prove`/`check`/`report`
re-derive each round's summary, counts, identities and observation from the
artifact bytes — so the bundle cannot misdescribe **what it recorded**.

The recorded bytes' *meaning* is the execution channel's job (§3): post-GLM,
bytes that merely look like test output carry no strength.

None of this is **authenticated provenance**: there is **no signing key, no
trust root, no attestation authority**. A forger who controls the entire
filesystem can recompute everything offline (the pre-existing documented
ceiling); the pin table is TOFU — Canary's own list, not registry-verified.
The real binding is *live*: the golden proof re-runs the experiment on the
committed proof host and asserts the re-derived facts against
`proof.json`/`spec`. Canary claims **integrity, plus observation by
Canary-controlled code inside the pinned process** — and says so wherever it
claims anything.

## 7. Residual limits (verbatim design-panel §3 — this wording is contractual)

> Canary's execution observation is an **integrity bound, not a trust root**.
> A strong verdict (PASS / CONFIRMED_REGRESSION / PRE_EXISTING_FAILURE /
> FLAKY) proves that Canary spawned the process with Canary-injected argv,
> that the runner's on-disk bytes matched a Canary-pinned release at
> expansion time, and that a Canary-authored in-process observer saw per-test
> lifecycle events on a private channel that agree with the runner's own text
> summary. It does **not** prove honest intent of code running inside that
> process: test files, `.mocharc.*`/`package.json` mocha config, or a
> prepare-installed dependency executing inside the genuine, byte-pinned
> mocha process can read the preload from the workspace, neutralize its
> hooks, and emit a fully protocol-faithful frame stream indistinguishable
> from a real run (8a/8a′); a suite can execute trivially-real tests under
> renamed identities (F3) — the ceiling is deliberately **passing-side
> only**: rule 13's containment demands every candidate *failing* identity
> was already failing under baseline, so substitution can never swallow a
> watched pass→fail transition into PRE_EXISTING_FAILURE, and binding
> *passing* identities across two package versions would deny strong
> verdicts to legitimate test renames (the boundary is codified by a
> permanent test in `classify.test.ts`); subject code can truncate or hold the channel
> (detected as INVALID/ABSENT — fail-closed, never forged); file replacement
> between the pinned-hash check and exec, and total offline forgery of the
> bundle, remain the pre-existing integrity-only ceiling. Weaker or
> unattested execution always resolves to INCONCLUSIVE/INFRASTRUCTURE_-
> FAILURE, never to a stronger label. Integrity ≠ provenance ≠ authenticated
> provenance.

The demonstrated finding-A class — printed text with **no runner installed at
all** — is structurally dead: it now requires simultaneously Canary-derived
injection, byte-pinned runner identity, and lifecycle-channel agreement,
none of which text can reach.

## 8. Unfixable without a crypto root — stated plainly (design-panel §4)

1. **\"This *test* named *X* asserted *Y*.\"** Attestation bounds the
   observable behavior of a pinned-bytes mocha-API-faithful program; it
   cannot certify semantics of arbitrary subject-authored test bodies running
   inside it. Closing that needs a signed, non-subject-code runtime
   (capability system / measured boot / remote attestation) — out of scope
   and against the north star's analysis-only posture.
2. **In-process self-emulation (8a/8a′)** — the emulator holds everything the
   observer holds (both are code in one process); no amount of channel design
   separates them without an external root of trust. AM-1 shrinks the
   *preconditions* (real pinned bytes must have been the process host) but
   cannot eliminate the class.
3. **Total bundle forgery** off-host and **TOCTOU** between hash-check and
   exec: pre-existing documented ceilings; unchanged by this design and not
   improved by it beyond making one specific instantiation (the no-mocha
   double) impossible.
4. **`process.exit`/abort mid-run**: indistinguishable from a legitimate hard
   crash; handled by fail-closure (ABSENT/INVALID → INCONCLUSIVE), not
   detection.

The design panel's judgment (recorded): AM-1 buys real claim strength —
runner *existence and bytes* — for an accepted maintenance list; if the
treadmill is ever judged too costly, the sanctioned fallback is the honest
restatement alone (drop the bytes claim, rename the tier to
RUNNER-API-CONFORMANT-EXECUTED, extend 8a′ to cover subject-supplied runners
entirely) — explicitly rejected as the weaker-but-defensible floor.

## 9. Runner-mode honesty: no parallel attestation

The adapter observes a **single-process** runner: the preload's hooks live in
the mocha process that fd 3 belongs to. Mocha's `--parallel` mode executes
tests in separate worker processes whose lifecycle this channel cannot see —
worker events would never reach the parent's fd 3, the text/observed recount
would disagree, and the round would degrade to INVALID/ABSENT → rule 14. In
other words: **unsupported runner modes fail closed toward weak labels, and
no claim is made for them.** Canary's supported adapter scope is the
single-process pinned-mocha shape named in §4.

## 10. Northstar adapter invariant (contractual documentation only)

The northstar-v0.2 foundation (`canary-northstar`) consumes v0.1 experiment
bundles at exactly one boundary: the `regression-free` obligation, which
reads the closed triple `{label, rule, confined}`. Today an independently
attested PASS and a legacy text-summary PASS serialize **identically** there.
The invariant this hardening establishes for that future bridge — **documented
here only; no northstar code is changed by this branch**:

> **The bridge must map an UNATTESTED PASS to NEUTRAL/UNPROVEN, never to
> positive.** A `PASS` bundle may set `regression-free` SATISFIED only when
> its `executionObservation` channel is VALID on every round and
> independently re-derivable from bound bytes (the bridge must read the
> observation from the bundle's recorded fields and re-check it against
> `KNOWN_RUNNER_RELEASES`, exactly as `validateBundle`'s mirror does). The
> distinction must travel as a **re-derivable channel, never as a
> producer-asserted scalar** — a record's self-declared `producerId` can
> never itself establish attestation (self-certification is the bug this
> entire document exists to kill).

Because the bridge, schema, and records layer live on the northstar branch,
this is stated as a **migration contract**: any future change connecting them
is required to satisfy it, and the attested-vs-legacy indistinguishability is
recorded as a known gap until then.

## 11. Where the attacks are pinned (permanent batteries)

| Attack class | Pinned by |
|---|---|
| printed `128 passing`, prose `node -e`, printed-failing-summary → previously PASS/CR by text alone | `apps/cli/test/execution-authority.test.ts` (the exact GLM reproducer, verbatim) |
| forged streams at validator level: empty / flood-truncated / unparseable / unknown-kind / hello-bye boundary / duplicate frames / `reject` / `adapter-error` / lying `bye` / forged version / pid / observerVersion / duplicate-pass / no-summary / masked exit | `apps/cli/test/attested-channel.test.ts` layer 1 |
| end-to-end: plain-node stub PASS pretense; unpinned double claiming strength; **forged frames from an unpinned fake** (ABSENT + stray-bytes forensics, zero credit); `--require` in spec argv; mid-run `process.exit` | `apps/cli/test/attested-channel.test.ts` layer 2 |
| injection-decision matrix (pinned→inject-last; unpinned→ABSENT; hoisted→not injectable; subject `-r`/`--require` forms; non-mocha bins) + tampered-double e2e | `packages/runner/executor/test/executor.test.ts` |
| case/ANSI symmetry, must-match AND false-positive directions | `packages/runner/executor/test/infra-matching-hardening.test.ts` |
| gate total on malformed disk data; rule-14 routing for ALL strong + FLAKY producers (2–8, 12; each un-attested case carries an attested-twin test proving the shape genuinely reaches its producer, so the routing assertion cannot rot into testing a dead path); identity-set refusal | `packages/core/classification/test/classify.test.ts` |
| schema mirror: own-copy strong-label constant with test-pinned classifier equivalence, rule-13 containment restatement, refusal + honest-shape acceptance (no over-block), deletion matrix | `packages/evidence/schema/test/schema.test.ts` |
| would-be-PRE_EXISTING containment (swallowed regression, disjoint sets, honest PEF preserved, CR untouched, passing-side substitution boundary codified) | `packages/core/classification/test/classify.test.ts` (round-5 describe) |
| 5-file tuple binding; reseal-everything-but-observation refused; byte-tamper refusals; argv re-derivation parity | `apps/cli/test/prove.test.ts`, `verify-tree` suite |
| golden never re-anchored: 36 assertions on the committed proof host, `proof.json` byte-identical | `fixtures/axios-0.27-to-1.0/specs/` (untouched by this hardening, by rule) |
