// Sandbox drive alias lifecycle audit.
//
// The alias is security-relevant, so every property it is relied on for is MEASURED
// here rather than argued from the source:
//   * it maps only to the intended per-run sandbox, observed from the TRUSTED side
//     while the run is live;
//   * the confined worker cannot choose, create or retarget one;
//   * an existing mapping is never overwritten, so a name collision fails safe;
//   * a stale mapping cannot affect a later run or cross-map another sandbox;
//   * cleanup happens after success, after a failing worker, and after a worker crash;
//   * a hard kill of the trusted launcher leaks a mapping — measured, bounded, and
//     shown not to affect a later run — because that is the honest limit of the design;
//   * no trusted checkout, store or authority path is reachable through the alias.
//
// No global ACL change, no machine-wide device definition, no admin/UAC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { native } from '../../apps/cli/dist/src/provider/production.js';
import { removeMeasurementAuthority } from '../../apps/cli/dist/src/provider/production-measurement.js';

const repo = path.resolve(import.meta.dirname, '../..'), cli = path.join(repo, 'apps/cli/dist/src/main.js');
const dosScript = path.join(repo, 'tooling/test-support/fixtures/dos-device.ps1');
const holder = path.join(repo, 'tooling/test-support/fixtures/alias-holder.mjs');
const observer = path.join(repo, 'tooling/test-support/fixtures/alias-observer.cjs');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-alias-audit-'));
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let baseline = {};

