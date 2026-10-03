#!/usr/bin/env node
// Check oracle sensitivity with the archived false-positive and a correct control.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [badSource, runtimeRoot, out] = process.argv.slice(2);
assert.ok([badSource, runtimeRoot, out].every(p => p && path.isAbsolute(p)) && !fs.existsSync(out));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-oracle-stability-'));
fs.mkdirSync(out, { recursive: true });
const rows = [];
try {
  for (const arm of ['bad', 'good']) {
    const repo = path.join(fixture, arm), src = path.join(repo, 'src/verify');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}');
    if (arm === 'bad') {
      fs.copyFileSync(badSource, path.join(src, 'failure-ids.ts'));
      fs.copyFileSync(path.join(runtimeRoot, 'src/verify/summarize-vitest.ts'), path.join(src, 'summarize-vitest.ts'));
    } else {
      fs.writeFileSync(path.join(src, 'failure-ids.ts'), String.raw`export function extractFailureIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(?:FAILED|ERROR)\s+(.+)$/);
    if (!match) continue;
    let id = match[1], depth = 0;
    for (let i = 0; i < id.length; i++) {
      if (depth === 0 && id.slice(i, i + 3) === ' - ') { id = id.slice(0, i); break; }
      if (id[i] === '[') depth++;
      if (id[i] === ']') depth--;
    }
    ids.add(id.trim());
  }
  return ids;
}`);
    }
    const args = [path.join(import.meta.dirname, 'v15-validation-oracle.mjs'), '--label', 'R1', '--repo', repo,
      '--runtime-root', runtimeRoot, '--out', path.join(out, arm), '--expected', arm === 'bad' ? 'fail' : 'pass'];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 150000 });
    const record = JSON.parse(fs.readFileSync(path.join(out, arm, 'oracle-result.json')));
    rows.push({ arm, executable: process.execPath, args, status: r.status, error: r.error?.message ?? null,
      testPassed: record.testPassed, expectedFailureObserved: record.expectedFailureObserved });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, `${arm}: oracle failed its control; inspect preserved output`);
    assert.equal(record.testPassed, arm === 'good');
    console.log(`PASS ${arm}: oracle ${arm === 'bad' ? 'rejects unstable IDs' : 'accepts stable IDs'}`);
  }
} finally {
  fs.writeFileSync(path.join(out, 'regression-result.json'), JSON.stringify({ rows, instrumentSha256: sha(import.meta.filename),
    badSourceSha256: sha(badSource), dependencySha256: sha(path.join(runtimeRoot, 'src/verify/summarize-vitest.ts')),
    oracleSha256: sha(path.join(import.meta.dirname, 'v15-validation-oracle.mjs')) }, null, 2));
  fs.rmSync(fixture, { recursive: true, force: true });
}
