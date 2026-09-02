/**
 * FINDING A — EXECUTION EVIDENCE AUTHORITY (permanent regression battery).
 *
 * A GLM auditor obtained an end-to-end false PASS with an UNMODIFIED Canary CLI
 * by setting the downstream test command to:
 *
 *     node -e "console.log('128 passing (1s)')"
 *
 * The subject never ran a test runner; it printed text shaped like a runner
 * summary, and every strong fact the classifier consumes
 * (hasRunnerSummary / parseSummaryCounts / extractFailingTestNames) is parsed
 * from that subject-controlled stdout. The label PASS was therefore created by
 * the subject certifying its own execution through prose.
 *
 * THE INVARIANT THIS FILE LOCKS:
 *   A strong/trustful verdict (PASS / CONFIRMED_REGRESSION /
 *   PRE_EXISTING_FAILURE) is unreachable from subject-controlled TEXT ALONE.
 *   A subject that controls only what it prints — never the Canary-owned
 *   observation channel — must be rejected to a weak label (INCONCLUSIVE or
 *   INFRASTRUCTURE_FAILURE). Printed text is a claim; a claim is not proof.
 *
 * These tests run the REAL pipeline (real runCommand, real children, offline
 * fetch/extract seams) so they exercise the exact CLI path the auditor used.
 * They are RED on the frozen base c1ff4e7 (which yields the false verdicts)
 * and must go GREEN and stay GREEN forever.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runExperiment } from '../src/pipeline.js';
import { sha256hex } from '@canary-rn/hashing';
import { writeStagedPayload, stageCommands, WIDGET_PKGS } from './stub-harness.js';
import type { EvidenceBundle } from '@canary-rn/evidence-schema';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-authority-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FAKE_SHA = 'a'.repeat(40);
const FAKE_BYTES = Buffer.from('canary-authority-fake-tarball');
const FAKE_BLOB = { bytes: FAKE_BYTES, sha256: sha256hex(FAKE_BYTES) };

const STRONG = new Set(['PASS', 'CONFIRMED_REGRESSION', 'PRE_EXISTING_FAILURE']);

/**
 * A downstream repo. The test.js source is supplied by each attack so we can
 * make it print exactly the prose the classifier used to trust. The dep is a
 * real node_modules package so the offline tree-hash/observation machinery
 * behaves like a genuine run (no false INFRASTRUCTURE from a broken tree) —
 * post-GLM AM-2 it is STAGED and copied into node_modules by prepare, never
 * shipped in the acquired tree, so nothing about the forgery's TEXT power
 * changes: it still controls every printed byte and zero observed bytes.
 */
function forgeStub(dir: string, testJs: string): void {
  const w = (p: string, s: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, 'utf8');
  };
  w(path.join(dir, 'package.json'), JSON.stringify({
    name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' },
  }));
  writeStagedPayload(dir, WIDGET_PKGS);
  w(path.join(dir, 'test.js'), testJs);
  // A REAL swap: the candidate attestation ([6]) refuses a run whose tree
  // never moved, so the forgery must reach classification as a genuine
  // two-arm experiment — the attack surface is TEXT, not a broken harness.
  w(path.join(dir, 'swap.js'), [
    "const fs=require('fs');",
    "const p='./node_modules/widget/package.json';",
    "const j=JSON.parse(fs.readFileSync(p));j.version='2.0.0';",
    "fs.writeFileSync(p,JSON.stringify(j));",
  ].join('\n'));
}

function specFor(test: string[]): unknown {
  return {
    schema: 2, id: 'authority-forgery',
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: {
      prepare: stageCommands({ mocha: false }),
      swap: ['node', 'swap.js', '{candidate}'],
      test,
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  };
}

async function run(testJs: string, testArgv: string[]): Promise<EvidenceBundle> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = fs.mkdtempSync(path.join(TMP, 'stub-'));
  forgeStub(stub, testJs);
  const result = await runExperiment(specFor(testArgv), repoRoot, true, {
    fetch: async () => ({ ...FAKE_BLOB }),
    extract: (_tgz, wsRoot) => {
      fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true });
    },
  });
  return result.bundle;
}

