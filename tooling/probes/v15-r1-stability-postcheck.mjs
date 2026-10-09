#!/usr/bin/env node
/** Additional review counterexample, explicitly outside the frozen pilot protocol. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const [prepared, out] = process.argv.slice(2);
assert.ok([prepared, out].every(p => p && path.isAbsolute(p)) && !fs.existsSync(out));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(out);
const rows = [];
for (const arm of ['plain', 'canary']) {
  const repo = path.join(prepared, 'projects/R1', arm), dir = path.join(out, arm);
  fs.mkdirSync(dir);
  const source = path.join(repo, 'src/verify/failure-ids.ts');
  const test = path.join(dir, 'stability.test.ts');
  fs.writeFileSync(test, `import { expect, it } from 'vitest';
import { extractFailureIds } from ${JSON.stringify(pathToFileURL(source).href)};
it('keeps the same parametrized id stable when failure repr contains a separator', () => {
  const id = 'tests/test_x.py::test_p[a - b]';
  const first = [...extractFailureIds('FAILED ' + id + ' - ValueError: a - b')];
  const second = [...extractFailureIds('FAILED ' + id + ' - ValueError: x - c')];
  console.log('OPERATOR_STABILITY_POSTCHECK', JSON.stringify({ first, second }));
  expect(second).toEqual(first); expect(first).toEqual([id]); expect(second).toEqual([id]);
});`, { flag: 'wx' });
  const args = [path.join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--root', dir, '--reporter=verbose', test];
  const startedAt = new Date().toISOString();
  const r = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  fs.writeFileSync(path.join(dir, 'stdout.log'), r.stdout ?? ''); fs.writeFileSync(path.join(dir, 'stderr.log'), r.stderr ?? '');
  assert.equal(r.error, undefined);
  rows.push({ arm, repo, sourceSha256: hash(fs.readFileSync(source)), testSha256: hash(fs.readFileSync(test)),
    executable: process.execPath, args, startedAt, finishedAt: new Date().toISOString(), exitCode: r.status,
    passed: r.status === 0, stdoutSha256: hash(r.stdout ?? ''), stderrSha256: hash(r.stderr ?? '') });
}
const report = { scope: 'Post-pilot review counterexample. Original protocol and oracle results are unchanged.',
  instrumentSha256: hash(fs.readFileSync(import.meta.filename)), rows };
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
