/**
 * Canary classification — the decision table from docs/PLAN.md section 6.
 *
 * This function is TOTAL, PURE, and DETERMINISTIC. It consumes only run
 * facts produced by the executor. Nothing probabilistic, nothing LLM-driven.
 * The security of Canary's whole claim rests here — and since the post-GLM
 * observation hardening it rests on TWO channels, precisely because the old
 * one was alone insufficient: the text channel (exit codes, structural output
 * properties) says what the subject PRINTED, and the execution-observation
 * channel says what Canary WATCHED happen inside a pinned-bytes runner it
 * injected. Strong and execution-claim labels (STRONG_EXECUTION_LABELS)
 * require every round of both arms to carry a VALID observation whose counts
 * and identities agree with the text; without that, rule 14 sends the
 * verdict to INCONCLUSIVE. Printed text is a claim; a claim is not proof.
 */

export type Classification =
  | 'PASS'
  | 'CONFIRMED_REGRESSION'
  | 'PRE_EXISTING_FAILURE'
  | 'FLAKY'
  | 'INFRASTRUCTURE_FAILURE'
  | 'INCONCLUSIVE';

export type ArmKind = 'baseline' | 'candidate';

/** One execution round, as observed by the executor. */
export interface RoundFact {
  arm: ArmKind;
  /** Index within the arm, 1-based. */
  round: number;
  /** Process exit code. -1 reserved for killed (timeout / unmanaged death). */
  exitCode: number;
  /** True iff the log matched the test-runner summary signature —
   *  i.e. the runner actually reported structured results. */
  hasRunnerSummary: boolean;
  /** True iff deterministic infra patterns matched (npm ERESOLVE,
   *  ERR_MODULE_NOT_FOUND, missing binary, network error...). */
  infraSignal: boolean;
  /** Failing-test count parsed from the runner's summary line, when the
   *  summary was machine-readable. Bridges exit codes and prose: a nonzero
   *  exit whose log reports ZERO failing tests died for a non-test reason;
   *  a zero exit whose log reports failing tests is a masked failure
   *  (red-team findings F1/F5). */
  reportedFailing?: number | undefined;
  /** Passing-test count from the runner summary (audit B2). Together with
   *  failing it defines whether ANY assertion actually executed: pending
   *  tests do NOT execute assertions, so an executed-total of
   *  passing+failing = 0 can never support PASS or CONFIRMED_REGRESSION
   *  (round-3 blocker 2). */
  reportedPassing?: number | undefined;
  /** Pending/skipped count from the runner summary. EXCLUDED from the
   *  executed-total (round-3 blocker 2: "0 passing / 0 failing / N pending"
   *  proves the runner started, not that any test asserted anything) but
   *  INCLUDED in the observed-total used for the post-sol RB-2 coverage
   *  comparison — pending that grows across arms or repetitions is a
   *  coverage change and may never anchor a strong verdict. */
  reportedPending?: number | undefined;
  /** Sorted, deduped failing-test identities parsed from the log, when
   *  parseable. Audit F2: exit-code unanimity alone can label a run CONFIRMED
   *  while the rounds failed DIFFERENT tests (or different numbers of tests) —
   *  a non-reproducible failure is FLAKY, never a confirmed regression.
   *  Round-3 blocker 1: a failing round whose identities do not fully account
   *  for reportedFailing is INCOMPLETE — never trustful (see identityCoverage). */
  failingTestNames?: readonly string[] | undefined;
  /** True iff the run's output carries a fatal-runtime-crash signature (V8
   *  heap OOM, segfault, abort) — a valid summary followed by a post-summary
   *  crash is NOT a clean run (round-3 secondary: generic crash after a valid
   *  failure summary was unrepresented). */
  crashSignal?: boolean | undefined;
  /** True iff the audit-F5 post-exit descendant containment sweep could not
   *  confirm zero survivors. Execution isolation is then unknown, so the run
   *  is not a valid test execution (round-3 secondary: failed sweep was
   *  recorded internally but omitted from evidence/classification). */
  sweepFailed?: boolean | undefined;
  /**
   * POST-GLM OBSERVATION HARDENING — Canary's OWN record of execution for
   * this round (see packages/runner/executor/src/observation.ts for what the
   * channel is and what it honestly proves). REQUIRED on every round in the
   * evidence contract; typed optional here so classification stays total over
   * hand-built test facts — a MISSING observation is treated exactly like
   * ABSENT, never like VALID. STRONG_EXECUTION_LABELS (PASS, CONFIRMED_
   * REGRESSION, PRE_EXISTING_FAILURE, FLAKY) are only reachable when EVERY
   * round of BOTH arms carries status VALID whose observedCounts/
   * observedFailingIdentities agree with the text-parsed fields (gate below;
   * rule 14 is the downgrade). The name deliberately avoids the loaded words
   * "attestation" (tree/env host checks) and "observation" (tree status).
   */
  executionObservation?: ExecutionObservation | undefined;
}

