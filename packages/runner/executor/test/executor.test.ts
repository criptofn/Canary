import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Recorder, roundEvidence, hasRunnerSummary, isInfraOutput, hasCrashSignature, pmArgvPolicy, assertCanonicalPmForm, assertSupportedSpecExecutable, NPM_REGISTRY_PIN, SPEC_LITERAL_EXECUTABLES } from '../src/index.js';
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

function freshRecorder(run?: (o: import('@canary-rn/support').RunOptions) => Promise<import('@canary-rn/support').RunOutcome>) {
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
    rec: new Recorder({ ws, nodeDir: NODE_DIR, npmCli: path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js'), artifactsDir: art, pipeline, ...(run ? { run } : {}) }),
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

describe('audit B5 — canonical package-manager policy (closed allowlist)', () => {
  const subs = { dep: 'x', baseline: '1', candidate: '2' };
  const npmFlags = ['--ignore-scripts', '--userconfig', '--cache', '--registry'];

  it('B5: install ALIASES (the pre-fix silent-skip) now receive full injection', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const alias of ['install', 'i', 'ii', 'ins', 'add', 'ci', 'cit', 'clean-install', 'update', 'up', 'dedupe', 'install-test', 'it']) {
        const out = rec.expandArgv(['$npm', alias, 'some-pkg@1'], subs, () => 'unused');
        for (const f of npmFlags) assert.ok(out.includes(f), `${alias} missing ${f}: ${out.join(' ')}`);
        assert.ok(out.includes(NPM_REGISTRY_PIN), `${alias} did not pin registry`);
      }
    } finally { cleanup(); }
  });

  it('B5: unknown/unvetted subcommands are REJECTED, not run without policy', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const bad of ['exec', 'x', 'dlx', 'shell', 'explore', 'publish', 'link', 'rebuild', 'isnt', 'instal', 'run2']) {
        assert.throws(
          () => rec.expandArgv(['$npm', bad, 'pkg'], subs, () => 'unused'),
          /not allowed/, `must reject: npm ${bad}`,
        );
      }
    } finally { cleanup(); }
  });

  it('B5: RAW package-manager forms rejected for ANY command position', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const npmCli = path.join(NODE, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      for (const cmd of [
        ['npm', 'install', 'evil'], ['npm.cmd', 'i', 'evil'], ['NPM', 'add', 'evil'],
        ['npx', 'evil'], ['yarn', 'add', 'evil'], ['yarnpkg', 'install'],
        ['node', npmCli, 'install', 'evil'], ['node', 'npm-cli.js', 'add', 'evil'],
      ]) {
        assert.throws(
          () => rec.expandArgv(cmd, subs, () => 'unused'),
          /raw|package.manager|isolation policy/i, `must reject raw form: ${cmd.join(' ')}`,
        );
      }
    } finally { cleanup(); }
  });

  it('B5: $bin:npm bypass is rejected; $bin:mocha still works', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      assert.throws(() => rec.expandArgv(['$bin:npm', 'install', 'evil'], subs, () => 'unused'),
        /raw-package-manager|bypass/i);
      assert.throws(() => rec.expandArgv(['$bin:yarn', 'add', 'evil'], subs, () => 'unused'),
        /bypass|raw/i);
      const ok = rec.expandArgv(['$bin:mocha'], subs, () => 'M:\\m.js');
      assert.deepEqual(ok, [process.execPath, 'M:\\m.js']);
    } finally { cleanup(); }
  });

  it('B5: user `--` in an install command is rejected (was the trailing-flag dead-weight bypass)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      assert.throws(() => rec.expandArgv(['$npm', 'install', 'pkg', '--', 'x'], subs, () => 'unused'),
        /not allowed for install-family|--/);
      assert.throws(() => rec.expandArgv(['$npm', 'add', '--', 'pkg'], subs, () => 'unused'),
        /install-family|--/);
      // script family may use `--` passthrough and is NOT injected
      const out = rec.expandArgv(['$npm', 'run', 'test', '--', 'foo'], subs, () => 'unused');
      assert.ok(!out.includes('--ignore-scripts'), 'run-script must not get install flags');
    } finally { cleanup(); }
  });

  it('B5 invariant (property): accepted install => isolation flags in EFFECTIVE position after the subcommand, none after a `--`', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      const shapes: string[][] = [
        ['$npm', 'install', 'pkg'],
        ['$npm', 'i', '--no-save', 'pkg'],
        ['$npm', 'ci'],
        ['$npm', '--loglevel=silent', 'install', 'pkg'],
        ['$npm', 'add', 'pkg', '@1.2.3'],
        ['$npm', 'INSTALL', 'pkg'],
      ];
      for (const cmd of shapes) {
        const out = rec.expandArgv(cmd, subs, () => 'unused');
        const subIdx = out.findIndex((x) => ['install', 'i', 'ci', 'add', 'INSTALL'].includes(x));
        assert.ok(subIdx > 0, `no subcommand in ${out.join(' ')}`);
        const dash = out.indexOf('--', subIdx);
        for (const f of npmFlags) {
          const fi = out.indexOf(f);
          assert.ok(fi > subIdx, `${f} not after subcommand: ${out.join(' ')}`);
          assert.ok(dash === -1 || fi < dash, `${f} landed after '--' (dead position): ${out.join(' ')}`);
        }
        assert.ok(out.includes(NPM_REGISTRY_PIN));
      }
    } finally { cleanup(); }
  });

  it('B5: closed-allowlist families classified correctly by the policy parser', () => {
    assert.equal(pmArgvPolicy(['$npm', 'install', 'x']).family, 'install');
    assert.equal(pmArgvPolicy(['$npm', 'run', 'test']).family, 'script');
    assert.equal(pmArgvPolicy(['$npm', 'ls', '--json']).family, 'info');
    assert.equal(pmArgvPolicy(['$yarn', 'add', 'x']).family, 'install');
    assert.throws(() => pmArgvPolicy(['$npm', 'nope']), /not allowed/);
    assert.throws(() => assertCanonicalPmForm(['npm', 'i']), /raw/i);
  });
});