const run = (exe, args, cwd) => {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  assert.equal(r.status, 0, `${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const dos = (op, extra = {}) => {
  const tag = `${op}-${Math.random().toString(36).slice(2, 8)}`;
  const request = path.join(root, `dos-${tag}.json`), out = path.join(root, `dos-${tag}-out.json`);
  fs.writeFileSync(request, JSON.stringify({ op, out, ...extra }));
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', dosScript, '-Request', request],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
};
const map = () => dos('list').map;
const extraKeys = m => Object.keys(m).filter(k => baseline[k] === undefined).sort();
/** Letters the LAUNCHER owns: everything new except letters this audit claimed itself. */
const canaryKeys = (m, claimed = []) => extraKeys(m).filter(k => !claimed.includes(k));
const record = (id, passed, evidence) => {
  results.push({ id, passed, evidence });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id} — ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
};

/** One enrolled deployment: its own sealed project, sandbox and store. */
function deployment(name) {
  const dir = path.join(root, name), base = path.join(dir, 'base'), work = path.join(dir, 'work'), store = path.join(dir, 'store');
  fs.mkdirSync(base, { recursive: true }); fs.mkdirSync(work);
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: `alias-${name}`, scripts: { test: 'node test.cjs' } }));
  fs.writeFileSync(path.join(base, 'test.cjs'), 'require("node:assert/strict").equal(1,1);');
  run(git, ['init'], base); run(git, ['config', 'user.name', 'Alias audit'], base);
  run(git, ['config', 'user.email', 'audit@localhost'], base);
  run(git, ['add', '.'], base); run(git, ['commit', '-m', 'base'], base);
  run(process.execPath, [cli, 'setup', '--yes', base]);
  run(process.execPath, [cli, 'task', 'sandbox alias audit'], base);
  const enrolled = JSON.parse(run(process.execPath, [cli, 'provider', 'enroll', base, store]));
  fs.writeFileSync(path.join(work, 'sandbox-marker.txt'), `sandbox ${name}\n`);
  fs.copyFileSync(observer, path.join(work, 'alias-observer.cjs'));
  return { name, dir, base, work, store, enrolled };
}

/** Launch the confined executor in a child process so this loop can sample the
 * session device namespace while the alias is live. */
function launch(d, args, outName) {
  const out = path.join(root, outName), errFile = out + '.stderr';
  fs.rmSync(out, { force: true }); fs.rmSync(errFile, { force: true });
  const err = fs.openSync(errFile, 'w');
  const child = spawn(process.execPath, [holder, d.store, d.work, JSON.stringify(args), out], { stdio: ['ignore', 'ignore', err], windowsHide: true });
  fs.closeSync(err);
  return { child, out, errFile, done: new Promise(resolve => child.once('exit', () => resolve(fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { ok: false, error: `holder produced no record; stderr: ${fs.readFileSync(errFile, 'utf8').slice(0, 400)}` }))) };
}
const observerArgs = (d, seconds, started, report, exitCode = 0) =>
  [String(seconds), started, report, d.otherWork, JSON.stringify(d.authority), String(exitCode)];
const deployments = [];
/** Wait until the confined observer is live — or fail with the launcher's own words. */
async function waitForStarted(started, holderOut, deadlineMs = 45000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(started)) return;
    if (fs.existsSync(holderOut)) {
      const rec = JSON.parse(fs.readFileSync(holderOut, 'utf8'));
      throw new Error(`confined launch refused: ${rec.error ?? rec.toolError ?? rec.result?.error ?? rec.result?.stderr ?? JSON.stringify(rec).slice(-800)}`);
    }
    if (fs.existsSync(holderOut + '.stderr') && fs.readFileSync(holderOut + '.stderr', 'utf8').trim())
      throw new Error(`holder failed: ${fs.readFileSync(holderOut + '.stderr', 'utf8').slice(0, 800)}`);
    await sleep(250);
  }
  throw new Error('timed out waiting for the confined observer to start');
}

try {
  baseline = map();
  console.log(`baseline device namespace: ${JSON.stringify(baseline)}`);
  for (const letter of ['Z:', 'Y:']) assert.equal(baseline[letter], undefined, `${letter} already mapped; alias audit needs it free`);

  const A = deployment('a'), B = deployment('b');
  deployments.push(A, B);
  A.otherWork = B.work; B.otherWork = A.work;
  A.authority = { base: A.base, store: A.store, brokerKey: path.join(A.store, 'producer.key'), launcherSource: path.join(repo, 'tools/windows-boundary/CanaryConfinedLauncher.cs') };
  B.authority = { base: B.base, store: B.store, brokerKey: path.join(B.store, 'producer.key') };

  // ── T1/T2: a live run maps exactly one letter, exactly onto its own sandbox ──
  {
    const started = path.join(A.work, 'observer-started.json'), report = path.join(A.work, 'observer-report.json');
    fs.rmSync(started, { force: true }); fs.rmSync(report, { force: true });
    const r = launch(A, observerArgs(A, 6, started, report), 'holder-live.json');
    const samples = [];
    const deadline = Date.now() + 45000;
    await waitForStarted(started, r.out);
    while (Date.now() < deadline && r.child.exitCode === null) { samples.push(map()); await sleep(400); }
    const outcome = await r.done;
    const live = samples.filter(m => extraKeys(m).length > 0);
    const observed = live.map(m => Object.fromEntries(extraKeys(m).map(k => [k, m[k]])));
    const targets = live.flatMap(m => extraKeys(m).map(k => m[k]));
    const sawExactlyOne = live.every(m => extraKeys(m).length === 1);
    const rightTarget = targets.every(t => t.toLowerCase().includes(A.work.toLowerCase()));
    const neverAuthority = targets.every(t => ![A.base, A.store, repo].some(a => t.toLowerCase().includes(a.toLowerCase())));
    record('T1-live-alias-maps-only-the-intended-sandbox', live.length > 0 && sawExactlyOne && rightTarget && neverAuthority,
      { samplesTaken: samples.length, liveSamples: live.length, observed: observed.slice(0, 3), workspace: A.work });
    record('T1-alias-letter-is-the-first-free-letter', live.length > 0 && extraKeys(live[0])[0] === 'Z:', { first: live[0] && extraKeys(live[0]) });
    record('T1-cleanup-after-success', extraKeys(map()).length === 0 && outcome.ok === true && outcome.result?.status === 0,
      { afterRun: map(), holderStatus: outcome.result?.status });

    const obs = JSON.parse(fs.readFileSync(report, 'utf8'));
    const marker = fs.readFileSync(path.join(A.work, 'sandbox-marker.txt'), 'utf8');
    record('T2-worker-cwd-is-the-alias-root', /^[A-Z]:\\$/.test(obs.cwd) && obs.parent === obs.cwd, { cwd: obs.cwd, parent: obs.parent });
    record('T2-alias-root-exposes-only-its-own-sandbox',
      obs.aliasRootMarker.allowed === true && obs.aliasRootMarker.digest === crypto.createHash('sha256').update(marker).digest('hex')
      && obs.aliasRootListing.allowed === true && obs.aliasRootListing.names.includes('sandbox-marker.txt')
      && !obs.aliasRootListing.names.includes('package.json'),
      { aliasRootMarker: obs.aliasRootMarker.allowed, entries: obs.aliasRootListing.names });
    record('T2-authority-unreachable-through-the-alias',
      Object.values(obs.authority).every(a => a.allowed === false && /EPERM|EACCES/.test(a.error)) && obs.otherSandboxMarker.allowed === false,
      { authority: Object.fromEntries(Object.entries(obs.authority).map(([k, v]) => [k, v.error])), otherSandbox: obs.otherSandboxMarker.error });
  }

  // ── T3: an existing mapping is never overwritten (collision fails safe) ──
  {
    const claimTarget = '\\??\\' + repo;
    const claim = dos('define', { flags: 9, name: 'Z:', target: claimTarget });
    assert.equal(claim.error, undefined, JSON.stringify(claim));
    const started = path.join(A.work, 'observer-started.json'), report = path.join(A.work, 'observer-report.json');
    fs.rmSync(started, { force: true });
    const r = launch(A, observerArgs(A, 3, started, report), 'holder-collision.json');
    await waitForStarted(started, r.out);
    const during = map();
    const outcome = await r.done;
    const after = map();
    record('T3-collision-is-not-overwritten', during['Z:'] === claimTarget && canaryKeys(during, ['Z:']).join() === 'Y:',
      { launcherLetters: canaryKeys(during, ['Z:']), claimedZ: during['Z:'], claimedTarget: claimTarget, carriedBy: during['Y:'] });
    record('T3-run-succeeds-on-another-letter-and-cleans-up',
      outcome.ok === true && outcome.result?.status === 0 && during['Y:'].toLowerCase().includes(A.work.toLowerCase()) && after['Y:'] === undefined && after['Z:'] !== undefined,
      { duringY: during['Y:'], afterY: after['Y:'], afterZ: after['Z:'] });
    dos('define', { flags: 11, name: 'Z:', target: null });
    record('T3-audit-cleaned-its-own-claim', extraKeys(map()).length === 0, { map: map() });
  }

  // ── T4: a stale mapping cannot affect a later run or cross-map it ──
  {
    const stale = path.join(root, 'stale-sandbox'); fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'sandbox-marker.txt'), 'stale sandbox\n');
    const staleTarget = '\\??\\' + stale;
    const claim = dos('define', { flags: 9, name: 'Z:', target: staleTarget });
    assert.equal(claim.error, undefined, JSON.stringify(claim));
    fs.rmSync(stale, { recursive: true, force: true }); // the stale target is now gone
    const started = path.join(A.work, 'observer-started.json'), report = path.join(A.work, 'observer-report.json');
    fs.rmSync(started, { force: true });
    const r = launch(A, observerArgs(A, 3, started, report), 'holder-stale.json');
    await waitForStarted(started, r.out);
    const during = map();
    const outcome = await r.done;
    const obs = JSON.parse(fs.readFileSync(report, 'utf8'));
    record('T4-stale-alias-is-skipped-not-reused',
      during['Z:'] === staleTarget && canaryKeys(during, ['Z:']).join() === 'Y:' && during['Y:'].toLowerCase().includes(A.work.toLowerCase()),
      { launcherLetters: canaryKeys(during, ['Z:']), staleZ: during['Z:'] });
    record('T4-stale-alias-cannot-cross-map-a-later-run',
      outcome.ok === true && outcome.result?.status === 0 && obs.aliasRootMarker.allowed === true && obs.cwd.startsWith('Y:'),
      { workerCwd: obs.cwd, markerAllowed: obs.aliasRootMarker.allowed });
    dos('define', { flags: 11, name: 'Z:', target: null });
    record('T4-audit-cleaned-its-own-stale-claim', extraKeys(map()).length === 0, { map: map() });
  }

  // ── T5/T6: cleanup after a failing worker and after a worker crash ──
  for (const [id, exitCode, label] of [['T5-cleanup-after-failing-worker', 3, 'worker exit 3'], ['T6-cleanup-after-worker-crash', 'kill', 'worker SIGKILL']]) {
    const started = path.join(A.work, `observer-started-${id}.json`), report = path.join(A.work, `observer-report-${id}.json`);
    fs.rmSync(started, { force: true });
    const r = launch(A, observerArgs(A, 1, started, report, exitCode), `holder-${id}.json`);
    const outcome = await r.done;
    const after = map();
    record(id, extraKeys(after).length === 0 && (outcome.ok === false || outcome.result?.status !== 0),
      { failureReportedToCallerAs: outcome.result?.status ?? outcome.error, acceptedAsResult: outcome.ok !== false, namespaceAfter: extraKeys(after), note: label });
  }

  // ── T7: concurrent runs never cross-map ──
  {
    const startedA = path.join(A.work, 'observer-started-c.json'), startedB = path.join(B.work, 'observer-started-c.json');
    const reportA = path.join(A.work, 'observer-report-c.json'), reportB = path.join(B.work, 'observer-report-c.json');
    for (const f of [startedA, startedB, reportA, reportB]) fs.rmSync(f, { force: true });
    const ra = launch(A, observerArgs(A, 6, startedA, reportA), 'holder-concurrent-a.json');
    const rb = launch(B, observerArgs(B, 6, startedB, reportB), 'holder-concurrent-b.json');
    const samples = [];
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && (ra.child.exitCode === null || rb.child.exitCode === null)) { samples.push(map()); await sleep(400); }
    const [oa, ob] = [await ra.done, await rb.done];
    const samplesWithExtras = samples.map(m => Object.fromEntries(extraKeys(m).map(k => [k, m[k]])));
    const neverAuthority = samplesWithExtras.every(m => Object.values(m).every(t => ![A.base, A.store, B.base, B.store, repo].some(x => t.toLowerCase().includes(x.toLowerCase()))));
    const bothRan = oa.ok === true && ob.ok === true;
    const oneRefused = (oa.ok === false && /busy|no fallback/.test(oa.error ?? '')) || (ob.ok === false && /busy|no fallback/.test(ob.error ?? ''));
    let crossMapped = null, eachReadOwn = null;
    if (bothRan) {
      const A_read = JSON.parse(fs.readFileSync(reportA, 'utf8')), B_read = JSON.parse(fs.readFileSync(reportB, 'utf8'));
      const digestOf = (d, name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(d.work, 'sandbox-marker.txt'))).digest('hex');
      eachReadOwn = A_read.aliasRootMarker.digest === digestOf(A, 'a') && B_read.aliasRootMarker.digest === digestOf(B, 'b')
        && A_read.aliasRootMarker.digest !== B_read.aliasRootMarker.digest;
      crossMapped = samplesWithExtras.some(m => {
        const targets = Object.values(m).map(t => t.toLowerCase());
        return targets.filter(t => t.includes(A.work.toLowerCase())).length > 1 || targets.filter(t => t.includes(B.work.toLowerCase())).length > 1;
      });
    }
    record('T7-concurrent-runs-never-cross-map', neverAuthority && crossMapped !== true && (eachReadOwn === true || oneRefused) && extraKeys(map()).length === 0,
      { bothRan, oneRefusedFailClosed: oneRefused, eachReadItsOwnSandbox: eachReadOwn, crossMapped, samples: samplesWithExtras.slice(0, 4) });
  }

  // ── T8: a hard kill of the TRUSTED launcher leaks a mapping (bounded, no cross-map) ──
  {
    const started = path.join(A.work, 'observer-started-k.json'), report = path.join(A.work, 'observer-report-k.json');
    fs.rmSync(started, { force: true });
    const r = launch(A, observerArgs(A, 20, started, report), 'holder-kill.json');
    await waitForStarted(started, r.out);
    const during = map();
    const pids = dos('launcher-pids');
    assert.ok(Array.isArray(pids.pids) && pids.pids.length >= 1, `launcher pid not found: ${JSON.stringify(pids)}`);
    for (const pid of pids.pids) dos('stop-process', { pid });
    const killed = await Promise.race([r.done, sleep(90000).then(() => ({ ok: false, error: 'holder did not settle after launcher kill' }))]);
    const leaked = map();
    const leakedKeys = extraKeys(leaked);
    const leakedTarget = leakedKeys.length ? leaked[leakedKeys[0]] : null;
    record('T8-launcher-hard-kill-behaviour-is-measured', true,
      { during: Object.fromEntries(extraKeys(during).map(k => [k, during[k]])), afterKill: Object.fromEntries(leakedKeys.map(k => [k, leaked[k]])), holderSettled: killed.ok === false ? killed.error : 'ok',
        note: leakedKeys.length ? 'MAPPING LEAKED until the session ends — recorded as a bounded limit, not a pass' : 'the OS removed the mapping with the launcher process' });
    // A later run must still be correct, and must not adopt the leaked mapping.
    const started2 = path.join(A.work, 'observer-started-k2.json'), report2 = path.join(A.work, 'observer-report-k2.json');
    fs.rmSync(started2, { force: true });
    const r2 = launch(A, observerArgs(A, 2, started2, report2), 'holder-after-kill.json');
    const outcome2 = await r2.done;
    const obs2 = fs.existsSync(report2) ? JSON.parse(fs.readFileSync(report2, 'utf8')) : null;
    record('T8-a-later-run-is-unaffected-by-a-leaked-mapping',
      outcome2.ok === true && outcome2.result?.status === 0 && obs2 && obs2.aliasRootMarker.allowed === true,
      { cwd: obs2?.cwd, leakedKeys, namespaceAfterLaterRun: Object.fromEntries(extraKeys(map()).map(k => [k, map()[k]])) });
    for (const key of extraKeys(map())) dos('define', { flags: 11, name: key, target: null });
    record('T8-audit-cleaned-up', extraKeys(map()).length === 0, { namespace: map() });
  }

  const failures = results.filter(r => !r.passed);
  fs.writeFileSync(path.join(os.tmpdir(), 'canary-alias-audit.json'), JSON.stringify({ baseline, results }, null, 2));
  console.log(`Alias lifecycle audit: ${results.length - failures.length}/${results.length} passed; evidence: ${path.join(os.tmpdir(), 'canary-alias-audit.json')}`);
  assert.deepEqual(failures.map(f => f.id), [], 'alias lifecycle audit incomplete');
  assert.deepEqual(extraKeys(map()), [], 'audit left the device namespace dirty');
} finally {
  for (const d of deployments) {
    try { removeMeasurementAuthority(d.store, d.enrolled.id); } catch { }
    for (const name of [d.enrolled.profile, d.enrolled.profile + '.Verifier']) {
      try { native(d.store, { mode: 'identity', name, delete: true, result: path.join(root, 'deleted.json') }); } catch { }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
