// The untrusted caller under measurement.
//
// Runs twice with the same code: once UNRESTRICTED (positive control, ordinary user
// process) and once CONFINED (AppContainer + restricted + low integrity, zero
// capabilities) by tools/windows-boundary/CanaryConfinedLauncher.cs. Every attempt is
// recorded with its real result, and the caller never writes a PASS/FAIL verdict —
// the trusted probe outside decides, from these observations plus its own.
//
// Deliberately NOT minified or clever: this file is the attack, so it must be readable.
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
const work = arg('--work', process.cwd());
const root = arg('--root', path.dirname(work));
const store = arg('--store', path.join(root, 'trusted-store'));
const target = arg('--target', path.join(root, 'trusted-target'));
const evidencePath = arg('--evidence', path.join(work, 'worker-evidence.json'));
const nonce = arg('--nonce', 'missing');
const port = Number(arg('--port', '0'));
const mode = arg('--mode', 'attacks');            // attacks | broker | hello
const pipeName = arg('--pipe', null);
const packageSid = arg('--package', null);

const report = {
  nonce,
  mode,
  started: true,
  pid: process.pid,
  argv: process.argv.slice(1),
  parsedPackageArgument: packageSid,
  cwd: process.cwd(),
  argv0: process.argv[0],
  env: {
    hasBrokerKey: Object.prototype.hasOwnProperty.call(process.env, 'CANARY_CUSTODY_KEY'),
    hasNonce: Object.prototype.hasOwnProperty.call(process.env, 'CANARY_PROBE_NONCE'),
    appContainer: process.env.CANARY_APPCONTAINER || null
  },
  attempts: [],
  broker: []
};
function save() { fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2)); }
// The broker embeds `verification` as JSON, so a response may carry it as a string or as an
// already-parsed object depending on who read it. Accept both, never guess.
function verificationOf(response) {
  if (!response) return null;
  const value = response.verification;
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function codeOf(error) {
  if (!error) return 'NO-ERROR';
  return error.code || error.name || 'UNKNOWN';
}
function attempt(id, operation) {
  try {
    const value = operation();
    report.attempts.push({ id, executed: true, result: 'ALLOWED', value: value === undefined ? null : String(value).slice(0, 400) });
  } catch (error) {
    report.attempts.push({ id, executed: true, result: codeOf(error), value: String(error.message || error).slice(0, 400) });
  }
  save();
}
function syncAttempt(id, operation) {
  try {
    const value = operation();
    report.attempts.push({ id, executed: true, result: value.status === 0 ? 'ALLOWED' : 'BLOCKED', value: JSON.stringify({ status: value.status, error: value.error ? String(value.error.code || value.error.message) : null }).slice(0, 400) });
  } catch (error) {
    report.attempts.push({ id, executed: true, result: codeOf(error), value: String(error.message || error).slice(0, 400) });
  }
  save();
}

// ---- broker conversation ---------------------------------------------------------------
function ask(socket, request, pending, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { socket.off('data', onData); reject(new Error('pipe-timeout')); }, timeoutMs);
    function onData(chunk) {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.off('data', onData);
      try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
    }
    socket.on('data', onData);
    socket.write(JSON.stringify(request) + '\n');
  });
}

async function brokerCases() {
  const socket = net.connect('\\\\.\\pipe\\' + pipeName);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', e => reject(new Error('pipe-connect ' + codeOf(e))));
  });
  const record = (id, value) => { report.broker.push({ id, ...value }); save(); };
  const step = async (id, request) => {
    try { const response = await ask(socket, request, null, 20000); record(id, { ok: true, response }); return response; }
    catch (error) { record(id, { ok: false, error: String(error.message || error) }); return null; }
  };

  const hello = await step('hello', { id: 1, verb: 'hello', claim: { package: packageSid, identity: 'untrusted-caller', packageArgument: packageSid === null ? 'NOT-PARSED' : 'parsed' } });
  // The trusted side's OWN view of which account it runs as. The probe records this
  // in the product measurement rather than assuming the normal user identity.
  await step('broker-self', { id: 2, verb: 'self' });
  await step('network-diagnostic', { verb: 'network-diagnostic' });
  const review = await step('review', { id: 3, verb: 'review' });
  let receipt = null, content = null, body = 'confined-promotion-body-' + nonce;
  const reviewed = verificationOf(review);
  receipt = reviewed?.receipt ?? null;
  content = reviewed?.content ?? null;
  if (receipt) {
    const parts = String(receipt).split('|');
    const revision = parts[1];
    // CASE 1 — forge: the caller mints its own receipt without custody key material.
    const forged = 'v2|' + revision + '|' + crypto.createHmac('sha256', 'caller-chosen-key').update(revision).digest('hex');
    await step('promote-forged', { id: 3, verb: 'promote', revision, receipt: forged });
    // CASE 2 — mismatch: a genuine broker signature, but the body is not the reviewed revision.
    await step('promote-mismatch', { id: 4, verb: 'promote', revision, receipt, body: 'substituted-body' });
    await step('promote-digest', { verb: 'promote', revision: '0'.repeat(64), receipt });
    for (const field of ['project', 'candidate', 'target']) {
      await step('promote-' + field, { verb: 'promote', revision, receipt, [field]: 'unrelated' });
    }
    // CASE 3 — legitimate proposal: ask the broker to sign the body it will verify.
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const signed = await step('signature-request', { id: 5, verb: 'sign', payload: digest });
    await step('promote-valid', { id: 6, verb: 'promote', revision, receipt });
    await step('promote-replay', { verb: 'promote', revision, receipt });
    record('reviewed-artifact', { ok: true, content });
  } else {
    record('promote-forged', { ok: false, error: 'no broker review receipt obtained' });
  }
  socket.destroy();   // no lingering handle: the process must not wait on the broker to release
}

