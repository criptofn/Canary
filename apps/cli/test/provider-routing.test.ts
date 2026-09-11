/**
 * PROVIDER-ONLY ACCEPT/PROMOTE ROUTING (v1.1 Phase 3, item 4).
 *
 * THE CLAIM: on a machine where a provider is configured, the local writable path
 * for `accept` and promote is CLOSED. Not "usually closed", not "closed unless the
 * broker is down" — closed, with every failure a refusal that leaves the base
 * byte-identical. And on a machine with no provider, the ordinary local behaviour
 * is unchanged (asserted, so this cannot silently become a v1.0 behaviour change).
 *
 * These tests use a REAL broker over the REAL named pipe — the product's own
 * `createBrokerServer` + `callBroker`, the real `PROVIDER_PIPE_NAME`, the real token
 * file, and the real provider handler for one case — because a mocked transport
 * would prove nothing about the thing being closed.
 *
 * The broker is started exactly ONCE per run. MEASURED while writing this file: on
 * Windows, closing and re-listening the same pipe name in one process left the
 * second instance unable to serve OTHER processes (the client connected, the frame
 * never arrived, and the client timed out) — so the "broker unreachable" cases run
 * BEFORE any listen, and every later case switches a mode on the single server.
 * That is a test-harness property, not a product one: the product talks to a broker
 * installed as a service, which listens once and stays.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-routing-store-'));
process.env['CANARY_TRUST_STORE'] = STORE;
delete process.env['CANARY_WORKER_USER']; // no enrolled identity: this host's real state

import { IpcError, callBroker, createBrokerServer, ensureBrokerToken } from '../src/provider/ipc.js';
import { PROVIDER_PIPE_NAME, createProviderHandler } from '../src/provider/service.js';
import {
  authorityGenerationPath, brokerRoutingRequired, expectedAuthorityGeneration,
  refusalText, reservePromotionThroughBroker, submitAcceptanceThroughBroker,
  type BrokerRouteOutcome,
} from '../src/provider/routing.js';
import { storeFromEnv } from '../src/trust-store.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-routing-'));
const PROJECT = crypto.randomBytes(32).toString('hex'); // a controller-issued identity

const token = ensureBrokerToken(STORE);

/** A routed refusal, or null when the broker approved (or was not consulted). */
function refused(o: BrokerRouteOutcome): { code: string; message: string } | null {
  return o.routed && !o.ok ? { code: o.code, message: o.message } : null;
}

// ---------------------------------------------------------------------------
// Part 1 — with NO broker listening. These MUST run before the single listen.
// ---------------------------------------------------------------------------
describe('provider-only routing — no broker', () => {
  it('with NO provider configured, routing is not required (the local path stays)', async () => {
    const sparse = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-routing-noprovider-'));
    const store = { root: sparse } as ReturnType<typeof storeFromEnv>;
    try {
      assert.equal(brokerRoutingRequired(store), false, 'a store with no token and no enrolled identity is not a provider');
      assert.deepEqual(await reservePromotionThroughBroker({ projectId: PROJECT, candidate: 'c' }, store),
        { routed: false }, 'no provider: the caller keeps its local behaviour, unchanged');
    } finally { fs.rmSync(sparse, { recursive: true, force: true }); }
  });

  it('a broker token in the store IS a configured provider', () => {
    assert.equal(fs.existsSync(path.join(STORE, 'provider-token')), true, 'the token is what makes it configured');
    assert.equal(brokerRoutingRequired(storeFromEnv()), true);
  });

  it('an unreachable broker is connect-failed, not a fallback', async () => {
    const routed = await reservePromotionThroughBroker({ projectId: PROJECT, candidate: 'c' }, storeFromEnv());
    assert.equal(routed.routed, true, 'a provider IS configured, so the act must be routed');
    assert.equal(refused(routed)?.code, 'connect-failed', `got ${JSON.stringify(routed)}`);
  });

  it('a broker refusal is surfaced with a meaning, never as a bare code', () => {
    assert.match(refusalText('stale-proof', 'no current passing verification'),
      /^stale-proof \(the broker holds no current passing verification for this subject\): /);
    assert.match(refusalText('unauthorized', 'x'), /does not hold the installation token/);
    assert.match(refusalText('something-new', 'x'), /^something-new: x$/, 'an unknown code still carries its message');
  });
});

