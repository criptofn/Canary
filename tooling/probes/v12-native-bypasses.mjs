// Real native handle/path attempts and an independently observed local network target.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-native-bypasses-'));
const work = path.join(root, 'work'), store = path.join(root, 'trusted-store');
fs.mkdirSync(work); fs.mkdirSync(store);
fs.symlinkSync(store, path.join(work, 'escape'), 'junction');
let server;
let failed = 0, inconclusive = 0, executed = 0, blocked = 0, controls = 0;
const report = { scope: 'disposable native controls, not production activation', arms: {}, tests: [] };
const record = (name, result, detail) => {
  console.log(`${result} ${name}: ${detail}`);
  report.tests.push({ name, result, detail });
  if (result === 'FAIL') failed++;
  if (result === 'INCONCLUSIVE') inconclusive++;
};
const ps = (file, args) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
  { windowsHide: true, encoding: 'utf8', timeout: 45000 });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  let symlink = 'absent';
  try {
    fs.symlinkSync(path.join(store, 'native-secret.txt'), path.join(work, 'secret-link'), 'file');
    symlink = 'symlink';
  } catch (e) {
    record('symlink-provisioning', 'INCONCLUSIVE', `creation failed (${e.code}); no symlink attack counted`);
  }
  const identity = path.join(root, 'identity.json');
  const cli = path.join(repo, 'tools/windows-boundary/confined-cli.ps1');
  const provision = ps(cli, ['-Mode', 'identity', '--record', identity]);
  if (provision.status !== 0 || !fs.existsSync(identity)) throw new Error(`identity unavailable: ${provision.stderr}`);
  const sid = read(identity).package;
  const host = process.argv.includes('--lan')
    ? Object.values(os.networkInterfaces()).flat().find(x => x?.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.') && !x.address.startsWith('100.'))?.address
    : '127.0.0.1';
  if (!host) throw new Error('no local LAN address for controlled endpoint');
  const ready = path.join(root, 'ready'), journal = path.join(root, 'connections.jsonl');
  server = spawn(process.execPath, [path.join(repo, 'tooling/test-support/fixtures/confined-listener.cjs'), ready, journal, host],
    { windowsHide: true, stdio: 'ignore' });
  const end = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  if (!fs.existsSync(ready)) throw new Error('trusted listener unavailable');
  const port = fs.readFileSync(ready, 'utf8');
  const side = path.join(root, 'side.jsonl');
  const run = ps(path.join(repo, 'tooling/test-support/fixtures/boundary-native-run.ps1'),
    ['-Work', work, '-Store', store, '-Package', sid, '-HostAddress', host, '-Port', port, '-Side', side, '-Symlink', symlink]);
  if (run.status !== 0) {
    for (const arm of ['control', 'restricted']) {
      const file = path.join(work, `native-${arm}.json`);
      if (fs.existsSync(file)) report.arms[arm] = read(file);
    }
    throw new Error(`native arms exit ${run.status}: ${run.stdout}\n${run.stderr}\n${JSON.stringify(report.arms)}`);
  }
  const control = read(path.join(work, 'native-control.json'));
  const restricted = read(path.join(work, 'native-restricted.json'));
  const token = fs.readFileSync(side, 'utf8').trim().split('\n').map(JSON.parse);
  const connections = fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  report.arms = { control, restricted, token, connections };
  // Prove the same independent listener is still reachable AFTER the attack.
  const postControl = await new Promise(resolve => {
    const socket = net.connect({ host, port: Number(port) });
    socket.setTimeout(2500);
    socket.once('data', data => { socket.destroy(); resolve(data.toString() === 'observed\n'); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  const postConnections = fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  report.arms.postControl = { connected: postControl, connections: postConnections };
  if (token[0]?.appContainer !== true || token[0]?.restricted !== true || token[0]?.capabilities !== 0 ||
      token[0]?.integrity !== 'S-1-16-4096' || token[0]?.package !== sid || token[1]?.exit !== 0) throw new Error('confined token/exit not independently proven');
  for (const c of control.attempts) {
    const attack = restricted.attempts.find(a => a.id === c.id);
    if (c.allowed) controls++;
    if (attack?.executed) executed++;
    // Some Windows hosts raise native STATUS_INVALID_HANDLE rather than returning
    // Win32 ERROR_INVALID_HANDLE. The fixture captures the actual exception code.
    const denied = c.allowed && attack?.executed && attack.allowed === false && [5, 6, -1073741816].includes(attack.error);
    if (denied) blocked++;
    record(c.id, denied ? 'PASS' : 'FAIL', `control=${c.allowed}/${c.error}; restricted=${attack?.allowed}/${attack?.error}`);
  }
  const n = restricted.network;
  if (n?.executed) executed++;
  const goodControl = control.network?.result === 'CONNECTED' && connections.length >= 1;
  if (goodControl) controls++;
  const policyDenial = n?.diagnosticReturn === 0 && [1,2,3].includes(n?.isolationError)
    && control.network?.diagnosticReturn === 0 && control.network?.isolationError === 0;
  if (goodControl && n?.executed && n.result !== 'CONNECTED' &&
      (n.result === 'WSA-10013' || policyDenial) && connections.length === 1 && postControl && postConnections.length === 2) {
    blocked++;
    record('egress', 'PASS', `control connected; native policy diagnostic identifies missing capability; ${JSON.stringify(n)}`);
  } else if (n?.result === 'CONNECTED') record('egress', 'FAIL', 'restricted process connected');
  else record('egress', 'INCONCLUSIVE', `control=${control.network?.result}; connections=${connections.length}; native=${JSON.stringify(n)}`);
} catch (e) { record('infrastructure', 'FAIL', e.stack); }
finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise(r => server.once('exit', r)); server.kill(); await stopped;
  }
  ps(path.join(repo, 'tools/windows-boundary/confined-cli.ps1'), ['-Mode', 'identity', '--delete']);
  report.counts = { executed, blocked, controls, failed, inconclusive };
  fs.writeFileSync(path.join(os.tmpdir(), 'v12-native-bypasses.json'), JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(report.counts));
  process.exitCode = failed || inconclusive ? 1 : 0;
}
