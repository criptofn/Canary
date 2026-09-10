/**
 * Audit F6/M5 — PERMANENT child-environment observation test.
 *
 * The evidence bundle records `envKeys` as the DECLARED allowlist. That claim
 * is only true if the child's OBSERVED environment equals the declared one.
 * On Windows the process loader appends logon-session identity variables to
 * every child environment regardless of replacement (proven by probe
 * 2026-08-30: even env:{} yielded real USERNAME/HOMEPATH) — sanitizedEnv
 * neutralizes them by declaring fixed values. This test executes the real
 * child and asserts observed == declared on BOTH platforms; it must keep
 * running forever (it is the witness for the SECURITY.md allowlist claim).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runCommand, sanitizedEnv, sanitizedEnvKeys, type WorkspaceLayout } from '../src/index.js';

const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-env-'));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

function workspace(): WorkspaceLayout {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
  const ws = { root, fixture: path.join(root, 'fixture') };
  fs.mkdirSync(ws.fixture, { recursive: true });
  return ws;
}

/** Run a child that reports its own OBSERVED environment (keys + picked values). */
async function observedEnv(ws: WorkspaceLayout) {
  const out = await runCommand({
    ws, nodeDir: NODE_DIR,
    argv: [NODE, '-e', [
      'const e = process.env;',
      'const picked = {};',
      "for (const k of ['USERNAME','USERDOMAIN','LOGONSERVER','HOMEDRIVE','HOMEPATH','SYSTEMDRIVE','USERPROFILE','HOME','NODE_OPTIONS','SSH_AUTH_SOCK','GITHUB_TOKEN','NPM_TOKEN'])",
      "  if (k in e) picked[k] = e[k];",
      'console.log(JSON.stringify({ keys: Object.keys(e).sort(), picked }));',
    ].join(' ')],
    timeoutSecs: 60,
  });
  assert.equal(out.exitCode, 0, out.stderr);
  return { reported: JSON.parse(out.stdout.trim()) as { keys: string[]; picked: Record<string, string> }, out };
}

describe('audit F6 — child env observation: declared == observed', () => {
  it('metadata-only environment construction creates no directories and keeps the same policy', () => {
    const ws = workspace();
    const before = fs.readdirSync(ws.root);
    const readOnly = sanitizedEnv({ ws, nodeDir: NODE_DIR, materialize: false });
    assert.deepEqual(fs.readdirSync(ws.root), before);
    assert.deepEqual(readOnly, sanitizedEnv({ ws, nodeDir: NODE_DIR }));
  });
  it('the child sees EXACTLY the declared allowlist keys (nothing undeclared)', async () => {
    const ws = workspace();
    const declared = sanitizedEnvKeys(sanitizedEnv({ ws, nodeDir: NODE_DIR }));
    const { reported, out } = await observedEnv(ws);
    assert.deepEqual(reported.keys, declared,
      `undeclared=${JSON.stringify(reported.keys.filter((k) => !declared.includes(k)))} ` +
      `absent=${JSON.stringify(declared.filter((k) => !reported.keys.includes(k)))}`);
    // and the keys persisted to evidence are the SAME set (not a lie of convenience)
    assert.deepEqual(out.envKeys, declared);
  });

  it('Windows session identity vars are neutralized, not merely absent from the block', async () => {
    const ws = workspace();
    const declared = sanitizedEnv({ ws, nodeDir: NODE_DIR });
    const { reported } = await observedEnv(ws);
    if (process.platform === 'win32') {
      for (const k of ['USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMDRIVE']) {
        assert.ok(k in reported.picked, `loader must have injected ${k} (that is the whole point of neutralizing it)`);
        assert.equal(reported.picked[k], declared[k], `${k}: child saw the REAL value, neutralization failed`);
      }
      assert.equal(reported.picked.USERNAME, 'canary');
      assert.ok(reported.picked.HOMEPATH!.includes('isolated-home'), reported.picked.HOMEPATH);
    } else {
      for (const k of ['USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMDRIVE']) {
        assert.ok(!(k in reported.picked), `POSIX child unexpectedly has ${k} — allowlist is no longer exact`);
      }
    }
    // Credentials / behavior-injection vars must be invisible on every platform.
    for (const k of ['NODE_OPTIONS', 'SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'NPM_TOKEN']) {
      assert.ok(!(k in reported.picked), `${k} leaked into child environment`);
    }
  });

  it('the real account identity is not reachable via any observed value', async () => {
    const ws = workspace();
    const { reported } = await observedEnv(ws);
    const realUser = os.userInfo().username;
    const dump = JSON.stringify(reported.picked);
    assert.ok(!dump.includes(`"${realUser}"`), `real username ${realUser} present in child identity vars`);
    // HOME/USERPROFILE must point inside the disposable workspace
    assert.ok(reported.picked.HOME!.startsWith(path.resolve(ws.root)), `HOME escaped workspace: ${reported.picked.HOME}`);
    if (process.platform === 'win32') {
      assert.ok(reported.picked.USERPROFILE!.startsWith(path.resolve(ws.root)), 'USERPROFILE escaped workspace');
    }
  });
});
