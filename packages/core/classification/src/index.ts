/**
 * Canary classification — the decision table from docs/PLAN.md section 6.
 *
 * This function is TOTAL, PURE, and DETERMINISTIC. It consumes only run
 * facts produced by the executor. Nothing probabilistic, nothing LLM-driven.
 * The security of Canary's whole claim rests here: the label is a function
 * of exit codes and structural output properties, and of nothing else.
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
   *  failing+pending it defines whether ANY test actually executed: an
   *  executed-total of zero can never support a PASS. */
  reportedPassing?: number | undefined;
  /** Pending/skipped count from the runner summary (audit B2): pending tests
   *  ARE executed selections (they prove the runner ran) and count toward the
   *  executed total. */
  reportedPending?: number | undefined;
  /** Sorted failing-test identities parsed from the log, when parseable.
   *  Audit F2: exit-code unanimity alone can label a run CONFIRMED while the
   *  rounds failed DIFFERENT tests (or different numbers of tests) — a
   *  non-reproducible failure is FLAKY, never a confirmed regression. */
  failingTestNames?: readonly string[] | undefined;
}

export interface ClassificationResult {
  classification: Classification;
  /** Number of the decision-table rule that fired (1..8). */
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
 *  - its output carries a recognized infrastructure signature at ANY exit
 *    code (B2: harnesses can swallow errors and exit 0);
 *  - it shows no test-runner summary at all (B2: no recognizable execution,
 *    e.g. a script that exits 0 without ever running tests);
 *  - its summary reports ZERO executed tests (B2: "0 passing" is not a PASS);
 *  - it exits nonzero while the summary claims zero failures (F1: died for a
 *    non-test reason);
 *  - it exits 0 while the summary reports failures (F5: masked failure).
 * None of these may ever yield PASS or CONFIRMED_REGRESSION.
 */
export function infraCause(r: RoundFact): string | null {
  if (r.exitCode === -1) return 'killed or signal death';
  if (r.infraSignal) return 'recognized infrastructure-failure signature in output';
  if (!r.hasRunnerSummary) return 'no test-runner summary — execution not recognizable as a test run';
  const observed =
    r.reportedPassing !== undefined || r.reportedFailing !== undefined || r.reportedPending !== undefined;
  const executed = (r.reportedPassing ?? 0) + (r.reportedFailing ?? 0) + (r.reportedPending ?? 0);
  if (observed && executed === 0) return 'runner summary reports zero executed tests';
  if (r.exitCode === 0 && (r.reportedFailing ?? 0) > 0) return 'exit 0 while summary reports failing tests (masked failure)';
  if (r.exitCode !== 0 && (r.reportedFailing ?? 0) === 0) return 'nonzero exit while summary reports zero failing tests (died outside tests)';
  return null;
}

function isInfraRound(r: RoundFact): boolean {
  return infraCause(r) !== null;
}

const pass = (r: RoundFact): boolean => r.exitCode === 0;
const unanimous = (rs: readonly RoundFact[]): boolean =>
  rs.length > 0 && rs.every((r) => pass(r) === pass(rs[0]!));

/**
 * Identity of a round's failure: how many tests the summary said failed, and
 * WHICH ones. '?' distinguishes "not observed" from "observed as zero/empty",
 * so a runner whose summary parses on some rounds but not others counts as
 * non-uniform (defensible: the failure record itself varies run-to-run).
 */
function failureProfile(r: RoundFact): string {
  const count = r.reportedFailing === undefined ? '?' : String(r.reportedFailing);
  const names = Array.isArray(r.failingTestNames)
    ? [...r.failingTestNames].sort().join('\n')
    : '?';
  return `${count}|${names}`;
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

export function classify(rounds: readonly RoundFact[]): ClassificationResult {
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

  const cAllPass = candidate.every(pass);
  const cAllFail = candidate.every((r) => !pass(r));

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
}

/**
 * Rule 9 — CONFINEMENT IS ENFORCED, NOT DECORATIVE (audit F9; the guard that
 * used to live inline in the pipeline was untested, so deleting it changed
 * nothing in the suite). Arms whose dependency trees differ OUTSIDE the
 * studied dependency's subtree are not comparable: no verdict may be based
 * on them, so any trustful classification is downgraded to INCONCLUSIVE
 * rule 9. INFRASTRUCTURE_FAILURE keeps its own (higher-fidelity) reason.
 *
 * Pure and total; the evidence validator independently rejects trustful
 * labels under driftConfinedToDependency=false, so a bundle that skipped
 * this guard cannot validate either.
 */
export function applyConfinementGuard(
  cls: ClassificationResult, drift: Confinement,
): ClassificationResult {
  if (drift.confined || cls.classification === 'INFRASTRUCTURE_FAILURE') return cls;
  return {
    ...cls,
    classification: 'INCONCLUSIVE',
    rule: 9,
    reason: `tree drift outside ${drift.dependency} subtree (${drift.other.slice(0, 6).join(', ')}) — arms not comparable`,
  };
}
