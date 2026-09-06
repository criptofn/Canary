#!/usr/bin/env node
/**
 * PROBE: a degenerate/empty verification plan must never launder a silent
 * pass at the Stop boundary. A configured repo whose plan list was emptied
 * (hand-edit, or a project that lost every recognized script) must emit an
 * UNVERIFIED systemMessage — not silence, not a block on zero executed
 * checks. This was previously an ad-hoc inline snippet that tripped the
 * interactive approval gate; it is now a first-class probe (approval-free
 * workflow rule): stable path, deterministic, temp-dir fixtures, cleanup,
 * explicit exit code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CANARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(CANARY, 'apps', 'cli', 'dist', 'src', 'main.js');
if (!fs.existsSync(CLI)) { console.error(`build first: ${CLI} missing`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-emptyplan-probe-'));
const FIX = path.join(CANARY, 'tooling', 'test-support', 'fixtures', 'f-pass.js');
let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) console.log(`PASS: ${label}`);
  else { failures++; console.log(`FAIL: ${label} ${extra}`); }
};

try {
  const root = path.join(TMP, 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'emptyplan-probe', scripts: { test: `node "${FIX}"` },
  }, null, 2));
  const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { encoding: 'utf8', timeout: 120_000 });
  check('setup READY on a green sample repo', setup.status === 0 && /READY/.test(setup.stdout), setup.stdout);

  const cfgFile = path.join(root, '.canary', 'canary.local.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.plan = []; // simulate the hand-edited degenerate config
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));

  const hookInput = JSON.stringify({ cwd: root, stop_hook_active: false, hook_event_name: 'Stop' });
  const cp = spawnSync(process.execPath, [CLI, 'checkpoint'], { cwd: root, input: hookInput, encoding: 'utf8', timeout: 120_000 });
  check('checkpoint exits 0 (never fights the harness)', cp.status === 0, cp.output.join(''));
  const out = JSON.parse(cp.stdout || '{}');
  check('empty plan -> UNVERIFIED systemMessage', /UNVERIFIED/.test(out.systemMessage ?? ''), cp.stdout);
  check('empty plan -> NOT a block, NOT silence', out.decision === undefined && cp.stdout.trim() !== '', cp.stdout);

  const doc = spawnSync(process.execPath, [CLI, 'doctor', root], { encoding: 'utf8', timeout: 120_000 });
  check('doctor flags the empty plan and never prints READY', doc.status === 2 && /plan is empty/.test(doc.stdout) && !/READY/.test(doc.stdout), doc.stdout);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures ? `PROBE-FAIL (${failures})` : 'PROBE-PASS');
process.exit(failures ? 1 : 0);