export type ObservationStatus = 'VALID' | 'ABSENT' | 'INVALID';

/** Why an ABSENT observation is absent — all three mean "no injection". */
export type AbsentKind = 'not-mocha-bin' | 'no-injection' | 'runner-identity-unpinned';

export interface ObservedCounts {
  passing: number;
  failing: number;
  pending: number;
}

/**
 * Per-round execution observation (contract shape — executor captures,
 * bundle persists, prove re-derives; ONE shared field layout).
 *
 * Cross-field iff-rules (enforced by the evidence semantic layer):
 *  - VALID  ⇔ observedCounts, observedMochaVersion, expectedRunnerTreeSha256 present
 *  - INVALID ⇔ invalidReason present
 *  - ABSENT ⇔ absentKind present; strayFd3Bytes only here; strayFd3Sha256 only with stray
 *  - expectedMochaVersion present iff injection was ATTEMPTED (pinned match)
 *  - observedRunnerTreeSha256 present iff a mocha package was LOCATED
 *  - 'injected' is never a field: status VALID is the injection fact (ABSENT
 *    and INVALID distinguish "never attempted" from "attempted, failed").
 */
export interface ExecutionObservation {
  status: ObservationStatus;
  /** Always present: [] when no VALID stream produced failures. Sorted,
   *  deduped canonical ' > ' titlePath identities Canary WATCHED fail. */
  observedFailingIdentities: readonly string[];
  /** sha256 of the retained fd-3 bytes (empty-file hash when nothing arrived). */
  framesSha256: string;
  /** Number of NDJSON frames in the retained bytes. */
  frameCount: number;
  observedCounts?: ObservedCounts;
  /** Pinned-release version the observer was injected against (Canary truth). */
  expectedMochaVersion?: string;
  /** hello.mochaVersion as emitted by the in-process observer. */
  observedMochaVersion?: string;
  /** Pin-table hash the injection decision used (Canary-repo value). */
  expectedRunnerTreeSha256?: string;
  /** Hash Canary computed over the resolved package directory at expansion. */
  observedRunnerTreeSha256?: string;
  /**
   * PROVIDER-NEUTRAL CHANNEL IDENTITY (v1.1 Phase 2).
   *
   * The mocha fields above were the only channel identity that existed, which
   * made "strong label" structurally synonymous with "pinned mocha". These
   * fields carry the same facts for any adapter — the runner Canary required,
   * the version it required, and a digest of the runner's own bytes as Canary
   * hashed them on disk — so a non-package runner (a stdlib test framework, a
   * toolchain binary) can be bound just as tightly without inventing a second
   * observation vocabulary. They are ABSENT on mocha rounds, which keeps every
   * existing iff-rule and every existing bundle byte-identical.
   */
  runner?: string;
  /** The version Canary required (from its own pin/sealed identity), and what
   *  the observer reported. Present iff a non-mocha channel was attempted. */
  expectedRunnerVersion?: string;
  observedRunnerVersion?: string;
  /** sha256 of the runner's own bytes: Canary-computed (observed) and required
   *  (expected). Present iff a non-mocha channel carried an identity pin. */
  expectedRunnerIdentitySha256?: string;
  observedRunnerIdentitySha256?: string;
  invalidReason?: string;
  absentKind?: AbsentKind;
  /** ABSENT-only tripwire: bytes arrived on an un-injected fd-3 pipe — a
   *  protocol-emulation attempt; recorded, never credited as observation. */
  strayFd3Bytes?: boolean;
  strayFd3Sha256?: string;
}

export interface ClassificationResult {
  classification: Classification;
  /** Number of the decision-table rule that fired (0..14; 9/10 are the
   *  confinement guard, 11 the identity-coverage gate, 12/13 the post-sol
   *  RB-2 coverage-consistency pair, 14 the post-GLM execution-observation
   *  gate — strong/execution-claim labels downgraded for missing or
   *  contradicted observation). */
  rule: number;
  reason: string;
  details: {
    baselinePass: boolean;
    baselineUnanimous: boolean;
    candidateUnanimous: boolean;
    candidateRuns: number;
    candidateFailures: number;
    degenerate: boolean;
  };
}

