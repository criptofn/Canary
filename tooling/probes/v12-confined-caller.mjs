// The default battery now attacks the actual enrolled production deployment.
// --legacy retains the old standalone harness for diagnostic comparison only;
// its retired schema-1 result can NEVER activate HARDENED.
if (!process.argv.includes('--legacy')) {
  await import('./v12-production-authority.mjs');
  process.exit(process.exitCode ?? 1);
}
// Historical standalone four-control boundary battery (not activation evidence).
//
//   node tooling/probes/v12-confined-caller.mjs
//
// MEASUREMENT ONLY. Builds the trusted/untrusted split without elevation and measures, for each
// control: an unrestricted positive control, a real restricted attack, the mechanism that caused
// the denial, and fail-closed behaviour when the boundary cannot be established. Every verdict
// here is decided OUTSIDE the confined process, from observations it cannot author.
//
// Writes only under the OS temp dir. Prints PASS/FAIL/INCONCLUSIVE lines; exit 0 iff all pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(repo, 'tooling/test-support/fixtures/confined-caller.cjs');
const cli = path.join(repo, 'tools/windows-boundary/confined-cli.ps1');
const launcherModule = path.join(repo, 'tools/windows-boundary/CanaryConfinedLauncher.cs');
const lines = [];
let pass = 0, fail = 0, inconclusive = 0;

// The PRODUCT's own measurement module. The battery does not describe the
// deployment in its own words and hope the product agrees: it builds the record
// through these functions, so the schema, the per-control derivation and the
// custody signature are the ones the product validates.
const measurementModule = path.join(repo, 'apps/cli/dist/src/provider/confined-measurement.js');
if (!fs.existsSync(measurementModule)) {
  console.error(`FAIL no compiled measurement module at ${measurementModule} — run \`npm run build\` first`);
  process.exit(1);
}
const CM = await import(`file://${measurementModule.replace(/\\/g, '/')}`);

/** Every assertion this run made, keyed by name, so the record can cite them. */
const assertions = new Map();

function report(verdict, name, detail) {
  lines.push(`${verdict} ${name}${detail ? ': ' + detail : ''}`);
  console.log(`${verdict} ${name}${detail ? ': ' + detail : ''}`);
  assertions.set(name, { verdict, detail: detail ?? '' });
  if (verdict === 'PASS') pass++; else if (verdict === 'FAIL') fail++; else inconclusive++;
}
const held = (name) => assertions.get(name)?.verdict === 'PASS';
/** The observed value, or the literal `MISSING` so a null can never read as a denial. */
const seen = (value) => (value === undefined || value === null || value === '' ? 'MISSING' : value);
const oneOf = (value, allowed) => allowed.includes(value);

/** `DOMAIN\user` and SID of a `whoami /user /fo csv /nh` line: `"dom\user","S-1-5-…"`. */
function parseWhoamiUser(text) {
  const cells = String(text ?? '').split(/\r?\n/)[0]?.split(',') ?? [];
  if (cells.length < 2) return { name: null, identity: null };
  return { name: cells[0].replace(/"/g, '').trim() || null, identity: cells[1].replace(/"/g, '').trim() || null };
}
const control = (name, ok, detail) => report(ok ? 'PASS' : 'FAIL', name, detail);
function attack(name, ok, detail) { report(ok ? 'PASS' : 'FAIL', name, detail); }
function inconclusive_(name, detail) { report('INCONCLUSIVE', name, detail); }

const shell = ['powershell.exe', 'pwsh.exe'].map(name => {
  const found = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : null;
}).find(Boolean);
if (!shell) { console.error('FAIL no PowerShell host available for Add-Type'); process.exit(1); }

// This process's own identity, measured. The broker runs as it (that is the
// recorded ceiling), so the record names it instead of implying a separation.
const callerWho = parseWhoamiUser(spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout);
const callerIdentity = callerWho.identity;
const callerName = callerWho.name;

// Windows command-line quoting: backslashes are only special immediately before a quote, and a
// trailing run of them must be doubled so it does not escape the closing quote.
const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-confined-'));
const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-confined-relay-'));
const work = path.join(root, 'caller-work');
const store = path.join(root, 'trusted-store');
const target = path.join(root, 'trusted-target');

// The confined caller is launched ONLY through the native boundary, relayed through a file so
// the observations survive on hosts where a confined child cannot inherit stdio pipes. The
// relay prints the operation's exit code as its final line, because the file is the record.
const relay = path.join(repo, 'tools/windows-boundary/confined-relay.ps1');
let relayCounter = 0;
function boundary(mode, rest, timeoutMs = 180000) {
  const index = ++relayCounter;
  const log = path.join(relayDir, `relay-${index}.log`);
  const argumentsFile = path.join(relayDir, `args-${index}.txt`);
  // Line 1 is the operation, the rest is its argument vector, one per line.
  fs.writeFileSync(argumentsFile, [mode, ...rest.map(String)].join('\r\n') + '\r\n');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', relay,
    '-Log', log, '-ArgumentsFile', argumentsFile],
    { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 << 20 });
  const output = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const stderr = String(result.stderr || '');
  const exitLine = /LAUNCHER-EXIT (-?\d+)/.exec(output);
  return { code: exitLine ? Number(exitLine[1]) : result.status, output: output + (stderr ? '\nSTDERR ' + stderr.slice(0, 800) : '') };
}
function confined(commandLine, sandbox, sideChannel, packageSid) {
  return boundary('launcher', [commandLine, sandbox, sideChannel, packageSid, 'keep']);
}
// MEASURED: inside the boundary, Node's default entry-point resolution calls realpath on a
// path that resolves to the denied volume root and exits with EPERM before the caller's code
// runs. --preserve-symlinks-main skips that resolution. Every confined Node invocation passes
// it; the probe's own unrestricted control arm does not need it.
function nodeCommand(...args) {
  return [process.execPath, '--preserve-symlinks-main', ...args].map(quote).join(' ');
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fs.existsSync(file)) return true; await sleep(100); }
  return false;
}
/// <summary>The broker embeds `verification` as JSON; a JSON reader may hand it back already parsed.</summary>
function verificationOf(response) {
  const value = response?.verification;
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
/// <summary>The launcher's side channel: line 1 is the measured boundary, line 2 the exit.</summary>
function readSide(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    return { boundary: JSON.parse(lines[0]), completion: lines[1] ? JSON.parse(lines[1]) : null };
  } catch { return null; }
}

