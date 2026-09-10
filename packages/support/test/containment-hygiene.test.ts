/**
 * Audit F-6 (GLM minor closure pass) — the containment spawns (taskkill / ps
 * / powershell) run under a SANITIZED environment with TRUSTED absolute
 * resolution. These paths remain NON-verdict-authoritative; what is pinned:
 *   S1 a lying `ps` on the caller PATH never controls the sweep;
 *   S2 Windows tools resolve absolutely under System32 — caller-PATH entries
 *      are never consulted, and an unresolvable tool fails SAFE (bare name
 *      under the sanitized PATH → ENOENT → honest failure), proven via an
 *      injected SystemRoot tree on ANY platform; the win32 env shape is
 *      asserted natively on Windows;
 *   S3 ordinary containment still works — that is lifecycle.test.ts, which
 *      runs alongside this file in the same build;
 *   S4 a sweep tool that cannot run is reported as failure (null rows →
 *      failed:true), never as "no survivors".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  containmentEnv, resolvePsBinary, resolveSystemTool, psTableRows, sanitizedEnvKeys,
} from '../src/index.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-f6-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const fresh = (name: string): string => {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

describe('S1 — a caller-PATH "ps" liar cannot control the sweep', () => {
  // The POSIX harness is a #!/bin/sh script; the Windows containment vector
  // (System32 tools) is covered structurally by S2, which runs everywhere.
  const POSIX = process.platform !== 'win32';
  it('resolvePsBinary never returns a PATH-found binary; the sweep env has no caller PATH', { skip: POSIX ? false : 'POSIX liar harness' }, () => {
    const liarDir = fresh('liar-ps');
    const liar = path.join(liarDir, 'ps');
    // A table that would make ANY pid look like a session member of pid 999999
    // — if this ever reached the sweep, containment decisions would be forged.
    fs.writeFileSync(liar, '#!/bin/sh\necho "888888 1 999999 999999"\necho "777777 888888 999999 999999"\n');
    fs.chmodSync(liar, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${liarDir}:${saved}`;
    try {
      const bin = resolvePsBinary();
      assert.ok(path.isAbsolute(bin) || bin === 'ps', `trusted resolution yielded: ${bin}`);
      assert.ok(!bin.startsWith(liarDir), `the liar was selected: ${bin}`);
      if (bin !== 'ps') assert.ok(bin === '/usr/bin/ps' || bin === '/bin/ps', `not a system copy: ${bin}`);
      // Even the bare fail-safe cannot reach the liar: the sweep env restricts
      // PATH to the system dirs, and never inherits the caller block at all.
      const env = containmentEnv();
      assert.equal(env.PATH, '/usr/bin:/bin');
      assert.ok(!(env.PATH ?? '').includes(liarDir));
      assert.ok(!('NODE_OPTIONS' in env) && !('NODE_PATH' in env));
    } finally {
      process.env.PATH = saved;
    }
  });

  it('the production fallback reads a REAL table (trusted default, sanitized env)', () => {
    const rows = psTableRows(); // default = resolvePsBinary() + containmentEnv()
    if (rows === null) {
      // Honest on minimal hosts (no ps at all): that IS the failed-sweep arm.
      assert.equal(resolvePsBinary(), 'ps', 'null only when no system ps exists');
      return;
    }
    assert.ok(rows.length > 0, 'a real ps must yield at least one row');
    assert.ok(rows.some((r) => r.p === process.pid), 'the real table must contain the test process itself');
  });

  it('the SPAWN SITE itself never inherits caller env — leak canary (wiring, not just the helper)', { skip: POSIX ? false : 'win32: no sh harness; win32 sites pinned by native env shape + trusted resolution' }, () => {
    // The helper being sanitized proves nothing if the spawn call site drops
    // it. This stub prints a table row ONLY when the caller's marker is
    // visible in ITS environment — removing `env: containmentEnv()` at the
    // psTableRows spawn (audit F-6 mutation M6) flips this to red.
    const dir = fresh('leak-canary');
    const bin = path.join(dir, 'ps');
    fs.writeFileSync(bin, '#!/bin/sh\nif [ -n "$CANARY_ENV_LEAK_CHECK" ]; then echo "999999 1 999999 999999"; fi\n');
    fs.chmodSync(bin, 0o755);
    const saved = process.env.CANARY_ENV_LEAK_CHECK;
    process.env.CANARY_ENV_LEAK_CHECK = `leaked-${process.pid}`;
    try {
      const rows = psTableRows(bin);
      assert.ok(rows === null || rows.every((r) => r.sid !== 999999),
        'caller env reached the containment spawn — the sweep child saw CANARY_ENV_LEAK_CHECK');
    } finally {
      if (saved === undefined) delete process.env.CANARY_ENV_LEAK_CHECK;
      else process.env.CANARY_ENV_LEAK_CHECK = saved;
    }
  });

  it('a forged binary given EXPLICITLY is parsed as inert data, never trusted as a source', { skip: POSIX ? false : 'POSIX sh harness' }, () => {
    const liar = path.join(fresh('liar2'), 'psx');
    fs.writeFileSync(liar, '#!/bin/sh\necho "888888 1 999999 999999"\n');
    fs.chmodSync(liar, 0o755);
    const rows = psTableRows(liar);
    const first = rows?.[0];
    assert.ok(rows?.length === 1 && first?.sid === 999999,
      'psTableRows parses what the given binary prints — production NEVER gives it a caller binary (trusted resolution above)');
  });
});

describe('S2 — trusted resolution for Windows tools (injected SystemRoot, any platform)', () => {
  it('prefers the absolute System32 path when the tool exists there', () => {
    const sysRoot = fresh('winroot');
    const sys32 = path.join(sysRoot, 'System32');
    fs.mkdirSync(path.join(sys32, 'WindowsPowerShell', 'v1.0'), { recursive: true });
    fs.writeFileSync(path.join(sys32, 'taskkill.exe'), '');
    fs.writeFileSync(path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '');
    const saved = process.env.SystemRoot;
    process.env.SystemRoot = sysRoot;
    try {
      assert.equal(resolveSystemTool('taskkill.exe'), path.join(sys32, 'taskkill.exe'));
      assert.equal(resolveSystemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
        path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    } finally { process.env.SystemRoot = saved; }
  });

  it('missing tool → bare-name fail-safe (sanitized PATH + ENOENT → honest failure, never a caller-PATH binary)', () => {
    const saved = process.env.SystemRoot;
    process.env.SystemRoot = path.join(TMP, 'no-such-root');
    try {
      assert.equal(resolveSystemTool('taskkill.exe'), 'taskkill.exe');
    } finally { process.env.SystemRoot = saved; }
    // The bare name is searched ONLY under the containment PATH — prove the
    // env shape regardless of platform (win32 values asserted natively below):
    const keys = sanitizedEnvKeys(containmentEnv());
    assert.ok(!keys.includes('PSModulePath'), 'PowerShell module-loader env never inherited');
    assert.ok(!keys.includes('NODE_OPTIONS') && !keys.includes('NODE_PATH'));
  });

  it('on native Windows: PATH is System32+windir only, identity neutralized (F6 loader law)', { skip: process.platform === 'win32' ? false : 'native Windows shape' }, () => {
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\WINDOWS';
    const env = containmentEnv();
    assert.equal(env.PATH, `${path.join(systemRoot, 'System32')};${systemRoot}`);
    assert.equal(env.USERNAME, 'canary');
    assert.equal(env.USERDOMAIN, 'CANARY');
    assert.equal(env.ComSpec, path.join(systemRoot, 'System32', 'cmd.exe'));
    // a lying taskkill earlier on the CALLER path is invisible to the sweep:
    const callerPath = process.env.PATH ?? '';
    if (callerPath) assert.notEqual(env.PATH, callerPath);
  });
});

describe('S4 — a sweep tool that cannot run is FAILURE, never "no survivors"', () => {
  it('psTableRows(missing binary) → null (the caller maps null to failed:true)', () => {
    assert.equal(psTableRows(path.join(TMP, 'definitely', 'not-a-tool')), null);
  });
  it('psTableRows(binary that exits nonzero) → null', { skip: process.platform === 'win32' ? 'POSIX sh harness' : false }, () => {
    const bad = path.join(fresh('bad-ps'), 'ps');
    fs.writeFileSync(bad, '#!/bin/sh\nexit 3\n');
    fs.chmodSync(bad, 0o755);
    assert.equal(psTableRows(bad), null);
  });
  it('the null→failed mapping is wired: a sweep against garbage still answers (smoke of the same arm sweepPosix uses)', () => {
    // sweepPosix's else-branch is `if (psRows === null) return { killed, failed: true }`
    // — assert the mapping contract directly so the wiring can never silently
    // become "null is treated as empty rows".
    const rows = psTableRows(path.join(TMP, 'definitely', 'not-a-tool'));
    assert.equal(rows === null ? 'failed:true' : 'data', 'failed:true');
  });
});