// ---------------------------------------------------------------------------
// Real repositories. `git` is real here: "the base did not move" must be measured.
// ---------------------------------------------------------------------------
function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.stdout?.trim()}`);
  return (r.stdout ?? '').trim();
}
/**
 * Run the CLI ASYNCHRONOUSLY.
 *
 * MEASURED, and this is load-bearing: with `spawnSync` the CLI never received a
 * reply from the broker in this same test process. The reason is not the pipe — it
 * is that `spawnSync` BLOCKS this process's event loop, and the broker lives here,
 * so it cannot accept or answer while the child waits. The product has no such
 * problem (its broker is a service in its own process); the harness does. Proven
 * both ways in tooling/probes/broker-cross-process.mjs: 0/3 synchronous clients
 * succeeded while 2/2 asynchronous ones did, and the server's handler recorded
 * every request either way.
 */
function canary(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      // An explicitly supplied store (the "no provider" case) must win over the
      // default: the whole point of that test is a CLI that sees no provider.
      env: { CANARY_TRUST_STORE: STORE, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += String(b); });
    child.stderr.on('data', (b) => { stderr += String(b); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
async function makeRepo(name: string): Promise<string> {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(
    { name, private: true, scripts: { test: 'node checks/verify.js' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'checks', 'verify.js'),
    "const fs = require('node:fs');\nprocess.exit(fs.readFileSync('marker.txt', 'utf8').includes('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(root, 'marker.txt'), 'ok\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'routing@canary.local');
  git(root, 'config', 'user.name', 'Canary Routing');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const setup = await canary(['setup', '--yes', root], root);
  assert.equal(setup.status, 0, `setup failed: ${setup.stdout}\n${setup.stderr}`);
  const task = await canary(['task', 'provider routing probe change', '--kind', 'refactor'], root);
  assert.equal(task.status, 0, `task registration failed: ${task.stdout}\n${task.stderr}`);
  return root;
}
/** Create a candidate and advance it so promotion would otherwise succeed. */
async function preparedCandidate(root: string, name: string): Promise<{ iso: string; candidate: string; baseHead: string }> {
  const create = await canary(['isolate', name], root);
  assert.equal(create.status, 0, `isolate failed: ${create.stdout}\n${create.stderr}`);
  const iso = path.join(root, '.canary', 'candidates', name);
  fs.writeFileSync(path.join(iso, 'work.txt'), 'worker work\n');
  git(iso, 'add', '-A');
  git(iso, 'commit', '-m', 'worker work');
  return { iso, candidate: git(iso, 'rev-parse', 'HEAD'), baseHead: git(root, 'rev-parse', 'HEAD') };
}
const fingerprint = (root: string) => ({
  head: git(root, 'rev-parse', 'HEAD'),
  tree: git(root, 'rev-parse', 'HEAD^{tree}'),
  tracked: git(root, 'status', '--porcelain', '--untracked-files=no'),
});

describe('provider-only routing — the CLI acts with no broker', () => {
  it('promotion refuses an unreachable broker and does NOT apply (base byte-identical)', async () => {
    const root = await makeRepo('no-broker');
    await preparedCandidate(root, 'w1');
    const before = fingerprint(root);
    const r = await canary(['isolate', '--promote', 'w1'], root);
    assert.equal(r.status, 2, `promotion must refuse: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /a provider is configured here, so promotion must be authorized by the broker/);
    assert.match(r.stdout, /connect-failed \(the broker is not running/);
    assert.match(r.stdout, /nothing was applied; the trusted base is untouched/);
    assert.deepEqual(fingerprint(root), before, 'the base must be byte-identical after a refused promotion');
  });

  it('accept with a provider configured writes NO local acceptance record', async () => {
    const root = await makeRepo('accept');
    await preparedCandidate(root, 'w4');
    const dir = path.join(root, '.canary', 'acceptance');
    const before = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    // No TTY here, so the supported flow refuses before writing anything — and with a
    // provider installed there is no non-interactive path that could write one either.
    const r = await canary(['accept', 'w4'], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /requires an interactive terminal|broker/);
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], before, 'no acceptance record may be written');
    assert.equal(fs.existsSync(path.join(dir, 'w4.json')), false);
  });

  it('with NO provider configured the local promotion path is unchanged', async () => {
    const root = await makeRepo('local-mode');
    const { candidate } = await preparedCandidate(root, 'w5');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-routing-bare-'));
    try {
      const r = await canary(['isolate', '--promote', 'w5'], root, { ...process.env, CANARY_TRUST_STORE: bare });
      assert.equal(r.status, 0, `the local path must still work: ${r.stdout}\n${r.stderr}`);
      assert.equal(git(root, 'rev-parse', 'HEAD'), candidate);
      assert.doesNotMatch(r.stdout, /broker/, 'no broker is consulted when none is configured');
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — ONE real broker for every remaining case, switched by mode.
// ---------------------------------------------------------------------------
type Mode = 'approve-mismatch' | 'approve-exact' | 'provider-handler' | 'stub';
let mode: Mode = 'stub';
let window: { targetId: string; expectedHead: string; candidateCommit: string } = { targetId: 'x', expectedHead: '', candidateCommit: '' };
const seen: string[] = [];

const realProviderHandler = createProviderHandler({
  store: storeFromEnv(),
  projectId: PROJECT,
  generation: 'gen-1',
  liveSubject: () => { throw new IpcError('no-enrollment', 'this broker has no enrolled subject'); },
});
/**
 * The broker is started LAZILY, by the first test of this describe.
 *
 * It must not exist while the "no broker" tests run — creating it at module load
 * would make those tests measure a live broker and pass for the wrong reason (which
 * is exactly what the first version of this file did).
 */
let broker: ReturnType<typeof createBrokerServer> | null = null;
function ensureBroker(): Promise<void> {
  broker = createBrokerServer({
    pipeName: PROVIDER_PIPE_NAME,
    token,
    authorityGeneration: 'gen-7',
    handler: ((req: { op: string }) => {
      seen.push(req.op);
      if (mode === 'provider-handler') return (realProviderHandler as (r: unknown) => unknown)(req);
      if (req.op === 'broker.reserve-promotion') {
        if (mode === 'approve-exact') return window;
        if (mode === 'approve-mismatch') return { targetId: 'somebody-else', expectedHead: 'f'.repeat(40), candidateCommit: 'e'.repeat(40) };
      }
      if (mode === 'approve-exact' && req.op === 'broker.reconcile') return { status: 'applied' };
      return { ok: true };
    }) as never,
    log: (l) => seen.push(`log=${l}`),
  });
  return new Promise((resolve) => { broker!.server.once('listening', () => resolve()); });
}
after(async () => {
  if (broker !== null) await broker.close();
  fs.rmSync(STORE, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('provider-only routing — with a real broker serving', () => {
  it('the broker is reachable, and the client waits for it to listen', async () => {
    await ensureBroker();
    for (let i = 0; i < 60; i++) {
      try {
        await callBroker({ op: 'broker.hello' }, { pipeName: PROVIDER_PIPE_NAME, token, timeoutMs: 2_000 });
        return;
      } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    throw new Error('the broker never accepted a connection');
  });

  it('a token this process does not share is unauthorized', async () => {
    const tokenFile = path.join(STORE, 'provider-token');
    const real = fs.readFileSync(tokenFile, 'utf8');
    try {
      fs.writeFileSync(tokenFile, `${crypto.randomBytes(32).toString('hex')}\n`);
      const routed = await reservePromotionThroughBroker({ projectId: PROJECT, candidate: 'c' }, storeFromEnv());
      assert.equal(refused(routed)?.code, 'unauthorized', `got ${JSON.stringify(routed)}`);
    } finally { fs.writeFileSync(tokenFile, real); }
  });

  it('a stale authority generation is refused before any work is claimed', async () => {
    try {
      assert.equal(expectedAuthorityGeneration(storeFromEnv()), undefined, 'nothing recorded: no staleness claim');
      fs.writeFileSync(authorityGenerationPath(STORE), 'gen-3\n');
      assert.equal(expectedAuthorityGeneration(storeFromEnv()), 'gen-3');
      const routed = await reservePromotionThroughBroker({ projectId: PROJECT, candidate: 'c' }, storeFromEnv());
      assert.equal(refused(routed)?.code, 'stale-generation', `got ${JSON.stringify(routed)}`);
    } finally { fs.rmSync(authorityGenerationPath(STORE), { force: true }); }
  });

  it('the REAL provider handler refuses acceptance here, and says which control is missing', async () => {
    mode = 'provider-handler';
    try {
      const routed = await submitAcceptanceThroughBroker({ projectId: PROJECT, candidate: 'c' }, storeFromEnv());
      assert.equal(routed.routed, true);
      const ref = refused(routed);
      assert.ok(ref, `the real handler must refuse here: ${JSON.stringify(routed)}`);
      assert.equal(ref.code, 'no-restricted-runner');
      assert.match(ref.message, /restricted runner identity|enrolled/);
    } finally { mode = 'stub'; }
  });

  it('promotion refuses a broker that authorizes a DIFFERENT window (candidate mismatch)', async () => {
    mode = 'approve-mismatch';
    try {
      const root = await makeRepo('mismatch');
      await preparedCandidate(root, 'w2');
      const before = fingerprint(root);
      const r = await canary(['isolate', '--promote', 'w2'], root);
      assert.equal(r.status, 2, `promotion must refuse: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /DIFFERENT promotion window/, `the refusal must name the mismatch: ${r.stdout}`);
      assert.deepEqual(fingerprint(root), before, 'a mismatched authorization must not move the base');
    } finally { mode = 'stub'; }
  });

  it('promotion proceeds when the broker authorizes exactly this {base, candidate} pair', async () => {
    const root = await makeRepo('authorized');
    const { candidate, baseHead } = await preparedCandidate(root, 'w3');
    const before = fingerprint(root);
    window = { targetId: 'w3', expectedHead: baseHead, candidateCommit: candidate };
    mode = 'approve-exact';
    try {
      const r = await canary(['isolate', '--promote', 'w3'], root);
      assert.equal(r.status, 0, `an authorized promotion must apply: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /provider: promotion window reserved by the broker/);
      const after = fingerprint(root);
      assert.notEqual(after.head, before.head, 'the base must actually move');
      assert.equal(after.head, candidate, 'and land exactly on the verified candidate commit');
      assert.equal(after.tree, git(root, 'rev-parse', `${candidate}^{tree}`));
      assert.ok(seen.includes('broker.reserve-promotion'), `the broker must have been asked: ${JSON.stringify(seen)}`);
    } finally { mode = 'stub'; }
  });
});
