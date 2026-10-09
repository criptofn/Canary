import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('binding rejects incomplete intake before writing, while preserving dash-prefixed requirements', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-bind-intake-test-'));
  try {
    const cli = path.resolve(import.meta.dirname, '../../apps/cli/dist/src/main.js');
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'v15-bind-intake-regression.mjs'),
      cli, path.join(temp, 'evidence')], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const report = JSON.parse(fs.readFileSync(path.join(temp, 'evidence/report.json'), 'utf8'));
    assert.equal(report.observations.length, 7);
    assert.ok(report.observations.every((o) => o.passed));
  } finally {
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
