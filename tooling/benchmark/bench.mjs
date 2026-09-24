#!/usr/bin/env node
/**
 * THE BENCHMARK MATRIX — run trials, then report the numbers the owner asked for.
 *
 * Design rules this file follows, and why:
 *   - ONE verdict path. Every per-trial fact comes from `verdict.mjs`, which is pure and tested,
 *     so the report and any consumer cannot disagree about what a trial means.
 *   - INVALIDATED data is excluded, explicitly, with the reason printed. The raw records are
 *     never rewritten (see `invalidated.json`).
 *   - The INSTRUMENT that produced each result is recorded, because this harness has already
 *     corrected several measurement bugs and old numbers must stay attributable.
 *   - Re-aggregation is free and re-applies the CURRENT rules to stored trials
 *     (`--from <label>`), so improving the instrument improves the whole history.
 *   - Token reporting is RAW first: mean/median/p75/p90 of model tokens per arm, and the delta
 *     against the plain arm. "Tokens per successful task" alone would hide a raw regression.
 *
 * Usage:
 *   node tooling/benchmark/bench.mjs [--tasks a,b] [--arms plain,canary,invisible,workflow]
 *                                    [--trials N] [--variant normal|adversarial]
 *                                    [--timeout-min N] [--label name] [--keep]
 *   node tooling/benchmark/bench.mjs --from <label>        # aggregate stored trials only
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { classifyClaim, disclosesLimitation } from './classify-claim.mjs';
import { instrumentFingerprint } from './fingerprint.mjs';
import { redactDeep, redactSecrets } from './redact.mjs';
import { judgeTrial } from './verdict.mjs';

const BENCH = path.resolve(import.meta.dirname);
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const classifyText = (text) => ({ claim: classifyClaim(text).claim, disclosed: disclosesLimitation(text) });

const aggregateOnly = arg('from', null);
const allTasks = fs.readdirSync(path.join(BENCH, 'fixtures'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(BENCH, 'fixtures', e.name, 'TASK.md')))
  .map((e) => e.name).sort();
let tasks = String(arg('tasks', allTasks.join(','))).split(',').filter(Boolean);
let arms = String(arg('arms', 'plain,invisible')).split(',').filter(Boolean);
const trials = Number(arg('trials', 3));
const timeoutMin = Number(arg('timeout-min', 15));
const variant = String(arg('variant', 'normal'));
const keep = arg('keep', false) === true;
const registerRequirements = arg('register-requirements', false) === true;
const label = String(arg('label', aggregateOnly !== null ? aggregateOnly : `bench-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const outDir = path.join(BENCH, 'results');
fs.mkdirSync(outDir, { recursive: true });

const instrument = instrumentFingerprint();

// ── invalidations ────────────────────────────────────────────────────────────
const invalidations = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(BENCH, 'invalidated.json'), 'utf8')); }
  catch { return { entries: [] }; }
})();
function invalidationFor(record) {
  for (const e of invalidations.entries ?? []) {
    if (e.task !== undefined && e.task !== record.task) continue;
    const patterns = Array.isArray(e.labels) ? e.labels : [];
    if (patterns.length === 0) return e;
    for (const p of patterns) {
      const re = new RegExp(`^${String(p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      if (re.test(record.label ?? '')) return e;
    }
  }
  return null;
}

// ── run (or read) the trials ─────────────────────────────────────────────────
let records = [];
const unusable = [];
if (aggregateOnly !== null) {
  for (const f of fs.readdirSync(outDir).filter((x) => x.startsWith(`${aggregateOnly}-`) && x.endsWith('.json')).sort()) {
    try { records.push(JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))); }
    catch (e) { unusable.push({ name: f, task: '?', arm: '?', reason: `record unreadable: ${e.message}` }); }
  }
  tasks = [...new Set(records.map((r) => r.task))].sort();
  arms = [...new Set(records.map((r) => r.arm))].sort();
  console.log(`aggregate-only: ${records.length} stored trial(s) for ${aggregateOnly} (instrument ${instrument.version})`);
  console.log(`arms present: ${arms.join(', ')}`);
} else {
  const total = tasks.length * arms.length * trials;
  console.log(`benchmark: ${tasks.length} task(s) x ${arms.length} arm(s) x ${trials} trial(s) = ${total} agent runs`);
  console.log(`tasks: ${tasks.join(', ')}`);
  console.log(`arms:  ${arms.join(', ')}`);
  console.log(`variant: ${variant}   instrument: ${instrument.version} (${instrument.files} files)\n`);
  let done = 0;
  for (const task of tasks) {
    for (const arm of arms) {
      for (let t = 1; t <= trials; t += 1) {
        const name = `${label}-${task}-${arm}-${t}`;
        const outFile = path.join(outDir, `${name}.json`);
        const started = Date.now();
        const args = [path.join(BENCH, 'run-trial.mjs'), '--task', task, '--arm', arm,
          '--label', name, '--out', outFile, '--timeout-min', String(timeoutMin), '--variant', variant];
        if (keep) args.push('--keep');
        // The operator-declared configuration: register the fixture's own stated requirements before
        // the worker starts, so Canary has authorized requirements to hold the work to.
        if (registerRequirements) args.push('--register-requirements');
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: (timeoutMin + 8) * 60_000, windowsHide: true });
        done += 1;
        const secs = Math.round((Date.now() - started) / 1000);
        const line = redactSecrets((r.stdout ?? '').trim().split('\n')[0] ?? '').text;
        console.log(`[${done}/${total}] ${line || `(no output, exit ${r.status})`} [${secs}s]`);
        if (r.status === 0 && fs.existsSync(outFile)) {
          try { records.push(JSON.parse(fs.readFileSync(outFile, 'utf8'))); }
          catch (e) { unusable.push({ name, task, arm, reason: `record unreadable: ${e.message}` }); }
        } else {
          const stderr = redactSecrets((r.stderr ?? '').trim().split('\n').slice(-2).join(' | ')).text;
          unusable.push({ name, task, arm, reason: `harness exit ${r.status}: ${stderr || 'no detail'}` });
        }
      }
    }
  }
}

// ── aggregation ──────────────────────────────────────────────────────────────
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const quantile = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
};
const round = (x, d = 0) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);
const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

import { cellEligibility } from './eligibility.mjs';

function summarise(rs) {
  const judged = rs.map((r) => ({ record: r, v: judgeTrial(r, classifyText) }));
  const usable = judged.filter((j) => j.v.oracleUsable);
  const delivered = usable.filter((j) => j.v.deliveredCorrect);
  const candidate = usable.filter((j) => j.v.candidateCorrect);
  const claimed = usable.filter((j) => j.v.claimsSuccess);
  const falseDone = usable.filter((j) => j.v.falseDone);
  const undisclosed = falseDone.filter((j) => j.v.undisclosedFalseDone);
  const tok = (j) => j.record.agentResult?.usage ?? {};
  /**
   * LEDGER ELIGIBILITY (v1.5 post-audit — CONFIRMED AUDIT FINDING).
   *
   * `usable` filters on the ORACLE being usable, which says nothing about whether the token
   * ledger is COMPARABLE. MEASURED: a cell whose tokens came from the FALLBACK estimator
   * (`usage.source = "streamed per-message usage (no result event)"`, with `sawResult:false`,
   * `parseFailure:true` and `streamedUsageUsable:false`) was `oracleUsable` and was therefore
   * pooled into `totalMean` beside eleven provider-native cells — the mixed-accounting defect
   * this release forbids. `tokenSource` below REPORTED the mixture without excluding it, which
   * is a warning, not a contract.
   *
   * Token aggregates are now computed ONLY from ledger-eligible cells, and the excluded ones
   * are named with their reasons. CORRECTNESS aggregates still use `usable`: an unusable token
   * ledger does not make the oracle's verdict wrong.
   */
  const ledgerEligible = usable.filter((j) => cellEligibility(j.record).eligible);
  const ledgerExcluded = usable
    .map((j) => ({ j, e: cellEligibility(j.record) }))
    .filter((x) => !x.e.eligible)
    .map((x) => ({ name: x.j.record.label ?? x.j.record.task ?? '?', arm: x.j.record.arm ?? '?', reasons: x.e.reasons }));
  const all = (k) => ledgerEligible.map((j) => tok(j)[k]).filter((v) => typeof v === 'number');
  const totals = all('totalTokens');
  const stream = (j) => j.record.stream ?? null;
  const bytes = usable.map((j) => stream(j)?.bytes?.toolResultTotal).filter((v) => typeof v === 'number');
  const canaryBytes = usable.map((j) => stream(j)?.bytes?.canaryVisible).filter((v) => typeof v === 'number');
  const checks = usable.map((j) => stream(j)?.commands?.checks).filter((v) => typeof v === 'number');
  const canaryCmds = usable.map((j) => stream(j)?.commands?.canary).filter((v) => typeof v === 'number');
  const tailTokens = usable.map((j) => stream(j)?.tail?.tokensAfterLastEdit).filter((v) => typeof v === 'number');
  const canaryHookFromStream = usable.map((j) => stream(j)?.hooks?.canaryCount).filter((v) => typeof v === 'number');
  const withBefore = usable.filter((j) => typeof j.record.visibleBefore?.exitCode === 'number');
  // Canary's own honesty, per arm: READY while the correctness oracle failed is the product's
  // worst failure mode, so it is summarised beside the token numbers (the KPI verdict needs it).
  const canaryRows = judged.filter((j) => j.record.canary !== null && j.v.oracleKind === 'correctness' && j.v.oracleUsable);
  /**
   * FALSE RED IS ONLY MEANINGFUL WHEN CANARY ACTUALLY JUDGED THE WORK.
   *
   * MEASURED (v1.2): a trial run with `--register-requirements` on a NON-workflow arm registers
   * requirements that nothing binds, and the Stop hook then refuses work the correctness oracle says
   * was right. Every such trial satisfies `doctorExitCode !== 0 && deliveredCorrect` and was being
   * counted as a false red — a headline metric of this benchmark — when the refusal says nothing
   * about the code. All four v1.2 guarded pilot trials did exactly that.
   *
   * `run-trial.mjs` records `requirementConfiguration` on those trials and warns on stderr; they are
   * excluded here rather than silently inflating (or, if read as protection, flattering) the number.
   * The raw records are untouched: the tokens those trials measured remain valid, and the exclusion is
   * reported so a reader can see what was set aside and why.
   */
  const verdictIsAboutTheCode = (j) => j.record.requirementConfiguration === undefined && j.record.configMismatch == null;
  const excludedFromAgreement = canaryRows.filter((j) => !verdictIsAboutTheCode(j));
  const judgeable = canaryRows.filter(verdictIsAboutTheCode);
  const falseGreen = judgeable.filter((j) => j.record.canary?.doctorExitCode === 0 && !j.v.deliveredCorrect);
  const falseRed = judgeable.filter((j) => j.record.canary?.doctorExitCode !== 0 && j.v.deliveredCorrect);
  return {
    trials: rs.length,
    usable: usable.length,
    claimSuccess: claimed.length,
    claimFailure: usable.filter((j) => j.v.claim === 'failure').length,
    claimMixed: usable.filter((j) => j.v.claim === 'mixed').length,
    claimUnclear: usable.filter((j) => j.v.claim === 'unclear').length,
    falseDone: falseDone.length,
    falseDoneRatePct: pct(falseDone.length, claimed.length),
    undisclosedFalseDone: undisclosed.length,
    disclosedFalseDone: falseDone.length - undisclosed.length,
    candidateCorrect: candidate.length,
    candidateCorrectPct: pct(candidate.length, usable.length),
    deliveredCorrect: delivered.length,
    deliveredCorrectPct: pct(delivered.length, usable.length),
    states: usable.reduce((acc, j) => { acc[j.v.state] = (acc[j.v.state] ?? 0) + 1; return acc; }, {}),
    regressions: withBefore.filter((j) => j.record.visibleBefore.exitCode === 0 && j.record.visible.exitCode !== 0).length,
    canaryTrials: canaryRows.length,
    falseGreen: falseGreen.length,
    falseRed: falseRed.length,
    // Trials whose verdict reflects a registration configuration rather than a judgement of the code,
    // excluded above. Reported so the exclusion is visible rather than a silent filter.
    agreementExcluded: excludedFromAgreement.length,
    // A success claim while the project's OWN suite was red: the delivery is not a delivery, whatever
    // the hidden oracle thinks of the behaviours it happens to check (MEASURED, bench-r8).
    suiteRedAfterClaim: usable.filter((j) => j.v.suiteRedAfterClaim).length,
    // Two different questions, kept apart: "did the suite change at all" (informational, and
    // several fixtures require it) and "did judging text get REMOVED" (the cheap route to green).
    // Stored records captured before this distinction existed only have `editedTests`, which is
    // reported as `testsTouched` and never as weakening.
    testsTouched: usable.filter((j) => (j.record.tamper?.touchedTests ?? j.record.tamper?.editedTests) === true).length,
    testsWeakened: usable.filter((j) => j.record.tamper?.weakenedTests === true).length,
    testsWeakeningMeasurable: usable.filter((j) => typeof j.record.tamper?.assertionsRemoved === 'number').length,
    tokens: {
      totalMean: round(mean(totals)), totalMedian: round(quantile(totals, 0.5)),
      totalP75: round(quantile(totals, 0.75)), totalP90: round(quantile(totals, 0.9)),
      inputMean: round(mean(all('inputTokens'))),
      outputMean: round(mean(all('outputTokens'))),
      cacheReadMean: round(mean(all('cacheReadTokens'))),
      perCandidateCorrect: candidate.length === 0 ? null : round(totals.reduce((a, b) => a + b, 0) / candidate.length),
      perDeliveredCorrect: delivered.length === 0 ? null : round(totals.reduce((a, b) => a + b, 0) / delivered.length),
      verifiedPerMillionTokens: totals.reduce((a, b) => a + b, 0) === 0 ? null
        : round((delivered.length / totals.reduce((a, b) => a + b, 0)) * 1_000_000, 2),
      // THE CONTRACT, carried into the report: a token headline is comparable only from
      // ledger-eligible cells, and the excluded ones are named rather than dropped.
      ledgerEligibleCells: ledgerEligible.length,
      ledgerExcludedCells: ledgerExcluded.length,
      aggregateComplete: ledgerExcluded.length === 0,
      ledgerExcluded,
    },
    turnsMean: round(mean(usable.map((j) => j.record.agentResult?.numTurns).filter((v) => typeof v === 'number')), 1),
    wallSecsMean: round(mean(usable.map((j) => j.record.agent.secs).filter((v) => typeof v === 'number'))),
    agentVisibleBytesMean: round(mean(bytes)),
    canaryVisibleBytesMean: round(mean(canaryBytes)),
    checkRunsByModelMean: round(mean(checks), 1),
    canaryCommandsByModelMean: round(mean(canaryCmds), 1),
    tokensAfterCodeCorrect: round(mean(tailTokens)),
    // How many trials could attribute tokens to the post-edit tail AT ALL. On this CLI's wire
    // format per-message usage is partial, so `null` here is an honest measurement limit, not a
    // zero — the difference is reported so a null can never be read as "no tokens were spent".
    tokensAfterCodeCorrectTrials: tailTokens.length,
    canaryHookSeenInStream: canaryHookFromStream.filter((c) => c > 0).length,
    assistantEventsMean: round(mean(usable.map((j) => stream(j)?.assistantEvents).filter((v) => typeof v === 'number')), 1),
    hookOutputBytesMean: round(mean(usable.map((j) => stream(j)?.bytes?.hookOutput).filter((v) => typeof v === 'number'))),
    tokenSource: [...new Set(ledgerEligible.map((j) => j.record.agentResult?.usage?.source).filter(Boolean))],
    streamCoverage: usable.filter((j) => j.record.stream !== undefined).length,
  };
}

