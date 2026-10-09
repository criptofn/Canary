import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, it } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-worker-tools-'));
process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-worker-trust-'));
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(process.env.CANARY_TRUST_STORE!, { recursive: true, force: true });
});

it('describes full-file replacement and targeted edits truthfully to MCP clients', () => {
  const store = path.join(TMP, 'store');
  const work = path.join(TMP, 'work');
  fs.mkdirSync(store);
  fs.mkdirSync(work);
  const response = spawnSync(process.execPath, [CLI, 'provider', 'worker-tools', store, work], {
    cwd: REPO,
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, CANARY_CONFINED_CHECK: '0' },
  });
  assert.equal(response.status, 0, `${response.stdout}\n${response.stderr}`);
  const message = JSON.parse(response.stdout.trim()) as {
    result?: { tools?: Array<{ description?: string }> };
  };
  const description = message.result?.tools?.[0]?.description;
  assert.ok(description, 'the installed MCP tool did not advertise its implementation operation');
  assert.match(description, /write \(CREATE a file or REPLACE its full contents\)/);
  assert.doesNotMatch(description, /write \(CREATE a file\)/, 'the old create-only description returned');
  assert.match(description, /Use `edit` for a targeted change/);
});
