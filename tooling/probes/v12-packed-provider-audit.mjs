// Bounded release audit: production enrollment must work outside the checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const packs = path.join(repo, 'pack/npm');
const archives = fs.readdirSync(packs).filter(f => f.endsWith('.tgz'));
if (archives.length !== 1) throw new Error('Pack first; expected exactly one archive');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary packed provider '));
const run = (exe, args, cwd = root, shell = false) => spawnSync(exe, args,
  { cwd, shell, windowsHide: true, encoding: 'utf8', timeout: 60000 });
const requireOk = (label, r) => {
  if (r.status !== 0) throw new Error(`${label}: ${r.status}\n${r.stdout}\n${r.stderr}`);
  console.log(`PASS ${label}`);
};
try {
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
  requireOk('install exact local tarball', run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', `"${path.join(packs, archives[0])}"`], root, true));
  const cli = path.join(root, 'node_modules/@canary-rn/cli/dist/main.js');
  const result = spawnSync(process.execPath, [path.join(repo, 'tooling/probes/v12-production-authority.mjs'), '--cli', cli],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  console.log((result.stdout ?? '') + (result.stderr ?? ''));
  requireOk('installed production authority, custody and attack battery', result);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