async function main() {
  save();
  if (mode === 'hello') {
    // One exchange only. Used both for the negative identity control (an unrestricted process
    // must be refused) and for the impersonated-read attack ('current'), because the broker
    // reads the trusted store with the CALLER's access rights on that verb.
    const verb = arg('--verb', 'hello');
    // The claim is deliberately the package SID the caller was HANDED, not one it measured:
    // the broker must not be able to learn its own verdict from the caller's description.
    const claimed = packageSid || 'unclaimed';
    const socket = net.connect('\\\\.\\pipe\\' + pipeName);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', e => reject(new Error('pipe-connect ' + codeOf(e)))); });
    const response = await ask(socket, { id: 1, verb, claim: { package: claimed, identity: 'one-shot-caller' } }, null, 20000);
    report.broker.push({ id: verb, ok: true, response });
    report.claimedPackage = claimed;
    save();
    socket.destroy();
    return;
  }
  if (mode === 'attacks') {
    attempt('work-write', () => fs.writeFileSync(path.join(work, 'caller-output.txt'), nonce));
    attempt('work-read', () => fs.readFileSync(path.join(work, 'caller-output.txt'), 'utf8'));
    attempt('trusted-store-read', () => fs.readFileSync(path.join(store, 'custody-key-material.txt'), 'utf8'));
    attempt('trusted-store-write', () => fs.writeFileSync(path.join(store, 'custody-key-material.txt'), 'attacked'));
    attempt('promotion-target-write', () => fs.writeFileSync(path.join(target, 'promoted.bin'), 'attacked'));
    // Egress first, so its result is on record even if the descendant probe below does not
    // return. The control case is a live local listener, never an Internet timeout.
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise(resolve => {
      let done = false;
      const finish = result => { if (done) return; done = true; socket.destroy(); report.attempts.push({ id: 'tcp-egress', executed: true, result, value: '127.0.0.1:' + port }); save(); resolve(); };
      socket.once('data', data => finish(data.toString().trim() === 'observed' ? 'CONNECTED' : 'BAD-ACK'));
      socket.once('error', e => finish(codeOf(e)));
      socket.setTimeout(2000, () => finish('TIMEOUT'));
    });
    // Attempt to leave the confinement by having a child of this process do the write. The
    // child writes the trial nonce, so the probe can attribute the file to this very arm.
    syncAttempt('privileged-child', () => {
      const outFile = path.join(root, 'escaped-child.txt');
      const result = spawnSync(path.join(work, 'node.exe'), ['--preserve-symlinks-main', path.join(work, 'descendant.cjs'),
        outFile, path.join(work, 'descendant.json'), nonce], { timeout: 5000, stdio: 'ignore' });
      return { status: result.status, error: result.error };
    });
    return;
  }
  if (mode === 'broker') { await brokerCases(); return; }
  throw new Error('unknown mode ' + mode);
}

// Watchdog: a probe must never be the reason an arm has no evidence. If anything above blocks,
// the record on disk is already written and this exits so the launcher returns a real code.
const watchdog = setTimeout(() => {
  report.watchdog = true;
  save();
  process.exit(7);
}, 75000);
watchdog.unref();

main().then(() => { save(); process.exitCode = 0; }, error => {
  report.error = String(error && error.stack || error);
  save();
  process.exitCode = 3;
});