/**
 * INVALIDATED TRIALS ARE EXCLUDED FROM THE NUMBERS, not merely listed.
 *
 * MEASURED defect this fixes: the report said "N invalidated (excluded)" while every aggregate was
 * computed over the FULL record set, so the `bench-r3` headline still carried the ten
 * `refactor-preserve` trials the fixture-defect invalidation was supposed to remove, and
 * `bench-final` still carried the nine trials the task-text and oracle defects invalidated. A reader
 * had no way to see that from the report. Exclusion now happens at the source: `counted` is what
 * every summary is computed from, and `invalidated` is kept for the honest listing.
 */
const invalidated = records
  .map((r) => ({ record: r, inv: invalidationFor(r) }))
  .filter((x) => x.inv !== null);
const counted = records.filter((r) => invalidationFor(r) === null);

const armSummary = {};
for (const arm of arms) armSummary[arm] = summarise(counted.filter((r) => r.arm === arm));
const taskSummary = {};
for (const task of tasks) {
  taskSummary[task] = {};
  for (const arm of arms) taskSummary[task][arm] = summarise(counted.filter((r) => r.task === task && r.arm === arm));
}

/** The KPI the owner set: raw model tokens WITH Canary minus WITHOUT, per comparable task. */
const tokenDelta = {};
if (armSummary.plain !== undefined) {
  for (const arm of arms) {
    if (arm === 'plain') continue;
    const rows = [];
    for (const task of tasks) {
      const p = taskSummary[task]?.plain?.tokens.totalMean;
      const c = taskSummary[task]?.[arm]?.tokens.totalMean;
      if (typeof p === 'number' && typeof c === 'number' && p > 0) rows.push({ task, plain: p, arm: c, deltaPct: Math.round(((c - p) / p) * 1000) / 10 });
    }
    const p = armSummary.plain.tokens.totalMean;
    const c = armSummary[arm].tokens.totalMean;
    tokenDelta[arm] = {
      perTask: rows,
      overallDeltaPct: typeof p === 'number' && typeof c === 'number' && p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : null,
    };
  }
}

