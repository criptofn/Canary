/** Trusted measurement producer. Uses this deployment's actual package SIDs and
 * private producer key as the native read/handle target. No imported old results. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { enrollment, nativeRoot, read, plainFile, native as runNative, quote } from './production.js';
import { anchorPath, publishProductionMeasurement, type ProductionTranscript, type NativeObservation } from './production-measurement.js';
import { candidateIdentity } from '../onboarding.js';

const fixture = path.resolve(nativeRoot, '../../tooling/test-support/fixtures');
export async function measureProductionAttacks(store: string): Promise<void> {
  const e = enrollment(store);
  const { nonce: challenge, startedAt } = read<{ nonce: string; startedAt: number }>(path.join(store, 'measurement-session.json'));
  // All provider launches use this same exclusive lock. A second live builder
  // cannot rewrite the measurement fixture while its package grant is present.
  const lock = path.join(store, 'caller.lock'), handle = fs.openSync(lock, 'wx');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-production-measure-'));
  const native: NativeObservation[] = [];
  let server: ReturnType<typeof spawn> | undefined;
  let negativePipe: ReturnType<typeof spawn> | undefined;
  try {
    const events = plainFile(path.join(store, 'authority.jsonl')).toString('utf8').trim().split('\n').map(x => JSON.parse(x));
    const framing = events.find(event => {
      try { JSON.parse(event.requestJson); return false; } catch { return Date.parse(event.at) >= startedAt; }
    });
    if (!framing) throw new Error('production framing attack missing');
    const authority = events.map(event => {
      try { return { ...event, request: JSON.parse(event.requestJson) }; }
      catch { if (event.response?.status !== 403) throw new Error('malformed request was not refused'); return event; }
    }).filter(x => x.request?.challenge === challenge);
    const review = authority.find(x => x.request.verb === 'review' && x.response.status === 200);
    if (!review || typeof review.request.candidate !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(review.request.candidate)) throw new Error('reviewed production subject missing');
    const privateCheckout = path.join(os.tmpdir(), `canary-production-${e.id}-${review.request.candidate}`);
    const host = Object.values(os.networkInterfaces()).flat().find(x => x?.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.') && !x.address.startsWith('100.'))?.address;
    if (!host) throw new Error('controlled local network endpoint unavailable');
    for (const sid of [e.package, e.verifier]) {
      const work = fs.mkdtempSync(path.join(workspace, 'arm-'));
      const secret = path.join(store, 'producer.key');
      fs.symlinkSync(store, path.join(work, 'escape'), 'junction');
      fs.symlinkSync(secret, path.join(work, 'secret-link'), 'file');
      const targets = path.join(work, 'authority-targets.json');
      fs.writeFileSync(targets, JSON.stringify([secret, path.join(store, 'enrollment.json'), anchorPath(store), path.join(e.base, '.git', 'HEAD'), path.join(privateCheckout, '.git')]));
      const ready = path.join(store, 'listener-ready'), journal = path.join(store, 'listener.jsonl'), side = path.join(store, 'native-side.jsonl');
      fs.rmSync(ready, { force: true });
      server = spawn(process.execPath, [path.join(fixture, 'confined-listener.cjs'), ready, journal, host], { windowsHide: true, stdio: 'ignore' });
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      if (!fs.existsSync(ready)) throw new Error('independent listener failed');
      const port = plainFile(ready).toString('utf8');
      const r = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture, 'boundary-native-run.ps1'),
          '-Work', work, '-Store', store, '-Package', sid, '-HostAddress', host, '-Port', port, '-Side', side, '-Symlink', 'symlink', '-SecretPath', secret, '-AuthorityTargets', targets],
        { windowsHide: true, encoding: 'utf8', timeout: 45000 });
      if (r.status !== 0) throw new Error(`native attack execution failed: ${r.stderr}`);
      const control = read<NativeObservation['control']>(path.join(work, 'native-control.json'));
      const restricted = read<NativeObservation['restricted']>(path.join(work, 'native-restricted.json'));
      const token = plainFile(side).toString('utf8').trim().split('\n').map(x => JSON.parse(x));
      const connections = (): number => plainFile(journal).toString('utf8').trim().split('\n').filter(Boolean).length;
      const before = connections();
      const postControl = await new Promise<string>(resolve => {
        const socket = net.connect({ host, port: Number(port) }); socket.setTimeout(2500);
        socket.once('data', b => { socket.destroy(); resolve(b.toString() === 'observed\n' ? 'CONNECTED' : 'BAD-ACK'); });
        socket.once('error', () => resolve('ERROR'));
        socket.once('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });
      });
      native.push({ package: sid, control, restricted, token, connectionsBeforePostControl: before, connectionsAfterPostControl: connections(), postControl });
      const stopped = new Promise(r => server!.once('exit', r)); server.kill(); await stopped; server = undefined;
    }
    const pipeWork = fs.mkdtempSync(path.join(workspace, 'pipe-'));
    const caller = path.join(pipeWork, 'caller.cjs'), output = path.join(pipeWork, 'pipe.json');
    fs.copyFileSync(path.join(fixture, 'confined-caller.cjs'), caller);
    const ready = path.join(store, 'pipe-negative-ready'), side = path.join(store, 'pipe-negative-side');
    fs.rmSync(ready, { force: true });
    const pipe = `canary-negative-${e.id}`;
    negativePipe = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', path.join(fixture, 'medium-pipe.ps1'), '-Pipe', pipe, '-Package', e.package, '-Ready', ready, '-DenyPackage'],
      { windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    if (!fs.existsSync(ready)) throw new Error('pipe control unavailable');
    const args = ['--preserve-symlinks-main', caller, '--mode', 'hello', '--pipe', pipe, '--package', e.package, '--evidence', output, '--nonce', challenge, '--work', pipeWork];
    const control = spawnSync(process.execPath, args, { cwd: pipeWork, windowsHide: true, timeout: 10000 });
    if (control.status !== 0) throw new Error('pipe unrestricted control did not execute');
    const controlReport = read<ProductionTranscript['pipeNegative']['control']>(output);
    fs.unlinkSync(output);
    const restricted = runNative(store, { mode: 'run', command: [process.execPath, ...args].map(quote).join(' '), cwd: pipeWork, side, package: e.package });
    if (restricted.status !== 3) throw new Error('pipe restricted denial was not observed');
    const pipeNegative: ProductionTranscript['pipeNegative'] = {
      control: controlReport, restricted: read(output), token: plainFile(side).toString('utf8').trim().split('\n').map(x => JSON.parse(x)),
      descriptor: read(ready), nonce: challenge,
    };
    const applied = candidateIdentity(e.base);
    if (!applied.head || !applied.tree) throw new Error('promoted base identity unavailable');
    const observations: ProductionTranscript = { native, authority, pipeNegative, framing,
      enrollmentDigest: crypto.createHash('sha256').update(plainFile(path.join(store, 'enrollment.json'))).digest('hex'),
      promotedHead: applied.head, promotedTree: applied.tree };
    publishProductionMeasurement(store, challenge, startedAt, observations);
  } finally {
    if (server && server.exitCode === null) { const stopped = new Promise(r => server!.once('exit', r)); server.kill(); await stopped; }
    if (negativePipe && negativePipe.exitCode === null) { const stopped = new Promise(r => negativePipe!.once('exit', r)); negativePipe.kill(); await stopped; }
    fs.closeSync(handle); fs.unlinkSync(lock);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(path.join(store, 'producer.key.rename'), { force: true });
  }
}