/**
 * A failing round is only a TEST failure if its log actually reports failing
 * tests. Guards encoded here (red-team F1/F5 + audit F1 + prototype lesson
 * F7-degenerate):
 *  - exit != 0 with no structured summary or an infra pattern -> infra
 *  - exit != 0 whose summary reports zero failing tests -> the process died
 *    for a non-test reason (port collision, teardown crash...) -> infra.
 *    CRITICAL (audit F1): mocha/ava OMIT the failing line entirely when zero
 *    tests failed, so a passing-style summary with NO parseable failing
 *    count means "reported zero failures" — never "unknown failures that
 *    might be a regression". Reading undefined as unknown here is what made
 *    "prints a passing summary, then exits nonzero" a false
 *    CONFIRMED_REGRESSION; the conservative reading (infra) is contractual.
 *  - exit = 0 while the summary reports >=1 failing -> masked failure via a
 *    bad test command -> infra (never silently PASS)
 */
/**
 * Execution-validity rules (audit B2, incorporating red-team F1/F5).
 * Returns the machine-readable reason a round is NOT a valid test execution,
 * or null when it is. A successful exit is NOT sufficient: a round counts as
 * infrastructure if ANY of
 *  - it was killed / died by signal (exit -1);
 *  - its output carries a fatal-runtime-crash signature at ANY exit code
 *    (round-3: a valid failure summary followed by an OOM/segfault abort is
 *    not a run whose result can be trusted);
 *  - the post-exit containment sweep could not confirm zero survivors
 *    (isolation unknown -> the environment of later rounds is unknown);
 *  - its output carries a recognized infrastructure signature at ANY exit
 *    code (B2: harnesses can swallow errors and exit 0);
 *  - it shows no test-runner summary at all (B2: no recognizable execution,
 *    e.g. a script that exits 0 without ever running tests);
 *  - its summary is present but carries NO machine-readable counts (a
 *    "recognized" prose marker with unreadable numbers proves nothing —
 *    round-3 blocker 2);
 *  - its summary reports ZERO EXECUTED tests, where executed counts ONLY
 *    passing+failing — pending/skipped tests never executed an assertion,
 *    so "0 passing / 0 failing / N pending" can never be a PASS
 *    (round-3 blocker 2);
 *  - it exits nonzero while the summary claims zero failures (F1: died for a
 *    non-test reason);
 *  - it exits 0 while the summary reports failures (F5: masked failure).
 * None of these may ever yield PASS or CONFIRMED_REGRESSION.
 */
export function infraCause(r: RoundFact): string | null {
  if (r.exitCode === -1) return 'killed or signal death';
  if (r.crashSignal) return 'fatal runtime crash signature in output (heap OOM / abort / segfault)';
  if (r.sweepFailed) return 'post-run containment sweep could not confirm zero surviving descendants';
  if (r.infraSignal) return 'recognized infrastructure-failure signature in output';
  if (!r.hasRunnerSummary) return 'no test-runner summary — execution not recognizable as a test run';
  const observed =
    r.reportedPassing !== undefined || r.reportedFailing !== undefined || r.reportedPending !== undefined;
  if (!observed) return 'runner summary present but carries no machine-readable pass/fail counts — cannot prove any test executed';
  // Round-3 blocker 2: PENDING IS NOT EXECUTION. A skipped test asserts
  // nothing; an all-pending run proves the runner started and nothing more.
  const executed = (r.reportedPassing ?? 0) + (r.reportedFailing ?? 0);
  if (executed === 0) return 'zero executed tests (passing+failing=0; pending/skipped tests do not execute assertions)';
  if (r.exitCode === 0 && (r.reportedFailing ?? 0) > 0) return 'exit 0 while summary reports failing tests (masked failure)';
  if (r.exitCode !== 0 && (r.reportedFailing ?? 0) === 0) return 'nonzero exit while summary reports zero failing tests (died outside tests)';
  return null;
}

function isInfraRound(r: RoundFact): boolean {
  return infraCause(r) !== null;
}

/**
 * Post-sol RB-2 — COVERAGE CONSISTENCY. Coverage totals derived from one
 * round's summary:
 *   executed = passing + failing  (assertions that actually ran)
 *   observed = executed + pending (tests registered in the summary)
 * Undefined counts read as zero: rule 1 already guarantees every surviving
 * round carries at least one machine-readable count, and mocha/ava OMIT the
 * failing/pending lines when those are zero. A round whose counts are wholly
 * absent is infra, never a coverage datum.
 *
 * The invariant: WEAKER OR MISSING TEST EXECUTION MUST NOT PRODUCE A STRONGER
 * VERDICT. A real regression moves tests from passing to failing at a stable
 * executed total; tests vanishing from execution (collapse, silent skip,
 * suite-load truncation) are not equivalent to PASS, and not equivalent
 * enough to CONFIRM anything. Both rules reason from the experiment's own
 * totals — there is deliberately NO hard-coded minimum test count: N
 * repetitions and both arms must merely AGREE.
 */
export interface CoverageTotals { executed: number; observed: number }

export function coverageOf(r: RoundFact): CoverageTotals {
  const executed = (r.reportedPassing ?? 0) + (r.reportedFailing ?? 0);
  return { executed, observed: executed + (r.reportedPending ?? 0) };
}