// ---------------------------------------------------------------------------
// Round-3 blocker 5 — WRAPPER-MEDIATED & FRONTEND package-manager bypass.
// The pre-fix posture inspected only the FIRST executable basename, so a
// command that merely RUNS npm through a shell/wrapper (`cmd /c npm`,
// `powershell … npm`, `env npm`, `sh -c "npm"`) or through an alternative
// frontend (pnpm/bun/corepack) slipped past the raw-pm check AND the
// $npm/$yarn policy branch — expanded verbatim and executed with NO isolation
// flags. The fix is a small explicit allowlist for literal spec executables
// (only `node`, plus the $tokens), fail-closed for everything else.
// ---------------------------------------------------------------------------
describe('round-3 B5 — wrapper-mediated / frontend package-manager execution is refused', () => {
  const subs = { dep: 'x', baseline: '1', candidate: '2' };
  // Returns the CanaryError reasonCode, or null if the command expands clean.
  function reasonOf(rec: Recorder, cmd: string[]): string | null {
    try { rec.expandArgv(cmd, subs, () => 'unused'); return null; }
    catch (e) { return (e as { reasonCode?: string }).reasonCode ?? 'threw-without-code'; }
  }

  it('cmd /c npm install … is refused (the canonical Windows wrapper bypass)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const cmd of [
        ['cmd', '/c', 'npm', 'install', 'evil'],
        ['cmd.exe', '/C', 'npm', 'i', 'evil'],
        ['C:\\Windows\\System32\\cmd.exe', '/c', 'npm', 'add', 'evil'],
      ]) {
        assert.equal(reasonOf(rec, cmd), 'wrapper-mediated-package-manager', `must refuse: ${cmd.join(' ')}`);
      }
    } finally { cleanup(); }
  });

  it('powershell / pwsh … npm is refused', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const cmd of [
        ['powershell', '-Command', 'npm install evil'],
        ['powershell.exe', '-c', 'npm', 'i'],
        ['pwsh', '-Command', 'yarn add evil'],
      ]) {
        assert.equal(reasonOf(rec, cmd), 'wrapper-mediated-package-manager', `must refuse: ${cmd.join(' ')}`);
      }
    } finally { cleanup(); }
  });

  it('env / nohup / xargs / sh -c / sudo npm are refused (POSIX wrappers)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const cmd of [
        ['env', 'npm', 'install', 'evil'],
        ['nohup', 'npm', 'i'],
        ['xargs', 'npm', 'install'],
        ['sh', '-c', 'npm install evil'],
        ['bash', '-lc', 'yarn add evil'],
        ['sudo', 'npm', 'install', '-g', 'evil'],
        ['timeout', '10', 'npm', 'ci'],
      ]) {
        assert.equal(reasonOf(rec, cmd), 'wrapper-mediated-package-manager', `must refuse: ${cmd.join(' ')}`);
      }
    } finally { cleanup(); }
  });

  it('package-manager FRONTENDS (pnpm/bun/corepack/volta) are refused', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const cmd of [
        ['pnpm', 'install'], ['pnpm', 'add', 'evil'],
        ['bun', 'install'], ['bunx', 'evil'],
        ['corepack', 'yarn', 'install'], ['volta', 'run', 'npm', 'i'],
      ]) {
        assert.equal(reasonOf(rec, cmd), 'package-manager-frontend', `must refuse frontend: ${cmd.join(' ')}`);
      }
    } finally { cleanup(); }
  });

  it('node executed ON a package-manager file (node npm / node npm-cli.js) is refused', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      // `node npm install` — runs whatever ./npm is in the fixture cwd.
      assert.equal(reasonOf(rec, ['node', 'npm', 'install', 'evil']), 'wrapper-mediated-package-manager');
      // `node <abs>/npm-cli.js` is caught EARLIER by B5.1's node+npm-cli rule —
      // the argument scan stands behind it (defense in depth, not in place of).
      assert.equal(reasonOf(rec, ['node', './node_modules/npm/bin/npm-cli.js', 'i']), 'raw-package-manager');
      // a NON-pm script argument is the supported direct-node form and must stand
      assert.equal(reasonOf(rec, ['node', 'compare.js', 'npm-vs-yarn-report']), null,
        'node <script> must not be over-rejected on benign argument text');
    } finally { cleanup(); }
  });

  it('any other unenumerated literal executable fails closed (not silently expanded)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      for (const cmd of [
        ['python', '-m', 'http.server'], ['ruby', 'setup.rb'],
        ['make', 'install'], ['/opt/evil/tool'],
        ['git', 'clone', 'https://evil/repo'],
      ]) {
        assert.equal(reasonOf(rec, cmd), 'spec-executable-not-allowlisted', `must fail closed: ${cmd.join(' ')}`);
      }
    } finally { cleanup(); }
  });

  it('REGRESSION: every SUPPORTED form still expands (allowlist does not over-reject)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      // canonical $npm/$yarn install keeps full injection
      const npmOut = rec.expandArgv(['$npm', 'install', 'x@1'], subs, () => 'unused');
      assert.ok(npmOut.includes('--ignore-scripts'), npmOut.join(' '));
      const yarnOut = rec.expandArgv(['$yarn', 'install', '--frozen-lockfile'], subs, () => 'unused');
      assert.ok(yarnOut.includes('--ignore-scripts'), yarnOut.join(' '));
      // $bin: and $tsc still expand
      assert.deepEqual(rec.expandArgv(['$bin:mocha'], subs, () => 'M:\\m.js'), [process.execPath, 'M:\\m.js']);
      // direct supported node forms (the offline fixtures' real commands) stand
      assert.deepEqual(rec.expandArgv(['node', '-e', "''"], subs, () => 'unused'), ['node', '-e', "''"]);
      assert.equal(reasonOf(rec, ['node', 'test.js']), null);
      assert.equal(reasonOf(rec, ['node', 'swap.js', '{candidate}']), null);
    } finally { cleanup(); }
  });

  it('REGRESSION: raw npm / npm.cmd / direct npm-cli / $bin:npm still rejected (pre-existing B5.1)', () => {
    const { rec, cleanup } = freshRecorder();
    try {
      // These are caught by the EARLIER assertCanonicalPmForm, so their code is
      // 'raw-package-manager' — proving the allowlist layers behind, not instead of, B5.1.
      for (const cmd of [['npm', 'i'], ['npm.cmd', 'install'], ['yarn', 'add']]) {
        assert.equal(reasonOf(rec, cmd), 'raw-package-manager', `must stay raw-rejected: ${cmd.join(' ')}`);
      }
      assert.equal(reasonOf(rec, ['$bin:npm', 'install']), 'raw-package-manager');
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Round-3 secondary — fatal-crash + containment-sweep signals are PRODUCED,
// recorded, and consumed by the decision table (not silently dropped).
// ---------------------------------------------------------------------------
describe('round-3 secondary — crash & sweep signals reach the classification', () => {
  it('hasCrashSignature: matches V8/native abort phrasing, skips pass-glyph lines', () => {
    assert.ok(hasCrashSignature('FATAL ERROR: Ineffective mark-compacts near heap limit'));
    assert.ok(hasCrashSignature('...ran out\nJavaScript heap out of memory\n'));
    assert.ok(hasCrashSignature('bash: node[123]: Segmentation fault (core dumped)'));
    assert.ok(hasCrashSignature('libc abort(): assertion failed\nAborted (core dumped)'), 'the shell abort banner carries core dumped');
    assert.ok(hasCrashSignature('received signal SIGSEGV'));
    // a passing test that merely QUOTES crash prose is not a crash:
    assert.ok(!hasCrashSignature('  √ handles the "FATAL ERROR: heap" message gracefully\n  1 passing'));
    // THE PROSE TRAP: lowercase "aborted"/"out of memory" are ordinary test
    // subjects (axios cancel suite is literally named around abort) — never a crash:
    assert.ok(!hasCrashSignature('  1 failing\n  1) cancels an aborted request\n     Error: socket hang up'),
      'a test titled about an aborted request must not false-crash the round');
    assert.ok(!hasCrashSignature('  √ recovers when the cache runs out of memory\n  3 passing'));
    assert.ok(!hasCrashSignature('  2 passing\n  note: out of memory path covered\n'), 'bare "out of memory" prose is not a crash banner');
    // Self-review N6: the V8 native CHECK-failure banner ('# Fatal error in …'
    // — printed by non-OOM aborts and SIGILL-class crashes) matched NOTHING in
    // the original set, so a post-summary native abort could pose as an
    // ordinary failing round. It must fire now — and the anchored form must
    // NOT false-fire on lookalike prose.
    assert.ok(hasCrashSignature('  1 failing\n  1) suite > test:\n     AssertionError\n\n# Fatal error in , line 0\n# Check failed: result.\n'),
      'V8 CHECK-failure banner after a valid summary is a crash (N6)');
    assert.ok(hasCrashSignature('#  Fatal error in, line 0'), 'the comma-form of the banner fires too');
    assert.ok(!hasCrashSignature('# Fatal error info: see docs for handling crashes'),
      'anchored banner must not false-fire on "# Fatal error info" prose');
    assert.ok(!hasCrashSignature('log("fatal error in the plugin")'), 'lowercase prose stays prose');
  });

  it('glyph discrimination (self-review N4): ava ✖ (U+2716) fires infra; ✗-titled (U+2717) prose does not', () => {
    // ✖ HEAVY BALLOT X is what ava prints for real infra errors — SOFT
    // matching must fire there. ✗ BALLOT X marks a FAILING TEST whose title
    // is prose — SOFT must NOT fire on it. The two glyphs are one codepoint
    // apart; this test pins the boundary the comment used to misdescribe.
    assert.ok(isInfraOutput('✖ connect ECONNREFUSED ::1:3000 errno: -4077\n'), 'ava ✖ infra line must fire');
    assert.ok(!isInfraOutput('  ✗ handles connect ECONNREFUSED error gracefully\n'), '✗ failure-title prose must not fire');
    assert.ok(!isInfraOutput('  √ prints "FATAL ERROR: heap" without crashing\n'), '√ passing prose must not fire');
  });

  it('isInfraOutput: a hard infra phrase inside a PASSING test title is not false-INFRA (round-3 secondary)', () => {
    // mocha prints the passing title; the phrase 'Cannot find module' is the
    // test's subject, not the harness's complaint.
    assert.ok(!isInfraOutput('  √ wraps Cannot find module for missing peer\n  1 passing (4ms)'));
    assert.ok(!isInfraOutput('  ✓ the ERR_MODULE_NOT_FOUND path is exercised\n  2 passing'));
    // the same phrase on a real error line still fires:
    assert.ok(isInfraOutput("  1) a test\n     Error: Cannot find module 'x'\n  1 failing"));
  });

  it('round() records crashSignal from a real post-summary crash -> classify says INFRA rule 1', async () => {
    const { rec, cleanup } = freshRecorder();
    try {
      // A summary that looks clean, THEN a heap-OOM abort on the same stream.
      const r = await rec.round('candidate', 1, [NODE, '-e',
        'console.log("  5 passing (3ms)");console.error("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");process.exit(0);'], 30);
      assert.equal(r.fact.reportedPassing, 5);
      assert.equal(r.fact.hasRunnerSummary, true, 'the summary is present…');
      assert.equal(r.fact.crashSignal, true, '…but the crash is captured');
      const cls = classify([armBase(), armBase(2), r.fact, { ...r.fact, round: 2 }]);
      assert.equal(cls.classification, 'INFRASTRUCTURE_FAILURE');
      assert.equal(cls.rule, 1);
      assert.match(cls.reason, /fatal runtime crash/);
      // evidence carries it so a downstream verifier can re-check the bytes:
      assert.equal(roundEvidence(r, r.fact).crashSignal, true);
    } finally { cleanup(); }
  });

  it('round() records sweepFailed (when the run outcome flags it) -> classify says INFRA rule 1', async () => {
    // Inject a run whose post-exit sweep could not confirm zero survivors.
    const fake = async () => ({
      exitCode: 0, killedByTimeout: false, stdout: '  5 passing (1ms)\n', stderr: '',
      durationMs: 5, argv: [NODE], envKeys: [], sweptPids: [1], sweepFailed: true,
    });
    const { rec, cleanup } = freshRecorder(fake);
    try {
      const r = await rec.round('candidate', 1, [NODE, '-e', ''], 30);
      assert.equal(r.fact.sweepFailed, true);
      assert.equal(roundEvidence(r, r.fact).sweepFailed, true);
      const cls = classify([armBase(), armBase(2), r.fact, { ...r.fact, round: 2 }]);
      assert.equal(cls.classification, 'INFRASTRUCTURE_FAILURE');
      assert.match(cls.reason, /containment sweep/);
    } finally { cleanup(); }
  });

  it('assertSupportedSpecExecutable: the allowlist is small and explicit', () => {
    assert.deepEqual([...SPEC_LITERAL_EXECUTABLES].sort(), ['node', 'node.exe']);
    assert.doesNotThrow(() => assertSupportedSpecExecutable(['node', 'x.js']));
    assert.doesNotThrow(() => assertSupportedSpecExecutable(['$npm', 'install']), 'token forms bypass the literal check');
    assert.throws(() => assertSupportedSpecExecutable(['cmd', '/c', 'npm', 'i']), /wrapper|interpreter/i);
  });
});
