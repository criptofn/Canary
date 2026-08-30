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
 * tests. Guards encoded here (red-team F1/F5 + prototype lesson F7-degenerate):
 *  - exit ≠ 0 with no structured summary or an infra pattern -> infra
 *  - exit ≠ 0 while the summary reports 0 failing -> the process died for a
 *    non-test reason (port collision, teardown crash...) -> infra
 *  - exit = 0 while the summary reports ≥1 failing -> masked failure via a
 *    bad test command -> infra (never silently PASS)
 */
function isInfraRound(r: RoundFact): boolean {
  if (r.exitCode === -1) return true;
  if (r.exitCode !== 0 && (r.infraSignal || !r.hasRunnerSummary)) return true;
  if (r.exitCode !== 0 && r.hasRunnerSummary && r.reportedFailing === 0) return true;
  if (r.exitCode === 0 && (r.reportedFailing ?? 0) > 0) return true;
  return false;
}

const pass = (r: RoundFact): boolean => r.exitCode === 0;
const unanimous = (rs: readonly RoundFact[]): boolean =>
  rs.length > 0 && rs.every((r) => pass(r) === pass(rs[0]!));

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

  // Rule 1: any required round is an infra round -> INFRASTRUCTURE_FAILURE.
  const infraRounds = rounds.filter(isInfraRound);
  if (infraRounds.length > 0) {
    const first = infraRounds[0]!;
    return mk(
      'INFRASTRUCTURE_FAILURE', 1,
      `round ${first.arm}#${first.round} did not complete as a real test run ` +
      `(exit=${first.exitCode}, summary=${first.hasRunnerSummary}, infra=${first.infraSignal})`,
      { baselinePass: bPass, baselineUnanimous: bUnanim, candidateUnanimous: false },
    );
  }

  // Rule 2: unstable baseline invalidates the whole experiment.
  if (!bUnanim) {
    return mk('FLAKY', 2, 'baseline rounds disagree — environment cannot support a proof', {
      baselinePass: bPass, baselineUnanimous: false, candidateUnanimous: false,
    });
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