/** The arm's shared coverage totals, or undefined when its repetitions
 *  disagree (coverage instability = FLAKY at the observation level). */
function coverageStable(rs: readonly RoundFact[]): CoverageTotals | undefined {
  if (rs.length === 0) return undefined;
  const first = coverageOf(rs[0]!);
  return rs.every((r) => {
    const c = coverageOf(r);
    return c.executed === first.executed && c.observed === first.observed;
  }) ? first : undefined;
}

const covText = (c: CoverageTotals): string => `${c.executed}/${c.observed}`;

const pass = (r: RoundFact): boolean => r.exitCode === 0;
const unanimous = (rs: readonly RoundFact[]): boolean =>
  rs.length > 0 && rs.every((r) => pass(r) === pass(rs[0]!));

/**
 * Does the round's parsed identity set FULLY ACCOUNT for its reported
 * failures? (Round-3 blocker 1.) Two different root-level failures used to
 * parse to equal EMPTY identity sets — the classifier then saw "identical
 * failures across rounds" and confirmed a regression from zero evidence.
 * - COMPLETE     — uniq(parsed names) === reportedFailing (or both zero).
 * - INCOMPLETE   — a count is reported but the parsed identities do not
 *                  match it (fewer names than failures — the parser could
 *                  not attribute every failure; MORE names than the count is
 *                  also INCOMPLETE: the count and identities contradict).
 * - NOT_OBSERVED — no failing count at all.
 */
export type IdentityCoverage = 'COMPLETE' | 'INCOMPLETE' | 'NOT_OBSERVED';

export function identityCoverage(r: RoundFact): IdentityCoverage {
  if (r.reportedFailing === undefined) return 'NOT_OBSERVED';
  if (!Array.isArray(r.failingTestNames)) return 'NOT_OBSERVED';
  const uniq = new Set(r.failingTestNames).size;
  return uniq === r.reportedFailing ? 'COMPLETE' : 'INCOMPLETE';
}

/**
 * Identity of a round's failure: how many tests the summary said failed, and
 * WHICH ones, plus the coverage state so an incomplete parse (count>names)
 * can never profile-match a complete one. '?' distinguishes "not observed"
 * from "observed as zero/empty", so a runner whose summary parses on some
 * rounds but not others counts as non-uniform (defensible: the failure
 * record itself varies run-to-run).
 */
function failureProfile(r: RoundFact): string {
  const count = r.reportedFailing === undefined ? '?' : String(r.reportedFailing);
  const names = Array.isArray(r.failingTestNames)
    ? [...r.failingTestNames].sort().join('\n')
    : '?';
  return `${count}|${identityCoverage(r)}|${names}`;
}

/**
 * True iff every FAILING round within the arm failed identically (same count,
 * same test identities). Passing rounds are irrelevant — their agreement is
 * already covered by exit-code unanimity. Audit F2.
 */
function failingProfileStable(rs: readonly RoundFact[]): boolean {
  const failing = rs.filter((r) => !pass(r));
  if (failing.length <= 1) return true;
  const first = failureProfile(failing[0]!);
  return failing.every((r) => failureProfile(r) === first);
}

/**
 * Labels that CLAIM execution facts (as opposed to TRUSTFUL_LABELS, the
 * bundle-retention tier in the evidence contract — two tiers, two constants,
 * never conflated). FLAKY is included: a flaky verdict still asserts "tests
 * ran, with differing results". Weak honest labels (INCONCLUSIVE,
 * INFRASTRUCTURE_FAILURE) never claim execution, so they stay ungated.
 */
export const STRONG_EXECUTION_LABELS: readonly Classification[] = [
  'PASS', 'CONFIRMED_REGRESSION', 'PRE_EXISTING_FAILURE', 'FLAKY',
];

/**
 * The execution-observation GATE — the single shared predicate (exported so
 * the evidence mirror states the same rule, and prove replays it).
 * Returns null when satisfied, else a deterministic reason string (first
 * offending round in bundle order + which condition failed).
 *
 *  (1) every round of both arms has status VALID (a missing observation is
 *      ABSENT: subject prose can never stand in for it);
 *  (2) per round observedCounts == text counts under `?? 0` semantics —
 *      REQUIRED by audit-F1's mocha-omits-zero-lines behavior: a golden
 *      "128 passing" round has text failing=undefined vs observed failing=0
 *      and the two channels must AGREE, not merely "not contradict";
 *  (3) Set(observedFailingIdentities) == Set(failingTestNames ?? []);
 *  (4) no exit-code contradiction: failing==0 with exit!=0 means the process
 *      died outside the tests Canary watched (and with VALID, printed-zero
 *      text is pinned to INFRA by ungated rule 1); failing>0 with exit==0 is
 *      a masked failure — kept here as defense-in-depth even though agreement
 *      routes it via rule 1 today. NOTE (post-glm F6b): exit==-1 (killed) is
 *      NOT caught here when the round watched real failures — neither clause
 *      matches (-1!=0 with failing>0, exit!=0 with failing>0) — and capture
 *      DELIBERATELY honors a complete stream paired with -1 (the exit code
 *      of a kill claims nothing about tests). The unconditional veto is
 *      infraCause's 'killed or signal death', which attestedView never
 *      touches and rule 1 applies before any gated rule. Pinned by the F6b
 *      test in classify.test.ts + the layer-1 F6b test in attested-channel.
 */