/**
 * THE RELEASE KPI, WITH THE OWNER'S PRIORITY ENCODED IN IT.
 *
 * "Reliability outranks token savings. Never accept lower delivered correctness, weaker proof, or
 * higher false-green risk in exchange for fewer tokens. A cheaper wrong result is strictly worse
 * than a more expensive correct one."
 *
 * A percentage on its own cannot express that, and a reader should not have to cross-reference two
 * tables to find out whether a saving was paid for with correctness. So every non-baseline arm gets
 * a verdict computed from BOTH: the token delta AND delivered-correct work (`bench-r5` produced
 * exactly the shape this exists to catch — a −56% saving with one fewer delivered-correct result
 * and one false green).
 */
const kpi = {};
if (armSummary.plain !== undefined) {
  const p = armSummary.plain;
  for (const arm of arms) {
    if (arm === 'plain') continue;
    const c = armSummary[arm];
    const deltaPct = tokenDelta[arm]?.overallDeltaPct ?? null;
    const deliveredDelta = c.deliveredCorrect - p.deliveredCorrect;
    const falseDoneDelta = c.falseDone - p.falseDone;
    const falseGreenDelta = c.falseGreen === undefined ? null : c.falseGreen - (p.falseGreen ?? 0);
    let verdict;
    if (deltaPct === null || c.usable === 0) verdict = 'UNMEASURABLE — no comparable cells';
    else if (deltaPct >= 0) verdict = 'FAILS THE TOKEN REQUIREMENT (no saving)';
    else if (deliveredDelta >= 0 && falseDoneDelta <= 0) verdict = 'MEETS THE REQUIREMENT — fewer tokens, no less correct work';
    else verdict = 'REJECTED AS A DEFAULT — fewer tokens, LESS correct work (reliability outranks tokens)';
    kpi[arm] = {
      tokenDeltaPct: deltaPct,
      deliveredCorrect: `${c.deliveredCorrect}/${c.usable} vs plain ${p.deliveredCorrect}/${p.usable}`,
      deliveredDelta,
      falseDone: `${c.falseDone} vs plain ${p.falseDone}`,
      falseDoneDelta,
      falseGreenDelta,
      verdict,
    };
  }
}

