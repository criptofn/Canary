#!/usr/bin/env node
/**
 * DOC CONSISTENCY — do the numbers in the release documents match the repository?
 *
 * WHY THIS EXISTS: this session's most persistent defect was not in the product. It was summaries
 * drifting from the thing they summarise. MEASURED, repeatedly:
 *   - `docs/V1.2-PLAN.md`'s FINAL STANDINGS said "35 commits" then "54 commits" long after both were
 *     false, and was re-derived by hand each time;
 *   - the README and CHANGELOG quoted a token figure from a configuration the harness now rejects;
 *   - the CHANGELOG table and the results document quoted "nine paired trials" when there are eight
 *     arm-trials across four paired fixtures;
 *   - a benchmark step label said "agrees with 395 stored trials" after the corpus had reached 410.
 *
 * Every one was caught by hand, one at a time, by someone already suspicious. That is not a control —
 * it is luck with a process around it. This probe re-derives the counts from the repository and compares
 * them against what the documents assert, so the drift is caught by a command instead of by memory.
 *
 * It checks only things that are MECHANICALLY checkable: counts of files, commits, fixtures, configs.
 * It does not try to check prose, and it does not claim to have verified every number in every
 * document — only the ones with a single unambiguous source.
 *
 * Usage: node tooling/probes/v12-doc-consistency.mjs
 * Exit:  0 when the documents agree with the repository; 1 otherwise, naming each disagreement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const git = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 60_000 }).stdout.trim();

// --- what the repository actually says -----------------------------------------------------
const commitsOnBranch = git(['rev-list', '--count', 'c559e55..HEAD']);
const resultsDir = path.join(REPO, 'tooling', 'benchmark', 'results');
const trialFiles = fs.readdirSync(resultsDir).filter((f) => /^v12/.test(f) && f.endsWith('.json'));
const cleanTrials = trialFiles.filter((f) => f.startsWith('v12clean-'));
const fixturesDir = path.join(REPO, 'tooling', 'benchmark', 'fixtures');
const fixtures = fs.readdirSync(fixturesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
const declaring = fixtures.filter((d) => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(fixturesDir, d.name, 'fixture.json'), 'utf8'));
    return j.benchmarkConfig !== undefined || Array.isArray(j.benchmarkConfigs)
      || typeof j.benchmarkArm === 'string' || Array.isArray(j.benchmarkArms);
  } catch {
    return false;
  }
});

const actual = {
  commits: Number(commitsOnBranch),
  v12Trials: trialFiles.length,
  cleanTrials: cleanTrials.length,
  fixtures: fixtures.length,
  declaringConfig: declaring.length,
};

// --- what the documents assert --------------------------------------------------------------
const plan = read('docs/V1.2-PLAN.md');
const findings = [];
/**
 * The check COUNT is counted, not written down. It used to be the literal `4 + 3` in the summary
 * line, which goes stale the moment a check is added — the same class of defect as a step label that
 * said "395 stored trials" after the corpus had reached 410.
 */
let checksRun = 0;
const check = (name, ok, detail) => {
  checksRun += 1;
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    findings.push(`${name}: ${detail}`);
    console.log(`FAIL ${name} — ${detail}`);
  }
};

/** Pull `**N commits**` and similar from the plan's standings table. */
const standingsSection = plan.slice(plan.indexOf('## FINAL STANDINGS'));
const num = (label) => {
  const m = new RegExp(`${label}[^0-9]{0,24}([0-9]+)`).exec(standingsSection);
  return m === null ? null : Number(m[1]);
};

/**
 * THE COMMIT COUNT IS CHECKED FOR ABSENCE, NOT FOR A VALUE — deliberately.
 *
 * A committed file cannot state its own repository's commit count correctly: writing the number is
 * itself a commit, so the document is one behind the moment it is saved. MEASURED here: the standings
 * said 68 while the branch had 69, purely because the commit that fixed the previous drift had landed.
 *
 * So the rule is inverted: the number must NOT appear. A reader who wants it runs `git rev-list --count`.
 * This is the only check in this probe that asserts a document stays SILENT, and it does so because a
 * value there is guaranteed to be wrong rather than merely likely to drift.
 */