export function observationGateIssue(rounds: readonly RoundFact[]): string | null {
  for (const r of rounds) {
    const o = r.executionObservation;
    if (!o || o.status !== 'VALID') {
      return `round ${r.arm}#${r.round} has executionObservation=${o ? o.status : 'missing'} — strong labels require a VALID Canary observation on every round`;
    }
    const oc = o.observedCounts;
    if (!oc) return `round ${r.arm}#${r.round} is VALID without observedCounts`;
    if (
      oc.passing !== (r.reportedPassing ?? 0)
      || oc.failing !== (r.reportedFailing ?? 0)
      || oc.pending !== (r.reportedPending ?? 0)
    ) {
      return `round ${r.arm}#${r.round}: observed ${oc.passing}/${oc.failing}/${oc.pending} disagrees with text ${(r.reportedPassing ?? 0)}/${(r.reportedFailing ?? 0)}/${(r.reportedPending ?? 0)}`;
    }
    // Malformed-but-present observations (bundles are cast from disk, not
    // constructed by the type system) are a GATE REFUSAL, never a crash:
    // fail-closed means returning rule 14, not throwing at a caller that
    // cannot classify at all.
    if (!Array.isArray(o.observedFailingIdentities)) {
      return `round ${r.arm}#${r.round} is VALID but observedFailingIdentities is not an array — malformed observation cannot gate`;
    }
    const a = [...new Set(o.observedFailingIdentities)].sort().join('\n');
    const b = [...new Set(r.failingTestNames ?? [])].sort().join('\n');
    if (a !== b) return `round ${r.arm}#${r.round}: observed failing identities disagree with text-parsed identities`;
    if (oc.failing === 0 && r.exitCode !== 0) return `round ${r.arm}#${r.round}: zero observed failures but exit=${r.exitCode} (died outside watched tests)`;
    if (oc.failing > 0 && r.exitCode === 0) return `round ${r.arm}#${r.round}: ${oc.failing} observed failures but exit=0 (masked failure)`;
  }
  return null;
}

/** Boolean form of the gate (panel B names it as the shared predicate; the
 *  reason string is observationGateIssue, which classify() embeds in rule 14). */
export function observationSatisfied(rounds: readonly RoundFact[]): boolean {
  return observationGateIssue(rounds) === null;
}

/**
 * When the gate holds, the two channels AGREE, so the identity/coverage math
 * switches to the ATTESTED values — one canonical source per round (panel
 * decision B: computed BEFORE any table rule from raw fields, so all three
 * re-derivation sites — capture, validateBundle, verifyClassificationDerivation
 * — see the same normalized facts). The switch only ever normalizes
 * duplicate-text-name edges (profiles join raw arrays; attested identities
 * are deduped), which is exactly why it is non-circular.
 */
function attestedView(r: RoundFact): RoundFact {
  const o = r.executionObservation!;
  return {
    ...r,
    reportedPassing: o.observedCounts!.passing,
    reportedFailing: o.observedCounts!.failing,
    reportedPending: o.observedCounts!.pending,
    failingTestNames: [...(o.observedFailingIdentities ?? [])].sort(),
    // Post-GLM F4 (fail-closed precedence): once every round is ATTESTED —
    // a VALID pinned-runner observation agreeing with the text — a veto
    // derived from UNTRUSTED SUBJECT TEXT may not bury the attested
    // evidence: infra keywords ("ECONNREFUSED" asserted on by a test) and
    // crash signatures alike are byte-pattern matches on subject output
    // (prove re-derives both from the artifact bytes; accuracy there proves
    // the bytes said it, not that the process crashed). A test printing a
    // real V8/shell crash banner while genuinely failing would otherwise be
    // buried as INFRA rule 1. The veto survives for the flags that are not
    // text patterns at all: exit -1 (executor-observed signal death) and the
    // containment sweep stay in infraCause unconditionally. Text-derived
    // facts NEVER upgrade a verdict — this only removes prose's power to
    // suppress one.
    infraSignal: false,
    crashSignal: false,
  };
}

