import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Recorder, roundEvidence, hasRunnerSummary, isInfraOutput } from '../src/index.js';
import { buildPipeline, machineRules, DEFAULT_RULE_NAMES } from '@canary-rn/normalizers';

const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);

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
      const expectedKeys = (process.platform === 'win32'
        ? ['ComSpec', 'HOME', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'windir']
        : ['HOME', 'LANG', 'PATH', 'TMPDIR']).sort();
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
      // sorted — order-independent profile comparison (audit F2)
      assert.deepEqual(r.fact.failingTestNames, ['alpha works', 'beta works']);
      const ev = roundEvidence(r, r.fact);
      assert.equal(ev.reportedFailing, 2);
      assert.deepEqual(ev.failingTestNames, ['alpha works', 'beta works']);
      assert.equal(ev.infraSignal, false);
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
