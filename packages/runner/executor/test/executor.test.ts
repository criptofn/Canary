import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Recorder, roundEvidence, hasRunnerSummary, isInfraOutput } from '../src/index.js';
import { sanitizedEnv, sanitizedEnvKeys } from '@canary-rn/support';
import { classify, type RoundFact } from '@canary-rn/classification';
import { buildPipeline, machineRules, DEFAULT_RULE_NAMES } from '@canary-rn/normalizers';

const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);

const armBase = (round = 1): RoundFact => ({
  arm: 'baseline', round, exitCode: 0, hasRunnerSummary: true, infraSignal: false, reportedPassing: 5,
});
const armCandidatePass = (round = 1): RoundFact => ({
  arm: 'candidate', round, exitCode: 0, hasRunnerSummary: true, infraSignal: false, reportedPassing: 5,
});

function freshRecorder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-exec-'));
  const ws = { root, fixture: path.join(root, 'fixture') };
  fs.mkdirSync(ws.fixture, { recursive: true });
  fs.writeFileSync(path.join(root, 'empty.npmrc'), '');
  const art = path.join(root, 'artifacts');
  fs.mkdirSync(art, { recursive: true });
  const pipeline = buildPipeline(DEFAULT_RULE_NAMES, machineRules({
    tempDir: os.tmpdir(), homeDir: ws.root, user: '', host: '', workspaceRoot: root,
  }));
  return {
    ws, art,
    rec: new Recorder({ ws, nodeDir: NODE_DIR, npmCli: path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js'), artifactsDir: art, pipeline }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('Recorder.expandArgv — token expansion + enforced isolation', () => {
  it('expands $bin via resolver to node + bin path', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const out = rec.expandArgv(['$bin:mocha'], { dep: 'axios', baseline: 'b', candidate: 'c' }, () => 'M:\\m.js');
      assert.deepEqual(out, [process.execPath, 'M:\\m.js']);
    } finally { cleanup(); }
  });

  it('ALWAYS appends --ignore-scripts and cache isolation to install commands', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const out = rec.expandArgv(
        ['$npm', 'install', 'axios@{candidate}'],
        { dep: 'axios', baseline: 'b', candidate: '1.0.0' },
        () => 'unused',
      );
      assert.ok(out.includes('--ignore-scripts'), out.join(' '));
      assert.ok(out.includes('--legacy-peer-deps'));
      assert.ok(out.some((a) => a.includes('npm-cache')));
      assert.ok(out.some((a) => a.includes('empty.npmrc')));
      assert.ok(out.includes('axios@1.0.0'));
    } finally { cleanup(); }
  });

  it('F6: flags are detected past leading options ($npm --loglevel install)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const out = rec.expandArgv(
        ['$npm', '--loglevel=silent', 'install', 'x@1'],
        { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused');
      assert.ok(out.includes('--ignore-scripts'), out.join(' '));
      assert.ok(out.some((a) => a.includes('npm-cache')));
    } finally { cleanup(); }
  });

  it('F6: npm ci (runs lifecycle scripts by default) is also covered', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const out = rec.expandArgv(['$npm', 'ci'], { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused');
      assert.ok(out.includes('--ignore-scripts'));
    } finally { cleanup(); }
  });

  it('F6: $yarn install gets yarn-appropriate flags after -- and --ignore-scripts on the npx bootstrap', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const out = rec.expandArgv(['$yarn', 'install', '--frozen-lockfile'],
        { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused');
      assert.ok(out.includes('--ignore-scripts'));
      assert.ok(out.some((a) => a.includes('yarn-cache')));
      assert.ok(!out.includes('--legacy-peer-deps'), 'npm-only flags must not be handed to yarn');
      assert.ok(!out.includes('--userconfig'));
      // npx bootstrap itself must not run scripts: --ignore-scripts precedes '--'
      const dashdash = out.indexOf('--');
      assert.ok(dashdash > 0 && out.slice(0, dashdash).includes('--ignore-scripts'));
    } finally { cleanup(); }
  });

  // ---- audit F8: value-taking options before the subcommand used to shift
  // detection and SILENTLY skip all isolation flags. Now: hard rejection. ----
  it('F8: $npm -u evil.npmrc install x is REJECTED (was silent injection-skip)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      assert.throws(
        () => rec.expandArgv(['$npm', '-u', 'evil.npmrc', 'install', 'x'],
          { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused'),
        /short option/,
      );
    } finally { cleanup(); }
  });

  it('F8: conflicting config flags rejected BEFORE and AFTER the subcommand', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const cmd of [
        ['$npm', '--userconfig', 'evil.npmrc', 'install', 'x'],
        ['$npm', '--userconfig=evil.npmrc', 'install', 'x'],
        ['$npm', 'install', '--prefix=/tmp/evil', 'x'],
        ['$npm', 'install', 'x', '--registry=http://evil.example'],
        ['$npm', 'install', 'x', '--cache=/tmp/evil'],
        ['$npm', 'install', '--script-shell', 'bash', 'x'],
      ]) {
        assert.throws(
          () => rec.expandArgv(cmd, { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused'),
          /isolation-conflicting/,
          `must reject: ${cmd.join(' ')}`,
        );
      }
    } finally { cleanup(); }
  });

  it('F8: unknown bare option before subcommand rejected; --key=value passes', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      assert.throws(
        () => rec.expandArgv(['$npm', '--whatever', 'install', 'x'],
          { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused'),
        /cannot be verified valueless/,
      );
      // the exact shape the F6 test used (self-describing form) must still work
      const out = rec.expandArgv(['$npm', '--loglevel=silent', 'install', 'x@1'],
        { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused');
      assert.ok(out.includes('--ignore-scripts'));
    } finally { cleanup(); }
  });

  it('F8: exec/dlx/shell-style subcommands rejected; run of a local script is not', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const sub of ['exec', 'x', 'dlx', 'shell', 'explore']) {
        assert.throws(
          () => rec.expandArgv(['$npm', sub, 'evil-pkg'],
            { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused'),
          /not allowed/,
          `must forbid: npm ${sub}`,
        );
      }
      const out = rec.expandArgv(['$npm', 'run', 'test'],
        { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused');
      assert.ok(!out.includes('--ignore-scripts'), 'run-script is not install-family');
    } finally { cleanup(); }
  });

  it('F8: conflicting flags rejected in CASE VARIANTS too (red-team)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const cmd of [
        ['$npm', '--Userconfig=evil.npmrc', 'install', 'x'],
        ['$npm', 'install', '--PREFIX=/tmp/evil', 'x'],
        ['$npm', '--RegiSTry=http://evil', 'install', 'x'],
      ]) {
        assert.throws(
          () => rec.expandArgv(cmd, { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused'),
          /isolation-conflicting/, `case variant slipped: ${cmd.join(' ')}`,
        );
      }
    } finally { cleanup(); }
  });

  it('F8: install-family options with = or after the subcommand still expand normally', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const out = rec.expandArgv(['$npm', 'install', '--before=2022-10-04T00:00:00Z'],
        { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'unused');
      assert.ok(out.includes('--before=2022-10-04T00:00:00Z'));
      assert.ok(out.includes('--ignore-scripts'));
      assert.ok(out.includes('--userconfig'));
    } finally { cleanup(); }
  });

  it('non-install commands get no injected flags', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const out = rec.expandArgv(['$bin:mocha'], { dep: 'x', baseline: 'b', candidate: 'c' }, () => 'M:\\m.js');
      assert.ok(!out.includes('--ignore-scripts'));
    } finally { cleanup(); }
  });
});