/** Post-GLM public entry: gate + channel normalization + rule 14 routing. */
export function classify(rounds: readonly RoundFact[]): ClassificationResult {
  const gate = observationGateIssue(rounds);
  const view = gate === null ? rounds.map(attestedView) : rounds;
  const inner = classifyTable(view);
  if (gate === null || !STRONG_EXECUTION_LABELS.includes(inner.classification)) return inner;
  // Routing (panel B): rules 3/4/5 (strong) AND all five FLAKY producers
  // (2, 6-flaky-arm, 7, 8, 12) downgrade to INCONCLUSIVE rule 14. Rules 0/1,
  // 6's INCONCLUSIVE arm, 11 and 13 are already weak and pass through.
  return {
    classification: 'INCONCLUSIVE',
    rule: 14,
    reason: `execution unattested / channel contradicted: ${gate} — no strong or execution-claim label without a Canary-observed, pinned-runner execution on every round (previously rule ${inner.rule} ${inner.classification})`,
    details: {
      baselinePass: view.filter((r) => r.arm === 'baseline').every(pass),
      baselineUnanimous: unanimous(view.filter((r) => r.arm === 'baseline')),
      candidateUnanimous: unanimous(view.filter((r) => r.arm === 'candidate')),
      candidateRuns: view.filter((r) => r.arm === 'candidate').length,
      candidateFailures: view.filter((r) => r.arm === 'candidate' && !pass(r)).length,
      degenerate: false,
    },
  };
}

/** The shipped decision table (rules 0..13), untouched semantics; operates on
 *  the normalized facts handed to it by classify(). */