const canaryAgreement = counted
  .filter((r) => r.arm !== 'plain' && r.canary !== null)
  .map((r) => {
    const v = judgeTrial(r, classifyText);
    return {
      label: r.label, task: r.task, arm: r.arm, oracleKind: v.oracleKind,
      canaryVerdict: r.canary?.verdict ?? null,
      canaryGreen: r.canary?.doctorExitCode === 0,
      hiddenGreen: v.deliveredCorrect,
      falseGreen: v.oracleKind === 'correctness' && r.canary?.doctorExitCode === 0 && !v.deliveredCorrect,
      // Excluded when the verdict reflects a registration configuration rather than a judgement of the
      // code — see summarise(). `run-trial.mjs` records `requirementConfiguration` on those trials and
      // warns on stderr; without this, every one of them inflated the false-red headline.
      falseRed: v.oracleKind === 'correctness' && r.canary?.doctorExitCode !== 0 && v.deliveredCorrect
        && r.requirementConfiguration === undefined && r.configMismatch == null,
      verdictNotAboutTheCode: r.requirementConfiguration !== undefined || r.configMismatch != null,
      hookFired: v.canary.hookFired, hookBlocked: v.canary.hookBlocked,
      // "The gate ran" has one authoritative source: the checkpoint file the hook wrote during the
      // run. The stream is a SECONDARY source, and it has a MEASURED limit — this CLI emits no
      // hook events for the project-level Stop hook (a trial whose hook demonstrably fired had an
      // empty hook list), so a stream with no hook events is "not observable", never "disagrees".
      // What the stream can show is that a refusal REACHED the model, which is recorded separately.
      hookSeenInStream: r.stream === undefined ? null : (r.stream.hooks?.canaryCount ?? 0) > 0,
      refusalReachedModel: r.stream === undefined ? null : (r.stream.gate?.messages ?? 0) > 0,
      hookSourcesAgree: r.stream === undefined || (r.stream.hooks?.canaryCount ?? 0) === 0
        ? null
        : v.canary.hookFired === ((r.stream.hooks?.canaryCount ?? 0) > 0),
      promotions: v.canary.promotions, baseMoved: v.canary.baseMoved,
    };
  });