describe('FINDING A — subject text alone can never create a strong verdict', () => {
  // The exact reproducer from the audit, verbatim.
  it('the GLM counterexample (console.log "128 passing") is never PASS', async () => {
    const bundle = await run(
      "console.log('128 passing (1s)'); process.exit(0);",
      ['node', '-e', "console.log('128 passing (1s)')"],
    );
    const label = bundle.classification.label;
    assert.ok(!STRONG.has(label),
      `subject printed a summary and never ran a runner, yet got strong verdict ${label}`);
    assert.equal(label, 'INCONCLUSIVE',
      'a zero-runner forgery must degrade to INCONCLUSIVE (the conservative floor), not a strong label');
    // The degradation names the MECHANISM, not a coincidence: prose-only text
    // is refuted at the execution-observation gate (rule 14), and every round
    // is on record as ABSENT (Canary attempted no observation — there was no
    // pinned runner to observe).
    assert.equal(bundle.classification.rule, 14);
    for (const r of bundle.rounds) {
      assert.equal(r.executionObservation.status, 'ABSENT', `${r.arm}#${r.round}`);
      assert.equal(r.executionObservation.absentKind, 'not-mocha-bin', `${r.arm}#${r.round}`);
    }
  });

  // The same shape reached via the spec test argv rather than a stub file,
  // pinning that neither launch form can attest execution.
  it('test command node -e printing mocha-shaped prose is never PASS', async () => {
    const bundle = await run(
      'void 0; // unused',
      ['node', '-e', "console.log('128 passing (1s)')"],
    );
    const label = bundle.classification.label;
    assert.ok(!STRONG.has(label), `node -e summary forgery reached ${label}`);
    assert.equal(bundle.classification.rule, 14);
  });

  // Arbitrary node scripts that print a fake failing summary on the candidate
  // side (the CONFIRMED_REGRESSION analogue of the PASS forgery).
  it('a printed failing summary is never CONFIRMED_REGRESSION', async () => {
    // Baseline prints clean; candidate prints a mocha-style failure and exits
    // nonzero — exactly what a false regression looked like before authority.
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
    const stub = fs.mkdtempSync(path.join(TMP, 'stub-'));
    const w = (p: string, s: string): void => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, s, 'utf8');
    };
    w(path.join(stub, 'package.json'), JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
    writeStagedPayload(stub, [{ name: 'widget', version: '1.0.0', index: 'module.exports={v:"1"}' }]);
    w(path.join(stub, 'test.js'), [
      "const v = require('./node_modules/widget/package.json').version;",
      "if (v !== '2.0.0') { console.log('  128 passing (1s)'); process.exit(0); }",
      "console.log('  127 passing (1s)');",
      "console.log('  1 failing');",
      "console.log('  1) widget suite');",
      "console.log('       candidate broke widget:');",
      "console.log('     Error: injected');",
      "process.exit(1);",
    ].join('\n'));
    w(path.join(stub, 'swap.js'), [
      "const fs=require('fs');",
      "const p='./node_modules/widget/package.json';",
      "const j=JSON.parse(fs.readFileSync(p));j.version='2.0.0';",
      "fs.writeFileSync(p,JSON.stringify(j));",
    ].join('\n'));
    const spec = {
      schema: 2, id: 'authority-crforgery',
      dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
      downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
      commands: {
        prepare: stageCommands({ mocha: false }),
        swap: ['node', 'swap.js', '{candidate}'],
        test: ['node', 'test.js'],
      },
      repeats: { baseline: 2, candidate: 2 },
      timeoutSecs: { install: 120, test: 120 },
    };
    const result = await runExperiment(spec, repoRoot, true, {
      fetch: async () => ({ ...FAKE_BLOB }),
      extract: (_tgz, wsRoot) => { fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true }); },
    });
    const cls = result.bundle.classification;
    assert.ok(!STRONG.has(cls.label),
      `a printed failure summary with no runner attestation reached ${cls.label}`);
    // Same mechanism as the PASS forgery: the table reads the prose as a
    // regression (rule 5 shape) and the GATE refuses to let it out alive.
    assert.equal(cls.rule, 14);
    assert.match(cls.reason, /previously rule 5 CONFIRMED_REGRESSION/);
    for (const r of result.bundle.rounds) {
      assert.equal(r.executionObservation.status, 'ABSENT', `${r.arm}#${r.round}`);
    }
  });
});