function classifyTable(rounds: readonly RoundFact[]): ClassificationResult {
  const baseline = rounds.filter((r) => r.arm === 'baseline');
  const candidate = rounds.filter((r) => r.arm === 'candidate');

  const mk = (
    classification: Classification,
    rule: number,
    reason: string,
    opts: { baselinePass: boolean; baselineUnanimous: boolean; candidateUnanimous: boolean; degenerate?: boolean },
  ): ClassificationResult => ({
    classification,
    rule,
    reason,
    details: {
      baselinePass: opts.baselinePass,
      baselineUnanimous: opts.baselineUnanimous,
      candidateUnanimous: unanimous(candidate),
      candidateRuns: candidate.length,
      candidateFailures: candidate.filter((r) => !pass(r)).length,
      degenerate: opts.degenerate ?? false,
    },
  });

  const bPass = baseline.every(pass);
  const bUnanim = unanimous(baseline);

  // Rule 0: input sanity — an experiment without both arms is INCONCLUSIVE.
  if (baseline.length === 0 || candidate.length === 0) {
    return mk('INCONCLUSIVE', 0, 'missing baseline or candidate rounds', {
      baselinePass: false, baselineUnanimous: false, candidateUnanimous: false,
    });
  }

  // Rule 1: any required round is not a valid test execution -> INFRA.
  const infraRounds = rounds.filter(isInfraRound);
  if (infraRounds.length > 0) {
    const first = infraRounds[0]!;
    return mk(
      'INFRASTRUCTURE_FAILURE', 1,
      `round ${first.arm}#${first.round} is not a valid test run: ${infraCause(first)} ` +
      `(exit=${first.exitCode}, summary=${first.hasRunnerSummary}, infra=${first.infraSignal}, ` +
      `counts p/f/p=${first.reportedPassing ?? '-'}:${first.reportedFailing ?? '-'}:${first.reportedPending ?? '-'})`,
      { baselinePass: bPass, baselineUnanimous: bUnanim, candidateUnanimous: false },
    );
  }

  // Rule 2: unstable baseline invalidates the whole experiment.
  if (!bUnanim) {
    return mk('FLAKY', 2, 'baseline rounds disagree — environment cannot support a proof', {
      baselinePass: bPass, baselineUnanimous: false, candidateUnanimous: false,
    });
  }

  // Rule 8 (audit F2): exit-code unanimity is necessary but NOT sufficient.
  // Within an arm, all FAILING rounds must have failed identically — same
  // failing-test count, same failing-test identities — otherwise the failure
  // is not reproducible and must never be labeled CONFIRMED_REGRESSION /
  // PRE_EXISTING_FAILURE.
  if (!failingProfileStable(baseline) || !failingProfileStable(candidate)) {
    const unstableArm = failingProfileStable(baseline) ? 'candidate' : 'baseline';
    return mk('FLAKY', 8,
      `${unstableArm} failing rounds differ in count/identity across repeats — failure not reproducible`,
      { baselinePass: bPass, baselineUnanimous: bUnanim, candidateUnanimous: false });
  }

  // Rule 11 (round-3 blocker 1): every FAILING round must fully ACCOUNT for
  // its reported failures with parsed identities. A round that says "N
  // failing" but yields fewer (or zero) distinct parsed identities is a
  // partial parse — the classifier cannot know WHICH tests failed, so a
  // CONFIRMED_REGRESSION / PRE_EXISTING_FAILURE built on it would be
  // unanchored (two different root failures collapse to equal EMPTY identity
  // sets and look "stable"). INCONCLUSIVE is the conservative floor. Passing
  // rounds are irrelevant: they report no failures.
  const underAccounted = rounds.filter((r) => !pass(r) && identityCoverage(r) !== 'COMPLETE');
  if (underAccounted.length > 0) {
    const first = underAccounted[0]!;
    const parsed = Array.isArray(first.failingTestNames) ? new Set(first.failingTestNames).size : '?';
    return mk('INCONCLUSIVE', 11,
      `failing round ${first.arm}#${first.round} reports ${first.reportedFailing ?? '?'} failures but only ${parsed} distinct identities parsed — failure set not fully accounted (identityCoverage=${identityCoverage(first)})`,
      { baselinePass: bPass, baselineUnanimous: bUnanim, candidateUnanimous: false });
  }

  // Rule 12 (post-sol RB-2): every repetition of an arm must show the SAME
  // executed/observed coverage totals. Baseline "128 passing" repeating as
  // "1 passing" is not a stable environment — even with unanimous exit
  // codes — and must never support PASS (Sol case 2). Candidate-side
  // instability is equally FLAKY.
  const bCov = coverageStable(baseline);
  const cCov = coverageStable(candidate);
  if (!bCov || !cCov) {
    const unstableArm = !bCov ? 'baseline' : 'candidate';
    const rs = (!bCov ? baseline : candidate).map((r) => covText(coverageOf(r))).join(', ');
    return mk('FLAKY', 12,
      `${unstableArm} repetitions differ in observed test coverage (executed/observed: ${rs}) — coverage instability across repeats invalidates the comparison`,
      { baselinePass: bPass, baselineUnanimous: bUnanim, candidateUnanimous: unanimous(candidate) });
  }

  const cAllPass = candidate.every(pass);
  const cAllFail = candidate.every((r) => !pass(r));

  // Rule 13 (post-sol RB-2; extended post-GLM round-5 F1): cross-arm
  // COMPARABILITY gates STRONG verdicts only. PASS / CONFIRMED_REGRESSION /
  // PRE_EXISTING_FAILURE claim the arms measured the same experiment; a
  // summary whose executed or observed totals differ across arms means tests
  // silently disappeared from (or appeared in) execution — that is exactly
  // the weaker-or-missing execution that may never produce the stronger
  // verdict (Sol cases 1, 3, 4). A legitimate regression (passing -> failing
  // at stable totals, the Axios shape 128 -> 125+3) passes untouched.
  //
  // The same-experiment invariant implemented here is CARDINALITY PLUS
  // FAILING-SET CONTAINMENT, not full identity correspondence. In the
  // attested view failingTestNames ARE Canary-observed identities, so
  // PRE_EXISTING_FAILURE ("every candidate failure was already failing under
  // baseline") is contradicted by containment violations: a watched
  // pass->fail transition (regression) must never be swallowed into
  // "pre-existing", and disjoint failing sets ({A} vs {B}) describe no
  // comparable transition at all. Renamed/added PASSING tests at equal
  // totals (suite-composition substitution) remain inside the stated F3/
  // §8.1 ceiling — binding identity strings across two package versions
  // needs a semantic root Canary does not have, and enforcing it would deny
  // strong verdicts to legitimate test renames.
  const wouldBeStrong =
    (bPass && (cAllPass || cAllFail)) || (!bPass && cAllFail);
  if (wouldBeStrong && (bCov.executed !== cCov.executed || bCov.observed !== cCov.observed)) {
    return mk('INCONCLUSIVE', 13,
      `test coverage differs between arms (baseline executed/observed ${covText(bCov)}, candidate ${covText(cCov)}) — weaker or missing test execution must not produce a stronger verdict; a legitimate regression keeps the executed total stable and moves tests from passing to failing`,
      { baselinePass: bPass, baselineUnanimous: bUnanim, candidateUnanimous: false });
  }
  if (wouldBeStrong && !bPass) {
    const baseFailing = new Set(baseline.flatMap((r) => r.failingTestNames ?? []));
    const extra = [...new Set(candidate.flatMap((r) => r.failingTestNames ?? []).filter((x) => !baseFailing.has(x)))].sort();
    if (extra.length > 0) {
      return mk('INCONCLUSIVE', 13,
        `candidate fails ${extra.length} identity/identities not failing in baseline (${extra.join(', ')}) — PRE_EXISTING_FAILURE requires failing-set containment; a watched pass->fail transition may never be swallowed and disjoint failing sets describe no comparable transition (post-GLM F1)`,
        { baselinePass: bPass, baselineUnanimous: bUnanim, candidateUnanimous: false });
    }
  }

  // Rule 3: clean + clean -> PASS.
  if (bPass && cAllPass) {
    return mk('PASS', 3, 'candidate matches baseline behavior', {
      baselinePass: true, baselineUnanimous: true, candidateUnanimous: true,
    });
  }

  // Rule 4: broken-before, broken-after -> PRE_EXISTING_FAILURE.
  if (!bPass && cAllFail) {
    return mk('PRE_EXISTING_FAILURE', 4, 'downstream already failed under the baseline version', {
      baselinePass: false, baselineUnanimous: true, candidateUnanimous: false,
    });
  }
  if (!bPass && !cAllFail) {
    // Baseline fails but candidate does not uniformly fail: either the
    // candidate fixed it, or something nondeterministic is going on.
    return mk(
      cAllPass ? 'INCONCLUSIVE' : 'FLAKY', 6,
      cAllPass
        ? 'baseline fails while candidate passes — not a regression pattern; investigate pinning'
        : 'non-unanimous candidate under failing baseline',
      { baselinePass: false, baselineUnanimous: true, candidateUnanimous: cAllPass },
    );
  }

  // Rule 5 + 6: baseline clean; candidate decisive.
  if (bPass && cAllFail) {
    return mk('CONFIRMED_REGRESSION', 5,
      `all ${candidate.length} candidate rounds failed while baseline passed — regression confirmed`,
      { baselinePass: true, baselineUnanimous: true, candidateUnanimous: false });
  }

  // Rule 7: baseline clean; candidate mixed -> FLAKY.
  return mk('FLAKY', 7,
    `${candidate.filter((r) => !pass(r)).length}/${candidate.length} candidate rounds failed — nondeterministic`,
    { baselinePass: true, baselineUnanimous: true, candidateUnanimous: false });
}

