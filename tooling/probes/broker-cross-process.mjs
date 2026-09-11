#!/usr/bin/env node
/**
 * MEASUREMENT — can a broker in one process serve a client in ANOTHER process,
 * repeatedly?
 *
 * The provider design assumes yes: the broker is a service, the CLI is a worker,
 * and every accept/promotion is a separate CLI invocation. In-process tests cannot
 * see the difference, and while writing the provider-only routing tests this looked
 * broken (a client connected, its frame never arrived, and it timed out) — so it is
 * measured here rather than assumed either way.
 *
 * Spawns a real broker on a unique pipe and runs a real client child THREE times
 * against it, printing each reply. Also checks whether the server can serve two
 * clients that overlap in time.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const IPC = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'provider', 'ipc.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-broker-xproc-'));
const pipe = `canary-xproc-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const token = crypto.randomBytes(32).toString('hex');

const CLIENT = path.join(TMP, 'client.mjs');
fs.writeFileSync(CLIENT, `import { callBroker } from ${JSON.stringify(new URL(`file://${IPC.replace(/\\/g, '/')}`).href)};
const [pipe, token, op] = process.argv.slice(2);
try {
  const r = await callBroker({ op }, { pipeName: pipe, token, timeoutMs: 8000 });
  console.log('REPLY ' + JSON.stringify(r));
  process.exit(0);
} catch (e) {
  console.log('REFUSED ' + (e.code ?? 'error') + ' ' + e.message);
  process.exit(1);
}
`);

const { createBrokerServer } = await import(new URL(`file://${IPC.replace(/\\/g, '/')}`).href);
let served = 0;
const server = createBrokerServer({
  pipeName: pipe,
  token,
  authorityGeneration: 'gen-1',
  handler: (req) => { served += 1; return { echo: req.op, served }; },
  log: (l) => console.log(`  server log: ${l}`),
});
await new Promise((resolve) => server.server.once('listening', resolve));
console.log(`broker listening on ${pipe} (waited for 'listening', NOT probed)`);

const runChild = (op) => {
  const r = spawnSync(process.execPath, [CLIENT, pipe, token, op], { encoding: 'utf8', timeout: 30_000 });
  const line = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).pop() ?? '(no output)';
  console.log(`  child #${op}: exit ${r.status} — ${line}`);
  return r.status === 0;
};

let ok = 0;
for (let i = 1; i <= 3; i++) if (runChild(`broker.hello`)) ok += 1;
console.log(`\nsequential cross-process calls: ${ok}/3 succeeded`);

// Two clients at once: a service must not serialize them into a queue it forgets.
const both = await Promise.all([1, 2].map((n) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLIENT, pipe, token, 'broker.status'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (b) => { out += String(b); });
  c.on('close', (code) => resolve(`${n}:exit ${code} ${out.trim().split('\n').pop() ?? ''}`));
})));
console.log(`overlapping cross-process calls: ${both.join(' | ')}`);
console.log(`server handler invocations: ${served}`);

const wrongToken = spawnSync(process.execPath, [CLIENT, pipe, crypto.randomBytes(32).toString('hex'), 'broker.hello'], { encoding: 'utf8', timeout: 30_000 });
console.log(`wrong token: exit ${wrongToken.status} — ${(`${wrongToken.stdout ?? ''}${wrongToken.stderr ?? ''}`).trim().split('\n').pop()}`);

await server.close();
console.log(`\n=== cross-process broker: ${ok === 3 ? 'WORKS' : 'BROKEN'} ===`);
console.log(`scratch: ${TMP}`);
if (process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
process.exit(ok === 3 ? 0 : 1);