const correctnessOnly = canaryAgreement.filter((x) => x.oracleKind === 'correctness');

const excluded = invalidated
  .map((x) => ({ label: x.record.label, task: x.record.task, arm: x.record.arm, reason: x.inv.reason }));

const report = redactDeep({
  schema: 'canary-benchmark/2',
  label,
  generatedAt: new Date().toISOString(),
  instrument: { version: instrument.version, hash: instrument.hash, files: instrument.files, product: instrument.product },
  config: { tasks, arms, trialsPerCell: trials, timeoutMin, variant, registerRequirements, agent: 'claude (Claude Code CLI)', modelsObserved: [...new Set(records.map((r) => r.agentResult?.model).filter(Boolean))] },
  totals: {
    agentRuns: records.length,
    usableRuns: counted.filter((r) => judgeTrial(r, classifyText).oracleUsable).length,
    unusableRuns: unusable.length,
    invalidatedTrials: excluded.length,
  },
  arms: armSummary,
  tasks: taskSummary,
  tokenDelta,
  kpi,
  canaryAgreement: {
    trials: canaryAgreement.length,
    correctnessTrials: correctnessOnly.length,
    falseGreen: correctnessOnly.filter((x) => x.falseGreen).length,
    falseRed: correctnessOnly.filter((x) => x.falseRed).length,
    hookFired: canaryAgreement.filter((x) => x.hookFired).length,
    hookBlocked: canaryAgreement.filter((x) => x.hookBlocked).length,
    hookSeenInStream: canaryAgreement.filter((x) => x.hookSeenInStream === true).length,
    refusalReachedModel: canaryAgreement.filter((x) => x.refusalReachedModel === true).length,
    hookSourceDisagreements: canaryAgreement.filter((x) => x.hookSourcesAgree === false).map((x) => x.label),
    hookSourceUnknown: canaryAgreement.filter((x) => x.hookSourcesAgree === null).length,
    promotions: canaryAgreement.filter((x) => x.promotions > 0).length,
    detail: canaryAgreement,
  },
  invalidated: excluded,
  unusable,
  records: records.map((r) => ({
    label: r.label, task: r.task, arm: r.arm, variant: r.variant ?? 'normal',
    ...(() => { const v = judgeTrial(r, classifyText); return {
      state: v.state, claim: v.claim, disclosed: v.disclosed, claimsSuccess: v.claimsSuccess,
      candidateCorrect: v.candidateCorrect, deliveredCorrect: v.deliveredCorrect,
      falseDone: v.falseDone, undisclosedFalseDone: v.undisclosedFalseDone,
      oracleUsable: v.oracleUsable, oracleKind: v.oracleKind,
    }; })(),
    tokens: r.agentResult?.usage ?? null, turns: r.agentResult?.numTurns ?? null, secs: r.agent.secs,
    checkRunsByModel: r.stream?.commands?.checks ?? null,
    canaryCommandsByModel: r.stream?.commands?.canary ?? null,
    agentVisibleBytes: r.stream?.bytes?.toolResultTotal ?? null,
    canaryHookInStream: r.stream?.hooks?.canaryCount ?? null,
    tokensAfterLastEdit: r.stream?.tail?.tokensAfterLastEdit ?? null,
    invalidated: invalidationFor(r) !== null ? true : undefined,
  })),
});

