// Primitive measurement only: not a provider/HARDENED certification.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-appcontainer-'));
const work = path.join(root, 'work');
const authority = path.join(root, 'authority');
const nonce = randomUUID();
const server = net.createServer(s => s.end());
const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
async function run(command, args, options) {
  return await new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    child.once('error', e => resolve({ code: null, output: String(e) }));
    child.once('exit', code => resolve({ code, output }));
  });
}
try {
  fs.mkdirSync(work); fs.mkdirSync(authority);
  fs.writeFileSync(path.join(authority, 'secret.txt'), nonce);
  fs.copyFileSync(path.join(repo, 'tooling/test-support/fixtures/appcontainer-attacks.cjs'), path.join(work, 'attack.cjs'));
  fs.symlinkSync(authority, path.join(work, 'escape'), 'junction');
  // Never use /T: traversing the installed junction could relabel authority.
  const label = spawnSync('icacls.exe', [work, '/setintegritylevel', '(OI)(CI)L'], { encoding: 'utf8', windowsHide: true });
  if (label.status !== 0) throw new Error(`low label unavailable: ${label.stderr}`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['--preserve-symlinks-main', path.join(work, 'attack.cjs'), root, String(server.address().port), nonce];
  const control = await run(process.execPath, args, { cwd: work, env: { ...process.env, CANARY_PROBE_SECRET: nonce } });
  const readEvidence = () => JSON.parse(fs.readFileSync(path.join(work, 'evidence.json'), 'utf8'));
  const before = readEvidence();
  if (control.code !== 0 || before.nonce !== nonce || before.attempts.length !== 7) throw new Error('control did not execute all operations');
  fs.writeFileSync(path.join(authority, 'secret.txt'), nonce);
  fs.unlinkSync(path.join(work, 'evidence.json'));
  fs.unlinkSync(path.join(work, 'allowed.txt'));
  const confined = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(repo, 'tools/windows-boundary/restricted-runner.ps1'), '-Integrity', 'low', '-SandboxDirectory', work,
    '-CommandLine', [process.execPath, ...args].map(quote).join(' ')], { env: { ...process.env, CANARY_PROBE_SECRET: nonce } });
  console.log(`launcher exit=${confined.code}\n${confined.output}`);
  if (confined.code !== 0 || !fs.existsSync(path.join(work, 'evidence.json'))) throw new Error('restricted child did not complete; ZERO attacks credited');
  const after = readEvidence();
  if (!after.started || after.nonce !== nonce || after.attempts.length !== 7) throw new Error('missing restricted execution evidence');
  let failed = 0;
  for (let i = 0; i < before.attempts.length; i++) {
    const c = before.attempts[i], a = after.attempts[i];
    const expected = a.id.startsWith('work-') ? a.result === 'ALLOWED'
      : a.id === 'environment-secret' ? c.result === 'EXPOSED' && a.result === 'ABSENT'
      : a.id === 'tcp-loopback' ? c.result === 'CONNECTED' && ['EACCES', 'EPERM'].includes(a.result)
      : c.result === 'ALLOWED' && ['EACCES', 'EPERM'].includes(a.result);
    const pass = c.id === a.id && a.executed && expected;
    const inconclusive = a.id === 'tcp-loopback' && ['TIMEOUT', 'ETIMEDOUT'].includes(a.result);
    console.log(`${pass ? 'PASS' : inconclusive ? 'INCONCLUSIVE' : 'FAIL'} ${a.id}: control=${c.result}, restricted=${a.result}, executed=${a.executed}`);
    if (!pass) failed++;
  }
  if (fs.readFileSync(path.join(authority, 'secret.txt'), 'utf8') !== nonce) failed++;
  fs.writeFileSync(path.join(os.tmpdir(), 'canary-appcontainer-measurement.json'), JSON.stringify({
    at: new Date().toISOString(), scope: 'experimental primitive, NOT production provider',
    control: before, confined: after, launcher: confined, pass: failed === 0
  }, null, 2));
  process.exitCode = failed ? 1 : 0;
} catch (e) { console.error(`FAIL ${e.stack}`); process.exitCode = 1; }
finally {
  server.close();
  // Remove junction explicitly, never recursively traverse an authority link.
  fs.rmSync(path.join(work, 'escape'), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