describe('summary/infra matchers (F1/F5 hardening)', () => {
  it('strict summary matcher rejects prose and accepts runner lines', () => {
    assert.ok(hasRunnerSummary('  128 passing (119ms)\n  3 failing'));
    assert.ok(hasRunnerSummary('18 tests passed'));
    assert.ok(!hasRunnerSummary('Assertion failed: 2 failed checks'), 'prose must not count');
    assert.ok(!hasRunnerSummary('reference error blah'));
  });
  it('environmental error patterns are infra (F1/F2)', () => {
    assert.ok(isInfraOutput('Error: listen EADDRINUSE: address already in use 127.0.0.1:3000'));
    assert.ok(isInfraOutput('npm ERR! code ERESOLVE'));
    assert.ok(isInfraOutput("Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'"));
    assert.ok(!isInfraOutput('  1 failing\n  127 passing (90ms)\n     Error: expected 200 got 404'));
  });

  it('audit B2: errno code in a PASSING test name is NOT infra; in an error line IS', () => {
    // benign: a test titled after a network code, running green
    assert.ok(!isInfraOutput(
      '  √ retries after ECONNREFUSED and succeeds\n  1 passing (5ms)'),
    'benign prose must not be false-infrastructure');
    assert.ok(!isInfraOutput('  42 passing\n  note: EACCES handling covered above\n'));
    // hostile-but-real: an actual error line carrying the code
    assert.ok(isInfraOutput('  1 passing\nError: connect ECONNREFUSED 127.0.0.1:54321'));
    assert.ok(isInfraOutput('npm error code EACCES'));
  });
});