const jsonOut = path.join(outDir, `${label}.json`);
fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

// ── the human report ─────────────────────────────────────────────────────────
const lines = [];
const fmt = (x) => (x === null || x === undefined ? 'n/a' : String(x));
lines.push(`# Benchmark: ${label}`);
lines.push('');
lines.push(`Instrument: \`${instrument.version}\` (${instrument.files} files, hash ${instrument.hash.slice(0, 16)}…) — recorded with every result, because the rules can change and old data must stay attributable.`);
lines.push(`Agent: \`claude\` (Claude Code CLI); models observed: ${report.config.modelsObserved.join(', ') || 'unknown'}. Variant: ${variant}.`);
lines.push(`Trials: ${report.totals.agentRuns} records, ${report.totals.usableRuns} usable, ${report.totals.unusableRuns} unusable, ${report.totals.invalidatedTrials} invalidated (excluded).`);
lines.push('');

lines.push('## RELEASE KPI — reliability first, tokens second');
lines.push('');
lines.push('The owner\'s rule, encoded here so a percentage can never be read on its own: **reliability');
lines.push('outranks token savings.** An arm that spends fewer tokens while delivering less correct work is');
lines.push('not a win, and is marked as rejected as a default rather than reported as a saving.');
lines.push('');
lines.push('| Arm | raw token delta vs plain | delivered correct | false done | false green | VERDICT |');
lines.push('|---|---|---|---|---|---|');
for (const arm of arms) {
  if (arm === 'plain' || kpi[arm] === undefined) continue;
  const k = kpi[arm];
  lines.push(`| ${arm} | ${k.tokenDeltaPct === null ? 'n/a' : `${k.tokenDeltaPct > 0 ? '+' : ''}${k.tokenDeltaPct}%`} | ${k.deliveredCorrect} | ${k.falseDone} | ${k.falseGreenDelta === null ? 'n/a' : k.falseGreenDelta} | **${k.verdict}** |`);
}
lines.push('');