/** Tree-confinement facts as observed by the pipeline (structural — keeps
 *  the classification package dependency-free). */
export interface Confinement {
  /** True iff every tree-drift key lives inside the studied dependency's subtree. */
  confined: boolean;
  /** Drift keys NOT explained by the dependency subtree (escaped form). */
  other: readonly string[];
  /** The studied dependency (raw spec name). */
  dependency: string;
  /**
   * Audit B6 — completeness of each arm's dependency-tree OBSERVATION.
   * Mirrors comparator TreeStatus (declared locally so this package stays a
   * leaf). A trustful verdict requires both arms 'VALID'.
   */
  baselineStatus: 'VALID' | 'INCOMPLETE' | 'INVALID';
  candidateStatus: 'VALID' | 'INCOMPLETE' | 'INVALID';
}

/**
 * Rules 9 + 10 — CONFINEMENT AND OBSERVATION QUALITY ARE ENFORCED, NOT
 * DECORATIVE (audits F9/B6; the guard that used to live inline in the pipeline
 * was untested, so deleting it changed nothing in the suite).
 *
 *  - Rule 10 (B6): if either arm's tree observation is not VALID (empty /
 *    partial / missing the studied dependency), confinement cannot be proven
 *    at all — a vacuous `diffTrees({},{})` would otherwise report confined and
 *    certify a false verdict.
 *  - Rule 9 (F9): drift outside the studied dependency's subtree means the arms
 *    are not comparable.
 *
 * Both downgrade any trustful classification (PASS / CONFIRMED_REGRESSION /
 * PRE_EXISTING_FAILURE / FLAKY / INCONCLUSIVE-with-a-different-rule) to
 * INCONCLUSIVE; INFRASTRUCTURE_FAILURE keeps its own higher-fidelity reason.
 * The evidence validator independently rejects trustful labels under a
 * non-VALID observation or unconfined drift, so a bundle that skipped this
 * guard cannot validate either.
 */
export function applyConfinementGuard(
  cls: ClassificationResult, drift: Confinement,
): ClassificationResult {
  if (cls.classification === 'INFRASTRUCTURE_FAILURE') return cls;
  if (drift.baselineStatus !== 'VALID' || drift.candidateStatus !== 'VALID') {
    return {
      ...cls,
      classification: 'INCONCLUSIVE',
      rule: 10,
      reason: `dependency-tree observation is not trustworthy (baseline=${drift.baselineStatus}, candidate=${drift.candidateStatus}) — confinement cannot be proven`,
    };
  }
  if (!drift.confined) {
    return {
      ...cls,
      classification: 'INCONCLUSIVE',
      rule: 9,
      reason: `tree drift outside ${drift.dependency} subtree (${drift.other.slice(0, 6).join(', ')}) — arms not comparable`,
    };
  }
  return cls;
}
