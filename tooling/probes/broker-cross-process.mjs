#!/usr/bin/env node
/**
 * MEASUREMENT — can a broker in one process serve a client in ANOTHER process,
 * repeatedly?
 *
 * The provider design assumes yes: the broker is a service, the CLI is a worker,
 * and every accept/promotion is a separate CLI invocation. In-process tests cannot
 * see the difference, and while writing the provider-only routing tests this looked
 * broken (a client connected, its frame never arrived, and it timed out) — so it is
 * MEASURED here rather than assumed either way.
 *
 * THE ANSWER, and the reason this probe exits 0: a client in another process IS
 * served — but only when it does not BLOCK ITS OWN EVENT LOOP. `spawnSync` does,
 * and in this probe the broker lives in the process that would block, so those three
 * calls time out while the broker's handler records every request it eventually
 * receives. The product has no such problem (its broker is a service in its own
 * process), which is why the ASYNC path is the one that must hold, and why the
 * synchronous result is reported as an explained measurement instead of a failure.
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
for (let i = 1; i <= 3; i++) if (runChild('broker.hello')) ok += 1;
console.log(`\nsynchronous (spawnSync) cross-process calls: ${ok}/3 succeeded`);
console.log('  explained: spawnSync BLOCKS this process — which is where the broker lives — so the');
console.log('  broker cannot answer while the child waits. The handler below still records them.');

// The premise that has to HOLD: a client that does not block its own event loop is
// served, repeatedly and concurrently, from another process.
async function asyncChild(op) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLIENT, pipe, token, op], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (b) => { out += String(b); });
    c.on('close', (code) => resolve({ code, reply: out.trim().split('\n').pop() ?? '' }));
  });
}
const sequential = [];
for (let i = 0; i < 3; i += 1) sequential.push(await asyncChild('broker.hello'));
for (const [i, r] of sequential.entries()) console.log(`  async call ${i + 1}: exit ${r.code} — ${r.reply}`);
const asyncOk = sequential.filter((r) => r.code === 0 && r.reply.startsWith('REPLY')).length;

const overlapping = await Promise.all([1, 2].map(() => asyncChild('broker.status')));
for (const r of overlapping) console.log(`  overlapping call: exit ${r.code} — ${r.reply}`);
const overlapOk = overlapping.filter((r) => r.code === 0 && r.reply.startsWith('REPLY')).length;

console.log(`server handler invocations: ${served} (3 from the blocked sync children, ${asyncOk + overlapOk} answered)`);

// A client in another process presenting the WRONG token must be refused — checked
// on the async path, because that is the one the product uses.
const wrongToken = await new Promise((resolve) => {
  const c = spawn(process.execPath, [CLIENT, pipe, crypto.randomBytes(32).toString('hex'), 'broker.hello'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (b) => { out += String(b); });
  c.on('close', (code) => resolve({ code, reply: out.trim().split('\n').pop() ?? '' }));
});
console.log(`wrong token (async): exit ${wrongToken.code} — ${wrongToken.reply}`);
const wrongRefused = wrongToken.code !== 0 && /REFUSED unauthorized/.test(wrongToken.reply);

await server.close();
const pass = asyncOk === 3 && overlapOk === 2 && wrongRefused;
console.log(`\n=== cross-process broker: ${pass ? 'SERVES ASYNC CLIENTS AND REFUSES A WRONG TOKEN' : 'BROKEN'} ===`);
console.log(`  sequential async: ${asyncOk}/3 answered; overlapping async: ${overlapOk}/2 answered; wrong token refused: ${wrongRefused}`);
console.log(`scratch: ${TMP}`);
if (process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