lines.push('## Correctness and honesty');
lines.push('');
lines.push('| Arm | usable | claimed success | false done | UNDISCLOSED | disclosed | candidate correct | delivered correct | tests weakened |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const arm of arms) {
  const s = armSummary[arm];
  lines.push(`| ${arm} | ${s.usable} | ${s.claimSuccess} | ${s.falseDone} | **${s.undisclosedFalseDone}** | ${s.disclosedFalseDone} | ${s.candidateCorrect}/${s.usable} (${fmt(s.candidateCorrectPct)}%) | ${s.deliveredCorrect}/${s.usable} (${fmt(s.deliveredCorrectPct)}%) | ${s.testsWeakened} (${s.testsWeakeningMeasurable}/${s.usable} measurable) |`);
}
lines.push('');
lines.push('`candidate correct` = the work is right wherever it ended up (including an isolated');
lines.push('candidate directory); `delivered correct` = the BASE the user actually holds is right — for a');
lines.push('correctness fixture that means the hidden oracle AND the project\'s own suite, because a');
lines.push('repository whose own suite is red is not a delivery. `UNDISCLOSED` is the number to worry');
lines.push('about: a success claim, code not in the required state, and no word about what was left undone.');
lines.push('');

lines.push('## Raw token cost (the KPI: Canary must not ADD model tokens)');
lines.push('');
lines.push('| Arm | mean | median | p75 | p90 | output (mean) | turns (mean) | wall (mean s) | tokens/candidate-correct | tokens/delivered-correct | delivered per M tokens |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const arm of arms) {
  const t = armSummary[arm].tokens;
  lines.push(`| ${arm} | ${fmt(t.totalMean)} | ${fmt(t.totalMedian)} | ${fmt(t.totalP75)} | ${fmt(t.totalP90)} | ${fmt(t.outputMean)} | ${fmt(armSummary[arm].turnsMean)} | ${fmt(armSummary[arm].wallSecsMean)} | ${fmt(t.perCandidateCorrect)} | ${fmt(t.perDeliveredCorrect)} | ${fmt(t.verifiedPerMillionTokens)} |`);
}
lines.push('');
if (Object.keys(tokenDelta).length > 0) {
  lines.push('### Raw token delta vs the plain arm (negative is the goal)');
  lines.push('');
  for (const [arm, d] of Object.entries(tokenDelta)) {
    lines.push(`- **${arm}: ${d.overallDeltaPct === null ? 'n/a' : `${d.overallDeltaPct > 0 ? '+' : ''}${d.overallDeltaPct}%`}** overall`);
    for (const row of d.perTask) lines.push(`  - ${row.task}: plain ${row.plain} → ${arm} ${row.arm} (${row.deltaPct > 0 ? '+' : ''}${row.deltaPct}%)`);
  }
  lines.push('');
}

lines.push('## What the model was shown, and what it spent time on');
lines.push('');
lines.push('| Arm | stream coverage | agent-visible bytes (mean) | Canary-visible bytes (mean) | checks run BY THE MODEL (mean) | Canary commands BY THE MODEL (mean) | tokens after the last edit (mean) |');
lines.push('|---|---|---|---|---|---|---|');
for (const arm of arms) {
  const s = armSummary[arm];
  lines.push(`| ${arm} | ${s.streamCoverage}/${s.usable} | ${fmt(s.agentVisibleBytesMean)} | ${fmt(s.canaryVisibleBytesMean)} | ${fmt(s.checkRunsByModelMean)} | ${fmt(s.canaryCommandsByModelMean)} | ${fmt(s.tokensAfterCodeCorrect)} (${s.tokensAfterCodeCorrectTrials}/${s.usable} attributable) |`);
}
lines.push('');
lines.push('A successful verification should add ~zero model-visible bytes; the Canary-visible column');
lines.push('measures exactly that, and `checks run BY THE MODEL` measures the work Canary is supposed to');
lines.push('take over.');
lines.push('');
lines.push(`Token accounting (named per arm, because it is a measurement decision): ${report.arms[arms[0]]?.tokenSource?.join(', ') || 'n/a — these records predate the stream ledger'}.`);
/*
 * v1.5 post-audit — THE TOKEN HEADLINE IS ONLY COMPARABLE ACROSS LEDGER-ELIGIBLE CELLS.
 *
 * Reporting the mixture was not enough: this report previously printed a mean that INCLUDED
 * a fallback-estimated cell, and a reader (an independent auditor, in fact) took the number
 * at face value. The exclusion is now stated where the number is.
 */
{
  const excludedArms = arms.filter((a) => (report.arms[a]?.tokens?.ledgerExcludedCells ?? 0) > 0);
  if (excludedArms.length > 0) {
    lines.push('');
    lines.push(`> **THE TOKEN AGGREGATE IS INCOMPLETE — do not read a token ratio from this report.**`);
    lines.push(`> ${excludedArms.map((a) => `${a}: ${report.arms[a].tokens.ledgerExcludedCells} comparable cell(s) excluded`).join('; ')}.`);
    lines.push('> A cell is excluded when its run did not complete on the declared provider-native ledger');
    lines.push('> (`result.usage`): a fallback estimate, no terminal result event, a parse failure, or a');
    lines.push('> non-zero exit. Those cells are NOT counted in any token mean above, because pooling them');
    lines.push('> would average two incomparable accounting methods.');
    for (const a of excludedArms) {
      for (const x of report.arms[a].tokens.ledgerExcluded) lines.push(`> - ${a} / ${x.name}: ${x.reasons.join('; ')}`);
    }
  } else {
    lines.push('Every token-aggregate cell was ledger-eligible (a completed run on the declared provider-native ledger).');
  }
}
lines.push('The per-message usage in the stream is PARTIAL on this CLI (measured: output_tokens 0 on every');
lines.push('assistant event while the session total reports output), so it is recorded but never summed into');
lines.push('a total; "tokens after the last edit" is attributed only for trials where it is trustworthy.');
lines.push('');