const secret = 'custody-key-material-' + crypto.randomUUID();
const nonce = crypto.randomUUID();
const pipeName = 'canary-broker-' + crypto.randomUUID();
const key = crypto.randomUUID().replace(/-/g, '');
let broker = null, listener = null, mediumPipe = null, serverPort = 0;
const listenerReady = path.join(relayDir, 'listener-ready');
const listenerJournal = path.join(relayDir, 'listener.jsonl');
const listenerEvents = () => fs.readFileSync(listenerJournal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const brokerLog = path.join(relayDir, 'broker.log');
const evidence = {
  at: new Date().toISOString(),
  scope: 'measurement harness, NOT a production provider; no elevation used',
  boundary: null, controls: null, arms: {}, acl: null, egress: null, conclusion: null
};

// ---- cleanup ---------------------------------------------------------------------------
function cleanup() {
  try { listener?.kill(); } catch { }
  try { broker?.kill(); } catch { }
  try { mediumPipe?.kill(); } catch { }
  // Remove the AppContainer profile; this probe created it, not a human.
  try { boundary('identity', ['--delete'], 120000); } catch { }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { }
  try { fs.rmSync(relayDir, { recursive: true, force: true }); } catch { }
}

const startedAt = Date.now();
try {
  fs.mkdirSync(work); fs.mkdirSync(store); fs.mkdirSync(target);
  fs.writeFileSync(path.join(store, 'custody-key-material.txt'), secret);
  fs.writeFileSync(path.join(store, 'review-artifact.bin'), 'enrolled-non-secret-body-' + nonce);
  fs.writeFileSync(path.join(target, 'promoted.bin'), 'base-target-content');
  fs.copyFileSync(fixture, path.join(work, 'caller.cjs'));
  fs.copyFileSync(process.execPath, path.join(work, 'node.exe'));
  fs.copyFileSync(path.join(repo, 'tooling/test-support/fixtures/confined-descendant.cjs'), path.join(work, 'descendant.cjs'));
  const caller = path.join(work, 'caller.cjs');
  // A deliberate escape link: the caller can create it, but must not read through it.
  fs.symlinkSync(store, path.join(work, 'escape'), 'junction');

  // Deterministic local listener: the control case for egress, not an Internet timeout.
  listener = spawn(process.execPath, [path.join(repo, 'tooling/test-support/fixtures/confined-listener.cjs'), listenerReady, listenerJournal],
    { windowsHide: true, stdio: 'ignore' });
  if (!await waitForFile(listenerReady, 5000)) throw new Error('independent listener did not become ready');
  serverPort = Number(fs.readFileSync(listenerReady, 'utf8'));

  // ---- establish the boundary (fail closed) -------------------------------------------
  const identityRecord = path.join(root, 'identity.json');
  const identity = boundary('identity', ['--record', identityRecord]);
  const identityText = fs.existsSync(identityRecord) ? fs.readFileSync(identityRecord, 'utf8') : '';
  evidence.boundary = { identity: identityText.trim(), exit: identity.code, output: identity.output.trim().split('\n').slice(-3) };
  const packageMatch = /"package":"(S-1-15-2-[0-9-]+)"/.exec(identityText);
  if (!packageMatch) {
    report('FAIL', 'boundary-established', `no AppContainer identity could be provisioned: ${identityText.trim() || identity.output.trim()}`);
    evidence.conclusion = 'FAIL-CLOSED: nothing else was measured';
    throw new Error('boundary not established');
  }
  const packageSid = packageMatch[1];
  report('PASS', 'boundary-identity-provisioned', `AppContainer package ${packageSid} (created by this probe, removed at cleanup)`);

  // Unrestricted positive control for the broker protocol: a plain user process. The broker
  // writes its log itself, so the probe needs no pipe to it.
  const pidFile = path.join(root, 'broker.pid');
  const brokerArgsFile = path.join(relayDir, 'broker-args.txt');
  fs.writeFileSync(brokerArgsFile, ['--pipe', pipeName, '--store', store, '--target', target, '--package', packageSid,
    '--key', key, '--ready', pidFile, '--log', brokerLog, '--identity',
    spawnSync('whoami.exe', [], { encoding: 'utf8' }).stdout.trim()].join('\r\n') + '\r\n');
  broker = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cli, '-Mode', 'broker',
    '@argv', brokerArgsFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });

  // The unrestricted positive control IS the first client: a plain user process. The broker
  // proves it is serving live callers by answering this one, so readiness comes from a real
  // exchange rather than from a file the broker wrote about itself. The pipe becomes reachable
  // some time after the broker starts listening, so this retries instead of racing it.
  const selfEvidence = path.join(work, 'self.json');
  let selfReport = null;
  const callerArgs = [caller, '--mode', 'hello', '--pipe', pipeName, '--package', packageSid,
    '--evidence', selfEvidence, '--nonce', nonce, '--work', work, '--root', root, '--store', store, '--target', target];
  const brokerDeadline = Date.now() + 40000;
  while (Date.now() < brokerDeadline) {
    fs.rmSync(selfEvidence, { force: true });
    const attempt = spawnSync(process.execPath, callerArgs, { windowsHide: true, cwd: work, timeout: 30000, encoding: 'utf8' });
    selfReport = readJson(selfEvidence);
    if (selfReport?.broker?.[0]?.response) break;
    evidence.controlCallerAttempts = (evidence.controlCallerAttempts || []).concat([{ status: attempt.status, error: selfReport?.error }]);
    await sleep(400);
  }
  if (!selfReport?.broker?.[0]?.response) {
    report('FAIL', 'broker-started', `broker never answered the unrestricted control caller: ${fs.existsSync(brokerLog) ? fs.readFileSync(brokerLog, 'utf8') : 'no log'}`);
    evidence.conclusion = 'FAIL-CLOSED: nothing else was measured';
    throw new Error('broker not ready');
  }
  report('PASS', 'broker-started-as-the-normal-user', `named pipe ${pipeName}, readiness proven by a live exchange`);

  // ---- control 3 mechanism: explicit deny ACE for the caller package SID --------------
  const aclResult = spawnSync('icacls.exe', [store, '/deny', `*${packageSid}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true });
  evidence.acl = { command: `icacls ${store} /deny *${packageSid}:(OI)(CI)F`, status: aclResult.status, output: aclResult.stdout };
  control('mechanism-deny-ace-written', aclResult.status === 0, `icacls exit ${aclResult.status}: ${aclResult.stdout.trim().split('\n').slice(-2).join(' ').trim()}`);

  evidence.arms.controlPipe = selfReport;
  const selfStatus = selfReport?.broker?.[0]?.response?.status;
  const selfVerification = verificationOf(selfReport?.broker?.[0]?.response);
  control('control-unrestricted-caller-is-not-the-confined-identity', selfStatus === 403,
    `an unrestricted caller reached the broker and was refused (status ${selfStatus})`);
  // The refusal is decided from the connection's token, not from anything the caller wrote:
  // this caller claimed the configured package SID and was still refused, with the broker
  // publishing the measured facts and the requirement it was measured against.
  attack('broker-refusal-ignores-the-caller-claim',
    selfVerification?.identityOk === false && selfVerification?.requiredPackage === packageSid &&
      selfVerification?.brokerSees?.appContainer === false && selfVerification?.brokerSees?.integrity !== 'S-1-16-4096',
    `caller claimed ${selfReport?.claimedPackage}; broker measured appContainer=${selfVerification?.brokerSees?.appContainer} integrity=${selfVerification?.brokerSees?.integrity} against required ${selfVerification?.requiredPackage}`);

  // ---- independent denial measurement of the ACL, outside the caller ------------------
  const reader = path.join(work, 'read-secret.ps1');
  fs.writeFileSync(reader, [
    'param([Parameter(Mandatory=$true)][string]$Path)',
    '# Exit 0 = readable, 9 = denied by the boundary, 1 = any other failure: never conflated.',
    'try { [void][System.IO.File]::ReadAllText($Path); exit 0 }',
    'catch [System.UnauthorizedAccessException] { exit 9 }',
    'catch [System.Security.SecurityException] { exit 9 }',
    'catch { exit 1 }',
    ''
  ].join('\r\n'));
  const readerCommand = [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', reader].join(' ');
  const sideAcl = path.join(root, 'side-acl.json');
  const aclArm = await confined([readerCommand, path.join(store, 'custody-key-material.txt')].join(' '), work, sideAcl, packageSid);
  const aclSide = readSide(sideAcl);
  evidence.arms.aclDenial = { exit: aclSide?.completion?.exit, launcherExit: aclArm.code, side: aclSide?.boundary, output: aclArm.output.trim().split('\n').slice(-3) };
  control('control-store-readable-without-the-boundary',
    spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', reader, path.join(store, 'custody-key-material.txt')], { windowsHide: true }).status === 0,
    'the unrestricted host reads the trusted store');
  attack('trusted-store-denied-to-the-confined-token', aclSide?.completion?.exit === 9,
    `confined reader exited ${aclSide?.completion?.exit} (9 = EACCES/EPERM); boundary measured in the same launch`);

  // ---- ARM A: unrestricted positive control ------------------------------------------
  const controlEvidence = path.join(work, 'control-evidence.json');
  const controlArm = spawnSync(process.execPath, [caller, '--mode', 'attacks', '--work', work, '--root', root, '--store', store,
    '--target', target, '--evidence', controlEvidence, '--nonce', nonce, '--port', String(serverPort), '--package', packageSid],
    { cwd: work, windowsHide: true, timeout: 120000, env: { ...process.env, CANARY_PROBE_NONCE: nonce, CANARY_CUSTODY_KEY: key } });
  const controlReport = readJson(controlEvidence);
  evidence.arms.control = controlReport;
  const controlAttempt = id => controlReport?.attempts?.find(a => a.id === id);
  const controlOk = controlArm.status === 0 && controlReport?.nonce === nonce && controlReport.attempts.length >= 7;
  control('control-unrestricted-caller-executed-all-attacks', controlOk,
    `exit ${controlArm.status}, ${controlReport?.attempts?.length ?? 0} attempts, nonce ${controlReport?.nonce === nonce ? 'match' : 'MISMATCH'}`);
  control('control-trusted-store-read-allowed', controlAttempt('trusted-store-read')?.result === 'ALLOWED',
    `unrestricted read of the trusted store = ${controlAttempt('trusted-store-read')?.result}`);
  control('control-promotion-target-write-allowed', controlAttempt('promotion-target-write')?.result === 'ALLOWED',
    `unrestricted write of the promotion target = ${controlAttempt('promotion-target-write')?.result}`);
  const controlConnections = listenerEvents();
  control('control-egress-reached-the-local-listener', controlAttempt('tcp-egress')?.result === 'CONNECTED' && controlConnections.length === 1,
    `unrestricted TCP to the live local listener = ${controlAttempt('tcp-egress')?.result}`);
  control('control-inherited-broker-secret-exposed', controlReport?.env?.hasBrokerKey === true,
    'an unrestricted caller does inherit CANARY_CUSTODY_KEY from its parent');
  const controlDescendant = readJson(path.join(work, 'descendant.json'));
  control('control-descendant-executed-and-escaped', controlDescendant?.nonce === nonce &&
    controlDescendant?.executed === true && controlDescendant?.result === 'ALLOWED', JSON.stringify(controlDescendant));
  fs.rmSync(path.join(work, 'descendant.json'), { force: true });
  // Restore anything the untouched-control arm changed in the trusted side.
  fs.writeFileSync(path.join(store, 'custody-key-material.txt'), secret);
  fs.writeFileSync(path.join(target, 'promoted.bin'), 'base-target-content');
  // Remove the control arm's own escape artefact so the confined arm's verdict cannot be
  // credited or blamed by a file another arm created.
  fs.rmSync(path.join(root, 'escaped-child.txt'), { force: true });
  fs.rmSync(path.join(work, 'escaped-child.txt'), { force: true });
  fs.rmSync(controlEvidence, { force: true });

  // ---- ARM B: confined caller, local attacks -----------------------------------------
  const confinedEvidence = path.join(work, 'confined-evidence.json');
  const sideB = path.join(root, 'side-b.json');
  const confinedArm = await confined(nodeCommand(caller, '--mode', 'attacks', '--work', work,
    '--root', root, '--store', store, '--target', target, '--evidence', confinedEvidence, '--nonce', nonce,
    '--port', String(serverPort), '--package', packageSid), work, sideB, packageSid);
  const side = readSide(sideB);
  evidence.arms.confinedLauncher = { exit: side?.completion?.exit, boundary: side?.boundary, output: confinedArm.output.trim().split('\n').slice(-4) };
  if (!side?.boundary || side.boundary.package !== packageSid || !side.boundary.appContainer || side.boundary.capabilities !== 0) {
    report('FAIL', 'boundary-measured-before-the-caller-ran', `launcher side channel: ${JSON.stringify(side)}`);
    throw new Error('boundary not established');
  }
  report('PASS', 'boundary-measured-before-the-caller-ran',
    `pid=${side.boundary.pid} appContainer=${side.boundary.appContainer} restricted=${side.boundary.restricted} capabilities=${side.boundary.capabilities} networkCapability=${side.boundary.networkCapability} integrity=${side.boundary.integrity}`);
  const confinedReport = readJson(confinedEvidence);
  evidence.arms.confined = confinedReport;
  const confinedAttempt = id => confinedReport?.attempts?.find(a => a.id === id);
  control('confined-caller-still-did-useful-work', confinedAttempt('work-write')?.result === 'ALLOWED' && confinedAttempt('work-read')?.result === 'ALLOWED',
    `inside the boundary: write=${confinedAttempt('work-write')?.result} read=${confinedAttempt('work-read')?.result}`);

  // control 3 — confidentiality / identity separation
  attack('confined-trusted-store-read-denied', ['EACCES', 'EPERM'].includes(confinedAttempt('trusted-store-read')?.result),
    `confined read = ${confinedAttempt('trusted-store-read')?.result}`);
  attack('confined-trusted-store-write-denied', ['EACCES', 'EPERM'].includes(confinedAttempt('trusted-store-write')?.result),
    `confined write = ${confinedAttempt('trusted-store-write')?.result}`);
  attack('confined-promotion-target-write-denied', ['EACCES', 'EPERM'].includes(confinedAttempt('promotion-target-write')?.result),
    `confined write to the promotion target = ${confinedAttempt('promotion-target-write')?.result}`);
  // The junction is a real escape attempt: the confined caller reads the trusted store
  // through a link that points straight at it.
  const junctionSidePath = path.join(root, 'side-junction.json');
  const junctionArm = await confined([readerCommand, path.join(work, 'escape', 'custody-key-material.txt')].join(' '),
    work, junctionSidePath, packageSid);
  const junctionSide = readSide(junctionSidePath);
  evidence.arms.junction = { exit: junctionSide?.completion?.exit, side: junctionSide?.boundary };
  control('control-junction-readable-without-the-boundary',
    spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', reader, path.join(work, 'escape', 'custody-key-material.txt')], { windowsHide: true }).status === 0,
    'the unrestricted host reads the trusted store through the junction');
  attack('confined-junction-escape-denied', junctionSide?.completion?.exit === 9,
    `confined read through the junction exited ${junctionSide?.completion?.exit} (9 = EACCES/EPERM)`);
  control('confined-broker-secret-not-inherited', confinedReport?.env?.hasBrokerKey === false,
    `CANARY_CUSTODY_KEY present in the confined caller's environment = ${confinedReport?.env?.hasBrokerKey}`);
  // Does a descendant escape? Answer from the filesystem, not from the caller's self-report.
  // The arm is disambiguated by content: the child writes this trial's nonce, and the
  // control arm's own escape file was removed before this arm ran.
  const escapedPath = path.join(root, 'escaped-child.txt');
  const escapedContent = fs.existsSync(escapedPath) ? fs.readFileSync(escapedPath, 'utf8') : null;
  const childAttempt = confinedAttempt('privileged-child');
  const childEvidence = readJson(path.join(work, 'descendant.json'));
  const escaped = escapedContent === nonce;
  evidence.controls = { ...evidence.controls, privilegedChild: { attempt: childAttempt, escapedFile: escapedContent } };
  if (childAttempt?.executed && JSON.parse(childAttempt.value || '{}').status === 0 &&
      childEvidence?.executed === true && childEvidence.nonce === nonce) {
    attack('confined-descendant-did-not-escape-the-boundary', !escaped && ['EPERM', 'EACCES'].includes(childEvidence.result),
      `descendant executed: ${JSON.stringify(childEvidence)}; escaped=${escaped}`);
  } else {
    inconclusive_('confined-descendant-did-not-escape-the-boundary', 'no executed descendant exit; absence of an escape file is not proof');
  }

  // control 4 — deterministic egress, decided by the local listener
  const egress = confinedAttempt('tcp-egress')?.result;
  const allConnections = listenerEvents();
  const listenerContacted = allConnections.length !== controlConnections.length;
  const listenerContactedControl = controlConnections.length === 1;
  evidence.egress = { control: controlAttempt('tcp-egress')?.result, confined: egress, port: serverPort,
    controlConnections, allConnections, restrictedAttemptExecuted: confinedAttempt('tcp-egress')?.executed };
  // Read the confined result verbatim: a code that is not a recognised denial is
  // INCONCLUSIVE, never a pass, and an attempted connection is a failure.
  if (egress === 'CONNECTED') {
    attack('confined-tcp-egress-denied', false, 'the confined caller reached the local listener');
  } else if (['EACCES', 'EPERM'].includes(egress) && confinedAttempt('tcp-egress')?.executed &&
      listenerContactedControl && !listenerContacted && side.boundary.appContainer &&
      side.boundary.restricted && side.boundary.capabilities === 0) {
    attack('confined-tcp-egress-denied', true, `confined result=${egress}; token capability measurement: networkCapability=${side.boundary.networkCapability}, capabilities=${side.boundary.capabilities}`);
  } else {
    inconclusive_('confined-tcp-egress-denied', `unexpected restricted result ${egress}`);
  }
  // Only the independently running trusted listener supplies contact evidence.

  // ---- ARM C: confined caller against the broker --------------------------------------
  fs.rmSync(confinedEvidence, { force: true });
  const sideC = path.join(root, 'side-c.json');
  const confinedPipeEvidence = path.join(work, 'confined-broker-evidence.json');
  const pipeArm = await confined(nodeCommand(caller, '--mode', 'broker', '--work', work,
    '--root', root, '--store', store, '--target', target, '--evidence', confinedPipeEvidence, '--nonce', nonce,
    '--pipe', pipeName, '--package', packageSid), work, sideC, packageSid);
  const pipeSide = readSide(sideC);
  const pipeReport = readJson(confinedPipeEvidence);
  evidence.arms.confinedBroker = { report: pipeReport, side: pipeSide?.boundary, exit: pipeSide?.completion?.exit };
  const step = id => pipeReport?.broker?.find(b => b.id === id);
  evidence.egress.nativeDiagnostic = verificationOf(step('network-diagnostic')?.response);
  const brokerSelf = verificationOf(step('broker-self')?.response);
  if (!pipeSide?.boundary || pipeSide.boundary.capabilities !== 0) {
    report('FAIL', 'confined-caller-reached-the-broker-under-the-boundary', 'no boundary measurement for the pipe arm');
  } else {
    report('PASS', 'confined-caller-reached-the-broker-under-the-boundary', `pid=${pipeSide.boundary.pid} capabilities=${pipeSide.boundary.capabilities} integrity=${pipeSide.boundary.integrity}`);
  }
  control('confined-caller-completed-the-broker-conversation', pipeSide?.completion?.exit === 0 && (pipeReport?.broker?.length ?? 0) >= 5,
    `caller exit ${pipeSide?.completion?.exit}, ${pipeReport?.broker?.length ?? 0} protocol exchanges`);

  // control 1 — the broker authenticates the caller from the connection, not from the claim
  const helloVerification = verificationOf(step('hello')?.response);
  control('broker-measured-the-caller-token-from-the-connection',
    helloVerification?.brokerSees?.package === packageSid && helloVerification?.brokerSees?.appContainer === true &&
      helloVerification?.brokerSees?.capabilities === 0,
    `brokerSees package=${helloVerification?.brokerSees?.package} appContainer=${helloVerification?.brokerSees?.appContainer} restricted=${helloVerification?.brokerSees?.restricted} capabilities=${helloVerification?.brokerSees?.capabilities} integrity=${helloVerification?.brokerSees?.integrity}`);
  control('caller-cannot-misdescribe-itself-to-the-broker',
    helloVerification?.packageMatchesClaim === true,
    `the confined caller claimed ${helloVerification?.clientClaimPackage}; the broker measured the same SID independently from the connection`);

  // Medium integrity alone does not deny a package-granted AppContainer. This
  // negative pipe omits the package allow grant; the normal-user grant remains.
  // Measure actual connections in both arms, not merely descriptor inspection.
  const mediumName = pipeName + '-medium';
  const mediumReady = path.join(relayDir, 'medium-ready');
  mediumPipe = spawn(shell, ['-NoProfile', '-NonInteractive', '-File',
    path.join(repo, 'tooling/test-support/fixtures/medium-pipe.ps1'), '-Pipe', mediumName,
    '-Package', packageSid, '-Ready', mediumReady, '-DenyPackage'], { windowsHide: true, stdio: 'ignore' });
  if (!await waitForFile(mediumReady, 5000)) throw new Error('medium-label control pipe did not start');
  const mediumEvidence = path.join(work, 'medium.json');
  const mediumArgs = [caller, '--mode', 'hello', '--pipe', mediumName, '--package', packageSid,
    '--evidence', mediumEvidence, '--nonce', nonce, '--work', work];
  const mediumControl = spawnSync(process.execPath, mediumArgs, { cwd: work, windowsHide: true, timeout: 10000 });
  control('medium-pipe-unrestricted-control', mediumControl.status === 0 && readJson(mediumEvidence)?.broker?.[0]?.response?.status === 200,
    'unrestricted connection to the same pipe succeeds');
  fs.rmSync(mediumEvidence, { force: true });
  const mediumSide = path.join(root, 'side-medium');
  await confined(nodeCommand(...mediumArgs), work, mediumSide, packageSid);
  const mediumResult = readJson(mediumEvidence);
  const mediumToken = readSide(mediumSide);
  evidence.arms.mediumPipe = { report: mediumResult, side: mediumToken, controlExit: mediumControl.status,
    descriptor: readJson(mediumReady) };
  attack('wrong-pipe-package-acl-refused', mediumToken?.boundary?.appContainer === true &&
    mediumToken?.completion?.exit === 3 && /pipe-connect (EPERM|EACCES)/.test(mediumResult?.error ?? ''),
    `confined client exit=${mediumToken?.completion?.exit}; error=${mediumResult?.error?.split('\n')[0]}`);

  // control 3 through the trusted path: the broker reads the trusted store with the CALLER's
  // access rights. This is a second, independent measurement of the same boundary.
  const impersonatedEvidence = path.join(work, 'impersonated-evidence.json');
  const sideImp = path.join(root, 'side-imp.json');
  const impersonatedCommand = nodeCommand(caller, '--mode', 'hello', '--verb', 'current', '--work', work,
    '--root', root, '--store', store, '--target', target, '--evidence', impersonatedEvidence, '--nonce', nonce,
    '--pipe', pipeName, '--package', packageSid);
  const impersonatedArm = await confined(impersonatedCommand, work, sideImp, packageSid);
  const impersonatedReport = readJson(impersonatedEvidence);
  const impersonatedSide = readSide(sideImp);
  const impersonated = impersonatedReport?.broker?.[0]?.response;
  evidence.arms.impersonated = {
    exit: impersonatedSide?.completion?.exit, response: impersonated, error: impersonatedReport?.error,
    rawEvidence: fs.existsSync(impersonatedEvidence) ? fs.readFileSync(impersonatedEvidence, 'utf8').slice(0, 600) : 'absent',
    command: impersonatedCommand, side: impersonatedSide?.boundary,
    launcher: impersonatedArm.output.trim().split('\n').slice(-8).join(' | ') || '(no launcher output)'
  };
  attack('broker-impersonated-read-of-the-trusted-store-denied',
    impersonated?.status === 403 && /refused|denied|UnauthorizedAccess/i.test(impersonated?.detail || ''),
    `broker read with the caller's access returned status ${impersonated?.status}: ${impersonated?.detail || impersonatedReport?.error}`);

  // control 2 — protected promotion
  const reviewedVerification = verificationOf(step('review')?.response);
  control('broker-reviewed-its-own-artifact-under-its-own-identity',
    !JSON.stringify(pipeReport).includes(secret) && !JSON.stringify(pipeReport).includes(key)
      && String(reviewedVerification?.receipt).startsWith('v2|'),
    `broker reviewed revision ${String(reviewedVerification?.receipt).split('|')[1]?.slice(0, 16)}… under its own token`);
  const forgedReceipt = verificationOf(step('promote-forged')?.response)?.receipt;
  attack('forged-receipt-rejected', forgedReceipt?.accepted === false && /custody/.test(forgedReceipt.reason || ''),
    `caller-minted receipt: ${JSON.stringify(forgedReceipt)}`);
  const mismatchReceipt = verificationOf(step('promote-mismatch')?.response)?.receipt;
  attack('body-substitution-rejected', mismatchReceipt?.accepted === false, `substituted body: ${JSON.stringify(mismatchReceipt)}`);
  attack('generic-signing-rejected', step('signature-request')?.response?.status === 403, 'arbitrary digest request executed');
  for (const id of ['promote-digest', 'promote-project', 'promote-candidate', 'promote-target', 'promote-replay']) {
    attack(id + '-rejected', step(id)?.ok === true && verificationOf(step(id)?.response)?.receipt?.accepted === false,
      'request executed over the authenticated confined pipe');
  }
  const receiptAttacks = ['promote-forged', 'promote-mismatch', 'promote-digest',
    'promote-project', 'promote-candidate', 'promote-target', 'promote-replay'];
  const protocolAttacks = [...receiptAttacks, 'signature-request'];
  evidence.protocolAttacks = {
    required: protocolAttacks.length,
    executed: protocolAttacks.filter(id => step(id)?.ok === true && step(id)?.response).length,
    blocked: receiptAttacks.filter(id => step(id)?.ok === true && verificationOf(step(id)?.response)?.receipt?.accepted === false).length
      + (step('signature-request')?.ok === true && step('signature-request')?.response?.status === 403 ? 1 : 0),
  };
  const validReceipt = verificationOf(step('promote-valid')?.response)?.receipt;
  control('broker-applied-a-verified-proposal-instead-of-the-caller',
    validReceipt?.accepted === true && validReceipt?.appliedBy === 'broker',
    `promotion verdict: ${JSON.stringify(validReceipt)}`);
  const promoted = fs.existsSync(path.join(target, 'promoted.bin')) ? fs.readFileSync(path.join(target, 'promoted.bin'), 'utf8') : null;
  control('promoted-bytes-came-from-broker-review', promoted === 'enrolled-non-secret-body-' + nonce,
    `the promotion target now holds the reviewed body (${promoted === null ? 'absent' : promoted === 'attacked' ? 'CALLER-WRITTEN BYTES' : 'broker-reviewed bytes'})`);

  // ---- the confinement controlled the caller, not the host ----------------------------
  const afterSidePath = path.join(root, 'side-after.json');
  const afterArm = await confined([readerCommand, path.join(store, 'custody-key-material.txt')].join(' '), work, afterSidePath, packageSid);
  const sideAfter = readSide(afterSidePath);
  evidence.after = { side: sideAfter?.boundary, exit: sideAfter?.completion?.exit, output: afterArm.output.trim().split('\n').slice(-3) };
  control('host-still-unconfined-after-the-caller-ran',
    spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', reader, path.join(store, 'custody-key-material.txt')], { windowsHide: true }).status === 0 && sideAfter?.boundary?.capabilities === 0,
    'the host reads the store and each new launch is freshly confined');
  // Did the earlier confined process actually cease?
  const gone = side?.boundary?.pid ? spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${side.boundary.pid} -ErrorAction SilentlyContinue; if ($p) { 'ALIVE' } else { 'GONE' }`], { encoding: 'utf8', windowsHide: true }).stdout.trim() : '';
  evidence.after.process = { pid: side?.boundary?.pid, state: gone };
  const confinedProcessGone = gone.endsWith('GONE');
  attack('confined-process-ceased', confinedProcessGone, `pid ${side?.boundary?.pid} after the arm: ${gone}`);

  // ---- THE PRODUCT MEASUREMENT RECORD ------------------------------------------------
  // Every control below is derived from the probe's OWN observations, through the
  // product's `deriveControl`, so the record cannot assert a control the battery did
  // not measure. The deployment is `complete` only when the whole battery passed AND
  // every deployment fact was observed.
  const controlFacts = [
    {
      control: 'authorityCustody',
      subject: 'the trusted store and the custody key, from the confined caller and through the broker',
      positiveControl: `an unrestricted caller inherits CANARY_CUSTODY_KEY (hasBrokerKey=${seen(controlReport?.env?.hasBrokerKey)}) and reads the trusted store (${seen(controlAttempt('trusted-store-read')?.result)})`,
      attack: `confined read=${seen(confinedAttempt('trusted-store-read')?.result)}, write=${seen(confinedAttempt('trusted-store-write')?.result)}, junction read exit ${seen(junctionSide?.completion?.exit)}, broker impersonated read status ${seen(impersonated?.status)}`,
      denial: (oneOf(confinedAttempt('trusted-store-read')?.result, ['EACCES', 'EPERM'])
        && oneOf(confinedAttempt('trusted-store-write')?.result, ['EACCES', 'EPERM'])
        && junctionSide?.completion?.exit === 9
        && impersonated?.status === 403
        && confinedReport?.env?.hasBrokerKey === false)
        ? 'the store carries a deny ACE for the caller package, so every confined read/write fails closed (EPERM/EACCES, detached reader exit 9) and the broker\'s impersonated read refuses with the caller\'s own access'
        : null,
      observed: {
        callerRead: seen(confinedAttempt('trusted-store-read')?.result),
        callerWrite: seen(confinedAttempt('trusted-store-write')?.result),
        junctionReadExit: junctionSide?.completion?.exit ?? null,
        brokerReadUnderCallerAccess: impersonated?.status ?? null,
        hasBrokerKeyInConfinedCaller: confinedReport?.env?.hasBrokerKey ?? null,
        hasBrokerKeyInControlCaller: controlReport?.env?.hasBrokerKey ?? null,
      },
    },
    {
      control: 'workerFilesystem',
      subject: 'the confined caller token, measured by the trusted launcher and independently by the broker',
      positiveControl: `the same caller code unrestricted writes and reads its work directory (write=${seen(controlAttempt('work-write')?.result)}, read=${seen(controlAttempt('work-read')?.result)})`,
      attack: `the confined caller performs the same work write/read (write=${seen(confinedAttempt('work-write')?.result)}, read=${seen(confinedAttempt('work-read')?.result)}) and attempts the trusted-store and promotion-target writes`,
      denial: (side?.boundary?.appContainer === true && side?.boundary?.restricted === true && side?.boundary?.capabilities === 0
        && side?.boundary?.networkCapability === false && side?.boundary?.integrity === 'S-1-16-4096' && side?.boundary?.package === packageSid
        && confinedAttempt('work-write')?.result === 'ALLOWED' && confinedAttempt('work-read')?.result === 'ALLOWED')
        ? `AppContainer ${packageSid} + restricted token + low integrity + zero capabilities: the kernel denies every path outside the sandbox while the caller still does useful work`
        : null,
      observed: {
        appContainer: side?.boundary?.appContainer ?? null,
        restricted: side?.boundary?.restricted ?? null,
        capabilities: side?.boundary?.capabilities ?? null,
        networkCapability: side?.boundary?.networkCapability ?? null,
        integrity: seen(side?.boundary?.integrity),
        package: seen(side?.boundary?.package),
        workWrite: seen(confinedAttempt('work-write')?.result),
        workRead: seen(confinedAttempt('work-read')?.result),
      },
    },
    {
      control: 'verificationSandbox',
      subject: 'candidate code launched only through the measured launcher, never as the broker',
      positiveControl: 'the unrestricted caller runs the identical workload outside the boundary, so the difference is the boundary and not the workload',
      attack: `the confined caller spawns a descendant that tries to write outside the boundary (${seen(childAttempt?.result)}) and the launcher's own fails-closed check runs before every resume`,
      denial: (held('boundary-measured-before-the-caller-ran') && confinedProcessGone && !escaped)
        ? 'the launcher measures the suspended child token and refuses to resume when the boundary is not established, and the kill-on-close job object reaps the descendant'
        : null,
      observed: {
        launcherMeasuredBoundary: side?.boundary?.sideChannel === true,
        failClosedBeforeResume: side?.boundary?.capabilities === 0 && held('boundary-measured-before-the-caller-ran'),
        descendantEscaped: escaped,
        confinedProcessCeased: confinedProcessGone,
        hostStillUnconfinedAfter: held('host-still-unconfined-after-the-caller-ran'),
      },
    },
    {
      control: 'authenticatedReview',
      subject: 'the broker authenticating the caller from the live connection token, never from the claim',
      positiveControl: `an unrestricted caller claiming the correct package SID reached the broker and was refused (status ${seen(selfStatus)})`,
      attack: `the confined caller claims its package SID over the pipe (status ${seen(step('hello')?.response?.status)}) while an unrestricted caller claims the SAME SID`,
      denial: (selfStatus === 403 && selfVerification?.identityOk === false
        && selfVerification?.requiredPackage === packageSid
        && selfVerification?.brokerSees?.appContainer === false
        && helloVerification?.brokerSees?.package === packageSid
        && helloVerification?.packageMatchesClaim === true)
        ? 'the broker impersonated the pipe client and measured the connection\'s token: appContainer/restricted/zero-capabilities/low-integrity required, so a claim that does not match the token is refused'
        : null,
      observed: {
        unrestrictedClaimStatus: selfStatus ?? null,
        unrestrictedIdentityOk: selfVerification?.identityOk ?? null,
        confinedClaimStatus: step('hello')?.response?.status ?? null,
        brokerSeesPackage: seen(helloVerification?.brokerSees?.package),
        packageMatchesClaim: helloVerification?.packageMatchesClaim ?? null,
        impersonatedReadStatus: impersonated?.status ?? null,
      },
    },
    {
      control: 'protectedPromotion',
      subject: 'the broker applying only a revision it reviewed under its own custody key',
      positiveControl: `the confined caller completes the broker conversation and obtains a review receipt (${String(reviewedVerification?.receipt ?? 'MISSING').slice(0, 12)}…)`,
      attack: `the confined caller forges a receipt (${seen(forgedReceipt?.reason)}), substitutes a body (${seen(mismatchReceipt?.reason)}) and submits a valid proposal`,
      denial: (forgedReceipt?.accepted === false && mismatchReceipt?.accepted === false
        && validReceipt?.accepted === true && validReceipt?.appliedBy === 'broker'
        && promoted === 'confined-promotion-body-' + nonce)
        ? 'the broker rejected a receipt not signed with its custody key and a body that did not match the reviewed revision, then wrote the verified body itself (appliedBy=broker)'
        : null,
      observed: {
        forgedAccepted: forgedReceipt?.accepted ?? null,
        forgedReason: seen(forgedReceipt?.reason),
        mismatchAccepted: mismatchReceipt?.accepted ?? null,
        validAccepted: validReceipt?.accepted ?? null,
        appliedBy: seen(validReceipt?.appliedBy),
        promotedMatchesReviewedBody: promoted === 'confined-promotion-body-' + nonce,
        reviewReceiptFromBroker: typeof reviewedVerification?.receipt === 'string' && String(reviewedVerification.receipt).startsWith('v1|'),
      },
    },
    {
      control: 'networkEgress',
      subject: 'the confined caller reaching a live local listener',
      positiveControl: `the unrestricted caller connected to the live listener on 127.0.0.1:${serverPort} (${seen(listenerContactedControl ? 'CONNECTED' : controlAttempt('tcp-egress')?.result)})`,
      attack: `the confined caller attempted the same TCP connection to 127.0.0.1:${serverPort}`,
      denial: (!listenerContacted && held('confined-tcp-egress-denied')
        && side?.boundary?.capabilities === 0 && side?.boundary?.networkCapability === false)
        ? 'the token carries zero capabilities and no internetClient capability, so the connection timed out without the listener ever being contacted'
        : null,
      observed: {
        controlEgress: seen(controlAttempt('tcp-egress')?.result),
        confinedEgress: seen(egress),
        capabilities: side?.boundary?.capabilities ?? null,
        networkCapability: side?.boundary?.networkCapability ?? null,
        listenerContactedByConfined: listenerContacted,
        liveListenerPort: serverPort,
      },
    },
  ];

  const facts = {
    // Every entry under `required` was OBSERVED true, and a deployment with any of
    // them false fails closed. The four values that follow are REPORTED rather than
    // required: they are the honest ceiling of this deployment (see
    // docs/V1.2-CONFINED-CALLER.md), and hiding them inside "complete" would be the
    // overclaim this project exists to prevent.
    required: {
      brokerOwnsKeyMaterial: fs.existsSync(path.join(store, 'custody-key-material.txt')),
      brokerNeverRunsCallerWork: held('confined-caller-reached-the-broker-under-the-boundary') && side?.boundary?.appContainer === true,
      promotionPerformedByBroker: validReceipt?.appliedBy === 'broker',
      callerConfinementMeasured: side?.boundary?.appContainer === true && side?.boundary?.restricted === true
        && side?.boundary?.capabilities === 0 && side?.boundary?.package === packageSid,
      brokerIdentityReported: brokerSelf?.identity !== null && brokerSelf?.identity !== undefined,
    },
    separateBrokerIdentity: brokerSelf?.identity !== null && brokerSelf?.identity !== undefined && brokerSelf.identity !== callerIdentity,
    brokerIdentity: seen(brokerSelf?.identity),
    brokerAccountIsCaller: brokerSelf?.identity !== null && brokerSelf?.identity !== undefined && brokerSelf.identity === callerIdentity,
    brokerName: seen(brokerSelf?.name),
    callerIdentity: seen(callerIdentity),
    callerName: seen(callerName),
  };
  const deploymentFailures = [];
  for (const [name, value] of Object.entries(facts.required)) if (value !== true) deploymentFailures.push(`the required deployment fact "${name}" was not observed`);
  if (fail > 0 || inconclusive > 0) deploymentFailures.push(`the battery itself reported ${fail} fail and ${inconclusive} inconclusive`);
  const controls = CM.completeControls(controlFacts);
  const record = {
    schema: 'canary-confined-measurement/1',
    source: 'tooling/probes/v12-confined-caller.mjs',
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    host: { hostname: os.hostname(), user: seen(process.env.USERNAME) },
    storeRoot: store,
    callerPackage: packageSid,
    broker: {
      identity: seen(brokerSelf?.identity),
      name: seen(brokerSelf?.name),
      isSystem: brokerSelf?.isSystem === true,
    },
    tools: { digest: CM.toolsDigest() ?? 'MISSING', files: [...CM.CONFINED_TOOL_PATHS] },
    corpus: { corpus: 'tooling/test-support/fixtures/confined-caller.cjs', digest: crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'), files: 1 },
    battery: { pass, fail, inconclusive, durationMs: Date.now() - startedAt },
    deployment: { complete: deploymentFailures.length === 0, failures: deploymentFailures, facts },
    controls,
  };
  try {
    const written = CM.writeConfinedMeasurement(record, store);
    const state = CM.readConfinedMeasurement(store, {});
    evidence.productMeasurement = {
      path: written, controls: controls.map(c => ({ control: c.control, available: c.available })),
      deployment: record.deployment, validation: { valid: state.valid, reason: state.reason, ageMs: state.ageMs },
    };
    const ready = state.valid && controls.every(c => c.available);
    report(ready ? 'PASS' : 'FAIL', 'product-measurement-record-written-and-validates',
      `${written} — ${controls.filter(c => c.available).length}/6 controls derived, deployment complete=${record.deployment.complete}, product validation: ${state.reason}`);
  } catch (error) {
    report('FAIL', 'product-measurement-record-written-and-validates', `the record could not be produced: ${String(error?.message || error)}`);
  }
} catch (error) {
  console.error(`FAIL harness: ${error.stack}`);
  evidence.harnessError = String(error.stack);
  fail++;
} finally {
  // Keep the broker's own record: it is the trusted side's account of who called and what it
  // answered, and it is only readable while the run's directories still exist.
  try { evidence.brokerLog = fs.existsSync(brokerLog) ? fs.readFileSync(brokerLog, 'utf8').split('\n').slice(-40) : null; } catch { }
  cleanup();
  evidence.summary = { pass, fail, inconclusive, lines };
  evidence.conclusion = fail === 0 && inconclusive === 0
    ? 'ALL FOUR CONTROLS OBSERVED WITH AN UNRESTRICTED POSITIVE CONTROL AND A REAL RESTRICTED ATTACK; the six product controls were derived from them'
    : `NOT COMPLETE: ${pass} pass, ${fail} fail, ${inconclusive} inconclusive`;
  try { fs.writeFileSync(path.join(os.tmpdir(), 'v12-confined-caller.json'), JSON.stringify(evidence, null, 2)); } catch { }
  console.log('-'.repeat(70));
  console.log(evidence.conclusion);
  console.log(`Broker protocol attacks: ${JSON.stringify(evidence.protocolAttacks ?? { required: 8, executed: 0, blocked: 0 })}`);
  console.log(`observations: ${path.join(os.tmpdir(), 'v12-confined-caller.json')}`);
  process.exitCode = fail === 0 && inconclusive === 0 && lines.length > 0 ? 0 : 1;
}