const standingsText = plan.slice(plan.indexOf('## FINAL STANDINGS'));
check(
  'FINAL STANDINGS does not state a commit count (it cannot be correct in a committed file)',
  !/\*\*[0-9]+ commits\*\*/.test(standingsText),
  'a commit count is stated; it will be stale by exactly one commit, because writing it commits',
);

const docFixtures = num('Corpus \\| \\*\\*');
check(
  'FINAL STANDINGS fixture count matches the fixtures directory',
  docFixtures === actual.fixtures,
  `documents say ${String(docFixtures)}, repository has ${actual.fixtures}`,
);

// The trial breakdown, which the standings now states explicitly.
const docTrials = num('Trials \\| \\*\\*');
check(
  'FINAL STANDINGS trial count matches the results directory',
  docTrials === actual.v12Trials,
  `documents say ${String(docTrials)}, repository has ${actual.v12Trials}`,
);
const docClean = (() => {
  const m = /\*\*([0-9]+) in the CLEAN configuration\*\*/.exec(standingsSection);
  return m === null ? null : Number(m[1]);
})();
check(
  'FINAL STANDINGS clean-trial count matches the clean records',
  docClean === actual.cleanTrials,
  `documents say ${String(docClean)}, repository has ${actual.cleanTrials}`,
);

/*
 * The one NUMBER THAT MUST NOT DRIFT SILENTLY: the corpus must not be described as separating the
 * arms. Three documents state the negative in different words, and the check is deliberately loose
 * about phrasing and strict about the claim - if any of them starts asserting an advantage, this
 * fails and a human looks.
 */
for (const [file, text] of [['README.md', read('README.md')], ['CHANGELOG.md', read('CHANGELOG.md')], ['docs/V1.2-BENCHMARK.md', read('docs/V1.2-BENCHMARK.md')]]) {
  const assertsNegative = /no correctness advantage|did not demonstrate|never a saving/i.test(text);
  check(`${file} states the result as a negative`, assertsNegative, 'no negative result statement found — was a claim added?');
}

console.log('');

/*
 * EVERY FIXTURE MUST DECLARE ITS CONFIGURATION — the invariant open item 7 finished. `declaringConfig`
 * was already computed here and NEVER USED, so the one corpus fact that could silently go stale again
 * had no check behind it at all.
 */
check(
  'every fixture declares the configuration it is authored for',
  actual.declaringConfig === actual.fixtures,
  `${actual.fixtures - actual.declaringConfig} of ${actual.fixtures} fixture(s) declare no benchmarkConfig/benchmarkArm`,
);

/*
 * THE GOVERNING TOKEN NUMBER, pinned against the MISSTATEMENT rather than the word (audit entry 12):
 * Section 6 of the benchmark document — the section that disclaims token savings — quoted `+82.7%`,
 * the contaminated-corpus aggregate, as "the measured delta", while Section 2 says in as many words
 * that `+115.1%` governs. A check is cheaper than noticing it a third time.
 */
const deltaMisstated = (text) => /delta\s+is\s+\*{0,2}\+?82\.7%/.test(text);
check(
  'no release document presents the contaminated +82.7% aggregate as the measured delta',
  !deltaMisstated(read('docs/V1.2-BENCHMARK.md')) && !deltaMisstated(read('README.md')),
  'the contaminated-corpus aggregate is quoted as the headline; quote +115.1% and cite +82.7% only as the contaminated-corpus aggregate',
);

if (findings.length === 0) {
  console.log(`doc consistency: all ${checksRun} checks held (${actual.commits} commits, ${actual.v12Trials} v1.2 trials, ${actual.fixtures} fixtures)`);
  process.exit(0);
}
console.log(`doc consistency: ${findings.length} disagreement(s)`);
console.log('  These are DOCUMENT defects, not product defects. Fix the document, or fix this probe if its');
console.log('  source of truth is wrong - but do not leave the two disagreeing.');
process.exit(1);