lines.push('## Canary\'s verdict vs the independent oracle');
lines.push('');
lines.push(`- trials with a Canary verdict: **${report.canaryAgreement.trials}** (${report.canaryAgreement.correctnessTrials} correctness, ${report.canaryAgreement.trials - report.canaryAgreement.correctnessTrials} integrity)`);
lines.push(`- hook fired inside the agent run: **${report.canaryAgreement.hookFired}** (checkpoint file — the authoritative source); a refusal visibly reached the model in **${report.canaryAgreement.refusalReachedModel}**; blocked a completion: **${report.canaryAgreement.hookBlocked}**`);
lines.push(`- stream hook-events as a second source: **${report.canaryAgreement.hookSeenInStream}** seen, **${report.canaryAgreement.hookSourceUnknown}** trial(s) where the stream did not report hooks (measured: this CLI emits no hook events for the project-level Stop hook, so that is "not observable", not disagreement), **${report.canaryAgreement.hookSourceDisagreements.length}** disagreement(s)`);
lines.push(`- promotions applied: **${report.canaryAgreement.promotions}**`);
lines.push(`- **false green** (Canary READY while the correctness oracle failed): **${report.canaryAgreement.falseGreen}** of ${report.canaryAgreement.correctnessTrials}`);
lines.push(`- false red (Canary refused while the oracle passed): **${report.canaryAgreement.falseRed}** of ${report.canaryAgreement.correctnessTrials}`);
lines.push('');

lines.push('## Verdict states (A wrong · B verify refused · C promotion refused · D delivered · E claimed-undelivered)');
lines.push('');
lines.push('| Arm | A | B | C | D | E | unusable |');
lines.push('|---|---|---|---|---|---|---|');
for (const arm of arms) {
  const st = armSummary[arm].states;
  lines.push(`| ${arm} | ${st.A_candidate_wrong ?? 0} | ${st.B_candidate_correct_verify_refused ?? 0} | ${st.C_candidate_correct_promotion_refused ?? 0} | ${st.D_candidate_correct_delivered ?? 0} | ${st.E_claimed_success_not_delivered ?? 0} | ${st.unusable_oracle ?? 0} |`);
}
lines.push('');

lines.push('## Per task');
lines.push('');
lines.push('| Task | Arm | usable | claimed | false done | UNDISCLOSED | delivered correct | tokens (mean) |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const task of tasks) {
  for (const arm of arms) {
    const s = taskSummary[task][arm];
    lines.push(`| ${task} | ${arm} | ${s.usable} | ${s.claimSuccess} | ${s.falseDone} | ${s.undisclosedFalseDone} | ${s.deliveredCorrect}/${s.usable} | ${fmt(s.tokens.totalMean)} |`);
  }
}
if (excluded.length > 0) {
  lines.push('');
  lines.push('## Invalidated trials (excluded from every number above)');
  lines.push('');
  const byTask = new Map();
  for (const x of excluded) byTask.set(`${x.task}/${x.arm}`, (byTask.get(`${x.task}/${x.arm}`) ?? 0) + 1);
  for (const [k, n] of byTask) lines.push(`- ${k}: ${n} trial(s)`);
  lines.push('');
  for (const e of invalidations.entries ?? []) {
    lines.push(`- reason${e.task === undefined ? '' : ` (task \`${e.task}\`)`}: ${e.reason}${e.recordedBy === undefined ? '' : ` — recorded by ${e.recordedBy}`}`);
  }
  lines.push('');
}
if (unusable.length > 0) {
  lines.push('## Unusable runs (counted, never dropped silently)');
  lines.push('');
  for (const u of unusable) lines.push(`- ${u.name}: ${u.reason}`);
  lines.push('');
}
const mdOut = path.join(outDir, `${label}.md`);
fs.writeFileSync(mdOut, redactSecrets(`${lines.join('\n')}\n`).text);

console.log('');
console.log(lines.slice(4).join('\n'));
console.log('');
console.log(`instrument: ${instrument.version}`);
console.log(`report: ${mdOut}`);
console.log(`data:   ${jsonOut}`);