describe('Recorder.step/round — real subprocess, real artifacts (no mocks)', () => {
  it('captures exit code, streams, hashes, counts; unique-ifies repeated labels', async () => {
    const { rec, art, cleanup, ws } = freshRecorder();
    try {
      const r1 = await rec.round('baseline', 1, [NODE, '-e', 'console.log("3 tests passed")'], 30);
      assert.equal(r1.fact.exitCode, 0);
      assert.ok(r1.fact.hasRunnerSummary);
      assert.ok(!r1.fact.infraSignal);
      assert.equal(r1.fact.reportedFailing, undefined);
      assert.ok(fs.existsSync(path.join(art, 'baseline-1.stdout.log')));
      const ev = roundEvidence(r1, r1.fact);
      assert.match(ev.rawStdoutSha256, /^[0-9a-f]{64}$/);
      // Single source of truth (audit F6): the keys runCommand reports must be
      // exactly the ones sanitizedEnv declares on THIS platform — the child-env
      // observation test in packages/support proves observed == declared.
      const expectedKeys = sanitizedEnvKeys(sanitizedEnv({ ws, nodeDir: NODE_DIR }));
      assert.deepEqual([...r1.run.envKeys].sort(), expectedKeys);
      void ws;
    } finally { cleanup(); }
  });

  it('F1 shape: nonzero exit + summary claiming 0 failing is recorded with the count', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const r = await rec.round('candidate', 1, [NODE, '-e',
        'console.log("1 passing (2ms)");console.log("0 failing");process.exit(7)'], 30);
      assert.equal(r.fact.exitCode, 7);
      assert.equal(r.fact.reportedFailing, 0);
      assert.ok(r.fact.hasRunnerSummary);
    } finally { cleanup(); }
  });

  it('F5 shape: exit 0 while summary reports failures is captured (classifier then infra-guards)', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const r = await rec.round('candidate', 1, [NODE, '-e',
        'console.log("10 passing");console.log("2 failing")'], 30);
      assert.equal(r.fact.exitCode, 0);
      assert.equal(r.fact.reportedFailing, 2);
    } finally { cleanup(); }
  });

  it('audit F13: failing-test identities from REAL subprocess output land in fact and evidence', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const r = await rec.round('candidate', 1, [NODE, '-e', [
        'console.log("  125 passing (119ms)");',
        'console.log("  2 failing");',
        'console.log("  1) Suite B");',
        'console.log("     beta works:");',
        'console.log("  2) Suite A");',
        'console.log("     alpha works:");',
      ].join('')], 30);
      assert.equal(r.fact.reportedFailing, 2);
      // canonical suite-qualified identities (audit B1), sorted for
      // order-independent profile comparison (audit F2)
      assert.deepEqual(r.fact.failingTestNames, ['Suite A > alpha works', 'Suite B > beta works']);
      const ev = roundEvidence(r, r.fact);
      assert.equal(ev.reportedFailing, 2);
      assert.deepEqual(ev.failingTestNames, ['Suite A > alpha works', 'Suite B > beta works']);
      assert.equal(ev.infraSignal, false);
    } finally { cleanup(); }
  });

  it('audit B2 (real subprocess): 0 passing at exit 0 records reportedPassing=0 (classifier => INFRA)', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const r = await rec.round('baseline', 1, [NODE, '-e',
        'console.log("  0 passing (1ms)")'], 30);
      assert.equal(r.fact.exitCode, 0);
      assert.equal(r.fact.hasRunnerSummary, true);
      assert.equal(r.fact.reportedPassing, 0);
      assert.equal(r.fact.infraSignal, false);
      const cls = classify([r.fact, { ...r.fact, round: 2 }, armCandidatePass(1), armCandidatePass(2)]);
      assert.equal(cls.classification, 'INFRASTRUCTURE_FAILURE');
      assert.equal(cls.rule, 1);
      assert.match(cls.reason, /zero executed tests/);
    } finally { cleanup(); }
  });

  it('audit B2 (real subprocess): ECONNREFUSED error line at exit 0 sets infraSignal true (not swallowed by exit)', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const r = await rec.round('candidate', 1, [NODE, '-e',
        'console.log("  3 passing (1ms)"); console.error("Error: connect ECONNREFUSED 127.0.0.1:54321");'], 30);
      assert.equal(r.fact.exitCode, 0);
      assert.equal(r.fact.infraSignal, true, 'infra must be recognized at exit 0');
      assert.equal(r.fact.reportedPassing, 3);
      const cls = classify([armBase(), armBase(2), { ...r.fact }, { ...r.fact, round: 2 }]);
      assert.equal(cls.classification, 'INFRASTRUCTURE_FAILURE');
    } finally { cleanup(); }
  });

  it('audit B2 (real subprocess): a genuinely passing run records reportedPassing>0 and stays valid', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const r = await rec.round('baseline', 1, [NODE, '-e',
        'console.log("  5 passing (1ms)")'], 30);
      assert.equal(r.fact.reportedPassing, 5);
      assert.equal(r.fact.infraSignal, false);
      const ev = roundEvidence(r, r.fact);
      assert.equal(ev.reportedPassing, 5);
    } finally { cleanup(); }
  });

  it('audit B1 e2e: same leaf title, different SUITE across candidate rounds -> FLAKY', async () => {    const { rec, cleanup } = freshRecorder();
    try {
      const failLog = (suite: string): string => [
        'console.log("  10 passing (1ms)");',
        'console.log("  1 failing");',
        `console.log("  1) ${suite}");`,
        'console.log("       handles baseURL correctly:");',
        'console.log("     TypeError: nope");',
        'process.exit(1);',
      ].join('');
      const rA = await rec.round('candidate', 1, [NODE, '-e', failLog('passThrough tests (requires Node)')], 30);
      const rB = await rec.round('candidate', 2, [NODE, '-e', failLog('onNoMatch=passthrough option tests (requires Node)')], 30);
      // distinct canonical identities despite identical leaf titles
      assert.notDeepEqual(rA.fact.failingTestNames, rB.fact.failingTestNames);
      // ...and classification sees the divergence: never CONFIRMED_REGRESSION
      const facts = [
        armBase(), rA.fact, rB.fact,
      ];
      const cls = classify(facts);
      assert.equal(cls.classification, 'FLAKY');
      assert.equal(cls.rule, 8);
    } finally { cleanup(); }
  });

  it('audit B1 e2e: identical SUITE-QUALIFIED identity across rounds stays CONFIRM-eligible', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const failLog = [
        'console.log("  10 passing (1ms)");',
        'console.log("  1 failing");',
        'console.log("  1) passThrough tests (requires Node)");',
        'console.log("       handles baseURL correctly:");',
        'process.exit(1);',
      ].join('');
      const rA = await rec.round('candidate', 1, [NODE, '-e', failLog], 30);
      const rB = await rec.round('candidate', 2, [NODE, '-e', failLog], 30);
      assert.deepEqual(rA.fact.failingTestNames, rB.fact.failingTestNames);
      const cls = classify([armBase(), rA.fact, rB.fact]);
      assert.equal(cls.classification, 'CONFIRMED_REGRESSION');
      assert.equal(cls.rule, 5);
    } finally { cleanup(); }
  });

  it('timeout kills produce exit -1 (and tree-kill runs without throwing)', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const r = await rec.round('candidate', 1, [NODE, '-e', 'setTimeout(()=>{},30000)'], 1);
      assert.equal(r.fact.exitCode, -1);
      assert.ok(r.run.killedByTimeout);
    } finally { cleanup(); }
  });
});
