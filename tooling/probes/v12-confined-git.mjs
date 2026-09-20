// Confined-Git escape battery driver.
//
// Every vector is executed TWICE against identical bytes: once unrestricted (the
// positive control that proves the vector actually escapes) and once through the
// real production confined executor. Every execution terminates in exactly one of
// BLOCKED / SUCCESS / INCONCLUSIVE:
//
//   SUCCESS      the confined run produced the escape signal — the vector's own
//                output, the helper's side effect OUTSIDE the sandbox, a read the
//                boundary should have denied, or a change the TRUSTED side observes
//                in the session device map. A finding, never a pass.
//   BLOCKED      the vector ran, terminated on its own, produced no escape signal,
//                and the denial is attributable — the vector reported a permission
//                denial, or the confined process independently failed to read the
//                very path (or create the very mapping) the vector needed.
//   INCONCLUSIVE everything else, INCLUDING a timeout, a vector that never ran, or a
//                control that never escaped. A timeout is never a blocked attack.
//
// `--controls` runs only the unrestricted pass and prints which vectors fire. It is a
// vector-development aid: it prints no security verdict and exits 0 unconditionally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { productionTool, native } from '../../apps/cli/dist/src/provider/production.js';
import { removeMeasurementAuthority } from '../../apps/cli/dist/src/provider/production-measurement.js';

const repo = path.resolve(import.meta.dirname, '../..'), cli = path.join(repo, 'apps/cli/dist/src/main.js');
const worker = path.join(repo, 'tooling/test-support/fixtures/git-escape-worker.cjs');
const dosScript = path.join(repo, 'tooling/test-support/fixtures/dos-device.ps1');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const controlsOnly = process.argv.includes('--controls');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-confined-git-'));
const base = path.join(root, 'base'), work = path.join(root, 'work'), template = path.join(root, 'template');
const outside = path.join(root, 'outside'), helpers = path.join(outside, 'helpers'), store = path.join(root, 'store');
const slash = p => p.replaceAll('\\', '/');
const DENIED = /permission denied|access is denied|EPERM|EACCES|operation not permitted/i;
const rowOf = (rows, id) => rows.find(r => r.id === id);
const deniedBy = row => !!row && row.allowed === false && DENIED.test(String(row.error ?? ''));
const rowText = row => `${row?.stderr ?? ''}${row?.error ?? ''}${row?.stdout ?? ''}`;
const readSignal = id => ctx => ctx.row?.kind === 'read' ? ctx.row.allowed === true : ctx.row?.escaped === true || ctx.markers.has(id);
const helperSignal = id => ctx => ctx.row?.escaped === true || ctx.markers.has(id);
// A work-tree listing is proof of an outside read only when it names a file that
// exists OUTSIDE the sandbox and nowhere inside it.
const listingSignal = ctx => ctx.row?.status === 0 && /ESCAPE_CANARY_UNTRACKED/.test(ctx.row.stdout ?? '');
const mapSignal = (letter, expect) => ctx => {
  const now = ctx.devices[letter], before = ctx.before[letter];
  if (now === undefined) return false;
  if (expect === 'absent') return false;
  return now !== before;
};

/** Vectors that MUST be denied. `attribution` names confined READBACKS that explain a
 * denial; the readbacks are re-executed inside every batch, so attribution is always
 * same-run evidence. */
const ESCAPE_VECTORS = {
  reads: {
    'absolute-checkout': { attribution: ['rb-outside-secret'] },
    'parent-traversal': { attribution: ['rb-outside-secret'] },
    junction: { attribution: ['rb-outside-secret'] },
    'proof-authority': { attribution: ['rb-store-listing'] },
    'broker-key': { attribution: ['rb-store-listing'] },
    'extended-path': { attribution: ['rb-outside-secret'] },
    'outside-secret': { attribution: [] },
    'outside-git-config': { attribution: [] },
    'outside-listing': { attribution: [] },
    'store-listing': { attribution: [] },
    'trusted-checkout-listing': { attribution: [] },
    'trusted-launcher-source': { attribution: ['rb-trusted-checkout-listing'] },
    'trusted-checkout-config': { attribution: ['rb-trusted-checkout-listing'] },
    'nt-device-path': { attribution: ['rb-outside-secret'] },
    'short-name-path': { attribution: ['rb-outside-secret'] },
    // Reachability of a UNC path requires the network capability; the measured token
    // has none, which is the boundary that denies it.
    'unc-path': { attribution: [], network: true },
    'drive-relative': { attribution: ['rb-outside-secret'] },
    'descendant-node': { attribution: [] },
    'descendant-cmd': { attribution: ['rb-outside-secret'] },
  },
  'git-paths': {
    'git-C': { attribution: ['rb-outside-listing'] },
    'git-C-slash': { attribution: ['rb-outside-listing'] },
    'git-dir': { attribution: ['rb-outside-git-config'] },
    'git-dir-config': { attribution: ['rb-outside-git-config'] },
    GIT_DIR: { attribution: ['rb-outside-git-config'] },
    'git-dir-work-tree': { attribution: ['rb-outside-git-config'], signal: listingSignal },
    GIT_WORK_TREE: { attribution: ['rb-outside-listing'], signal: listingSignal },
    GIT_OBJECT_DIRECTORY: { attribution: ['rb-outside-listing'] },
    'alternate-objects': { attribution: ['rb-outside-listing'] },
    'include.path': { attribution: ['rb-outside-secret'] },
    includeIf: { attribution: ['rb-outside-secret'] },
    'core.worktree-status': { attribution: ['rb-outside-listing'], signal: listingSignal },
  },
  'git-exec': Object.fromEntries(['hooksPath-hookrun', 'hooksPath-commit', 'external-diff', 'GIT_EXTERNAL_DIFF', 'textconv',
    'filter-clean', 'fsmonitor', 'editor', 'sshCommand', 'gpgProgram'].map(id => [id, { attribution: ['rb-helper-listing'], signal: helperSignal(id) }])),
  alias: {
    'subst-create-y-trusted': { attribution: ['rb-trusted-checkout-listing'], signal: ctx => ctx.devices['Y:'] !== undefined },
    'alias-created-read': { attribution: ['rb-trusted-checkout-listing'], control: ['reads', 'trusted-checkout-listing'] },
    'subst-create-w-outside': { attribution: ['rb-outside-secret'], signal: ctx => ctx.devices['W:'] !== undefined },
    'alias-outside-read': { attribution: ['rb-outside-secret'], control: ['reads', 'outside-secret'] },
  },
  'alias-retarget-cwd': {
    // The confined process's own cwd IS the live alias root. If the alias does not
    // point at the sandbox after the run — because the worker retargeted or removed
    // it, or because the trusted cleanup could not remove its own exact mapping — the
    // vector succeeded. Its control is the alias batch's unrestricted mapping create.
    'alias-retarget-cwd': { attribution: ['rb-trusted-checkout-listing'], rowless: true,
      control: ['alias', 'subst-create-y-trusted'],
      signal: ctx => ctx.devices['Z:'] !== undefined || /remove exact sandbox drive alias/.test(ctx.launchFailure ?? '') },
    'alias-retarget-read': { attribution: ['rb-trusted-checkout-listing'], control: ['reads', 'trusted-checkout-listing'] },
    'alias-retarget-outside-read': { attribution: ['rb-outside-secret'], control: ['reads', 'outside-secret'] },
  },
};
/** Vectors that MUST keep working: the confined worker's legitimate capability. */
const CAPABILITY_VECTORS = { alias: ['alias-self-read'] };
const RECONNAISSANCE = { alias: ['subst-list', 'subst-list-after'], 'alias-retarget-cwd': ['subst-delete-z', 'subst-create-z-trusted', 'subst-delete-z-again', 'subst-create-z-outside', 'subst-list-after'] };
/** A vector may borrow its positive control from another vector that reaches the same
 * target by a path whose reachability the unrestricted run can establish. */
const controlSignals = {};
let aliasRemovals = [];

let enrolled;
let baselineDevices = {};
const report = { schema: 'canary-confined-git-escape/2', host: {}, environment: {}, vectors: [], positives: [], reconnaissance: {} };
let CFG_REPORT, cfgObject;

const run = (exe, args, cwd = base, timeout = 300000) => {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout });
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
const devices = () => dos('list').map;
const markerNames = () => fs.readdirSync(outside).filter(f => /^ran-.*\.txt$/.test(f)).map(f => f.slice(4, -4));
const clearMarkers = () => { for (const f of fs.readdirSync(outside)) if (/^ran-.*\.txt$/.test(f)) fs.rmSync(path.join(outside, f)); };
const markerPath = id => path.join(outside, `ran-${id}.txt`);
const helperText = id => `#!/bin/sh\necho ESCAPE_CANARY\necho ran > "${slash(markerPath(id))}"\n`;

function buildTemplate() {
  fs.mkdirSync(template);
  run(git, ['init'], template);
  run(git, ['config', 'user.name', 'Escape audit'], template);
  run(git, ['config', 'user.email', 'audit@localhost'], template);
  fs.writeFileSync(path.join(template, 'implementation.txt'), 'base\n');
  fs.writeFileSync(path.join(template, '.gitattributes'), 'implementation.txt diff=probe\nimplementation.txt filter=probe\n');
  run(git, ['add', '.'], template);
  run(git, ['commit', '-m', 'confined workspace base'], template);
}
/** Every run starts from identical bytes: a fresh copy of the sealed template. */
function freshWork() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(template, work, { recursive: true });
  fs.symlinkSync(outside, path.join(work, 'outside-junction'), 'junction');
}
function execute(batch, confined) {
  // The confined executor resolves `node` through the PATH production-tool.cjs sets to
  // the DEPLOYMENT's copied runtime; a host path is deliberately not used there. The
  // control run ignores argv[0] and spawns the real interpreter itself.
  const argv = ['node', '--preserve-symlinks-main', path.join(work, 'git-escape-worker.cjs'), path.join(work, 'escape-cfg.json'), batch];
  clearMarkers();
  freshWork();
  // The boundary denies the trusted checkout, so the attack program AND its config are
  // staged INSIDE the sandbox — exactly as the production executor stages its own tool.
  fs.copyFileSync(worker, path.join(work, 'git-escape-worker.cjs'));
  fs.writeFileSync(path.join(work, 'escape-cfg.json'), JSON.stringify(cfgObject));
  const before = devices();
  let launch;
  if (confined) {
    try {
      const r = productionTool(store, work, { op: 'exec', argv });
      launch = { via: 'production-confined-executor', argv, observation: r.observation, status: r.output?.result?.status ?? null,
        stderr: (r.output?.result?.stderr ?? '').slice(0, 2000), error: r.output?.result?.error ?? r.output?.error,
        toolError: r.output?.error ?? null };
      if (launch.status !== 0) launch.failure = `worker exit ${launch.status}: ${launch.error ?? ''}`;
    } catch (e) { launch = { via: 'production-confined-executor', argv, failure: e.message }; }
  } else {
    const r = spawnSync(process.execPath, argv.slice(1), { cwd: work, encoding: 'utf8', windowsHide: true, timeout: 600000 });
    launch = { via: 'unrestricted-same-user', status: r.status, stderr: (r.stderr || '').slice(0, 2000) };
    if (r.status !== 0) launch.failure = `control exit ${r.status}`;
  }
  const parsed = fs.existsSync(CFG_REPORT) ? JSON.parse(fs.readFileSync(CFG_REPORT, 'utf8')) : { rows: [], cwd: null };
  const rows = parsed.rows;
  // The descendant writes its own file; the trusted side injects its verdict as a row
  // so a grandchild's escape is judged on what the grandchild actually observed.
  const descendant = path.join(work, 'descendant.json');
  if (fs.existsSync(descendant)) {
    try {
      const d = JSON.parse(fs.readFileSync(descendant, 'utf8'));
      const entries = Object.entries(d);
      rows.push({ id: 'descendant-node', kind: 'read', executed: true, injected: 'grandchild-readback',
        allowed: entries.some(([, v]) => v.allowed === true),
        error: entries.map(([, v]) => v.error).filter(Boolean)[0], value: d });
    } catch (e) { rows.push({ id: 'descendant-node', kind: 'read', executed: false, error: `unreadable grandchild report: ${e.message}` }); }
  }
  const post = devices();
  const aliasRemovedAfterRun = cleanAliases();
  aliasRemovals = [...aliasRemovals, ...aliasRemovedAfterRun];
  return { launch, rows, cwd: parsed.cwd, markers: new Set(markerNames()), devices: post, before, aliasRemovedAfterRun };
}
/** Every run must leave the session device namespace exactly as it found it, so the
 * next run's before/after comparison means something. A mapping this probe caused is
 * removed; a mapping the user owned is never touched. */
function cleanAliases() {
  const now = devices(), removed = [];
  for (const key of Object.keys(now)) {
    if (baselineDevices[key] !== undefined) continue;
    const target = String(now[key]).toLowerCase();
    if (!target.includes(root.toLowerCase()) && !target.includes(repo.toLowerCase())) continue;
    const removal = dos('define', { flags: 11, name: key, target: null });
    assert.equal(removal.error, undefined, `failed to remove probe-created mapping ${key}: ${JSON.stringify(removal)}`);
    removed.push(key);
  }
  return removed;
}

try {
  for (const p of [base, outside, helpers]) fs.mkdirSync(p);
  report.host = { node: process.version, git: run(git, ['--version']).trim(), temp: os.tmpdir(), gitExecutable: git };

  // ── baseline device namespace: the alias vectors need Z:, Y:, W: free ──
  baselineDevices = devices();
  const baseline = baselineDevices;
  report.reconnaissance.baselineDevices = baseline;
  for (const letter of ['Z:', 'Y:', 'W:']) {
    assert.equal(baseline[letter], undefined,
      `${letter} is already mapped (${baseline[letter]}); alias vectors cannot be deterministic. A leftover mapping is itself a finding: inspect before re-running.`);
  }

  // ── trusted fixture: a sealed project, a confined workspace, an outside target ──
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the trusted base was sealed
  // only on a machine that has Claude Code installed and the whole audit failed on a CI runner.
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'git-audit', scripts: { test: 'node test.cjs' } }));
  fs.writeFileSync(path.join(base, 'test.cjs'), 'require("node:assert/strict").equal(1,1);');
  for (const cwd of [base, outside]) {
    run(git, ['init'], cwd); run(git, ['config', 'user.name', 'Escape audit'], cwd);
    run(git, ['config', 'user.email', 'audit@localhost'], cwd);
    fs.writeFileSync(path.join(cwd, 'implementation.txt'), 'base\n');
  }
  run(git, ['add', '.'], base); run(git, ['commit', '-m', 'base'], base);
  run(git, ['add', '.'], outside); run(git, ['commit', '-m', 'outside base'], outside);
  fs.writeFileSync(path.join(outside, 'secret.config'), '[canary]\nprobe = ESCAPE_CANARY\n');
  fs.writeFileSync(path.join(outside, 'ESCAPE_CANARY'), 'ESCAPE_CANARY\n');
  run(git, ['config', 'canary.probe', 'ESCAPE_CANARY'], outside);
  run(git, ['add', 'ESCAPE_CANARY'], outside);
  run(git, ['commit', '-m', 'outside secret'], outside);
  for (const id of ['external-diff', 'GIT_EXTERNAL_DIFF', 'textconv', 'filter-clean', 'fsmonitor', 'gpgProgram', 'editor', 'sshCommand']) {
    fs.writeFileSync(path.join(helpers, `ran-${id}.sh`), helperText(id));
  }
  fs.writeFileSync(path.join(helpers, 'pre-commit'), helperText('hooksPath'));
  // A file that exists only OUTSIDE, so a work-tree listing naming it is proof of an
  // outside read even when the outside repo's tracked content is also named.
  fs.writeFileSync(path.join(outside, 'ESCAPE_CANARY_UNTRACKED'), 'ESCAPE_CANARY\n');
  buildTemplate();

  // ── trusted-side path forms a confined worker could not compute for itself ──
  const deviceTarget = dos('query', { name: 'C:' });
  assert.equal(deviceTarget.error, undefined, JSON.stringify(deviceTarget));
  report.environment.deviceC = deviceTarget.target;
  const ntDevicePath = '\\\\?\\GLOBALROOT' + deviceTarget.target;
  report.environment.ntDevicePath = ntDevicePath;
  const short = dos('short', { path: outside });
  report.environment.shortOutside = short.short ?? null;
  report.environment.shortError = short.error ?? null;
  report.environment.shortIsDistinct = !!short.short && short.short.toLowerCase() !== outside.toLowerCase();
  const uncRoot = '\\\\localhost\\' + path.parse(outside).root.replace(':', '$');
  report.environment.uncRoot = uncRoot;
  const uncSecret = uncRoot + outside.slice(2) + '\\secret.config';
  report.environment.uncSecret = uncSecret;
  const shortSecret = report.environment.shortIsDistinct ? path.join(short.short, 'secret.config') : null;
  const ntSecret = ntDevicePath + outside.slice(2) + '\\secret.config';

  const cfg = {
    git, base, work, store, repo, outside, outsideSlash: slash(outside), helperDirSlash: slash(helpers),
    secretObject: run(git, ['hash-object', 'ESCAPE_CANARY'], outside).trim(),
    ntSecret, shortSecret, uncSecret, runTimeout: 6000,
    report: path.join(work, 'escape-report.json'), descendantReport: path.join(work, 'descendant.json'),
    descendantReads: { 'outside-secret': path.join(outside, 'secret.config'), 'trusted-checkout': path.join(repo, 'package.json') },
    reads: {
      'absolute-checkout': path.join(base, 'package.json'),
      'parent-traversal': path.join(work, '..', 'base', 'package.json'),
      junction: path.join(work, 'outside-junction', 'secret.config'),
      'proof-authority': path.join(base, '.canary', 'canary.local.json'),
      'broker-key': path.join(store, 'producer.key'),
      'extended-path': '\\\\?\\' + path.join(base, 'package.json'),
      'outside-secret': path.join(outside, 'secret.config'),
      'outside-git-config': path.join(outside, '.git', 'config'),
      'trusted-checkout-config': path.join(repo, '.git', 'config'),
    },
    listings: {
      'outside-listing': outside,
      'store-listing': store,
      'trusted-checkout-listing': repo,
      'helper-listing': helpers,
    },
    // Same-run attribution evidence, re-executed at the head of every batch.
    readbacks: {
      'rb-outside-secret': { path: path.join(outside, 'secret.config') },
      'rb-outside-git-config': { path: path.join(outside, '.git', 'config') },
      'rb-outside-listing': { path: outside, dir: true },
      'rb-store-listing': { path: store, dir: true },
      'rb-trusted-checkout-listing': { path: repo, dir: true },
      'rb-helper-listing': { path: helpers, dir: true },
    },
  };
  cfgObject = cfg;
  CFG_REPORT = cfg.report;
  report.environment.readTargets = cfg.reads;
  freshWork();
  fs.writeFileSync(path.join(os.tmpdir(), 'canary-confined-git-escape.json'), JSON.stringify(report, null, 2));

  run(process.execPath, [cli, 'setup', '--yes', base]);
  run(process.execPath, [cli, 'task', 'confined Git escape audit'], base);
  enrolled = JSON.parse(run(process.execPath, [cli, 'provider', 'enroll', base, store]));
  report.environment.package = enrolled.package;

  // A control can only fire on a target that exists; assert the trusted fixture is complete.
  for (const [id, target] of [...Object.entries(cfg.reads), ...Object.entries(cfg.listings)]) {
    assert.ok(fs.existsSync(target), `read target ${id} missing: ${target}`);
  }

  // ── positive controls: the confined worker keeps real implementation Git ──
  if (!controlsOnly) {
    freshWork();
    const tool = request => productionTool(store, work, request);
    assert.ok(fs.lstatSync(path.join(work, '.git')).isDirectory());
    assert.equal(fs.existsSync(path.join(work, '.git/objects/info/alternates')), false);
    assert.equal(tool({ op: 'write', path: 'implementation.txt', text: 'confined change\n' }).output.result, 'written');
    const positives = [['rev-parse', '--show-toplevel'], ['status', '--porcelain'], ['diff'], ['diff', '--cached'],
      ['add', '--', 'implementation.txt'], ['diff', '--cached'], ['stash', 'list'], ['log', '--oneline', '-1'],
      ['rev-parse', 'HEAD'], ['ls-files']];
    for (const args of positives) {
      const r = tool({ op: 'exec', argv: [git, ...args] });
      assert.equal(r.observation[0].package, enrolled.package);
      assert.equal(r.output.result.status, 0, `${args.join(' ')}: ${JSON.stringify(r.output.result)}`);
      report.positives.push({ args, result: r.output.result });
    }
    assert.match(report.positives[2].result.stdout, /confined change/);
    assert.equal(report.positives[3].result.stdout, '');
    assert.match(report.positives[5].result.stdout, /confined change/);
    assert.equal(report.positives[0].result.stdout.trim(), 'Z:/', 'the confined workspace root is the sandbox alias root');
    // Independent readback by the TRUSTED side: the worker's index is really staged.
    assert.match(run(git, ['diff', '--cached'], work), /confined change/);
    console.log(`PASS ${positives.length} confined Git positive controls; trusted-side index readback; self-contained .git`);
  }

  // ── attack vectors ──
  for (const batch of Object.keys(ESCAPE_VECTORS)) {
    const control = execute(batch, false);
    const ctxOf = (runResult, id) => ({ row: rowOf(runResult.rows, id), markers: runResult.markers, devices: runResult.devices,
      before: runResult.before, launchFailure: runResult.launch.failure ?? null });
    if (controlsOnly) {
      for (const id of Object.keys(ESCAPE_VECTORS[batch])) {
        const ctx = ctxOf(control, id);
        const fired = (ESCAPE_VECTORS[batch][id].signal ?? readSignal(id))(ctx);
        controlSignals[`${batch}/${id}`] = fired;
        console.log(`${fired ? 'CONTROL-OK  ' : 'CONTROL-DEAD'} ${batch}/${id}${control.markers.has(id) ? ' marker=yes' : ''}: ${ctx.row ? JSON.stringify({ status: ctx.row.status, allowed: ctx.row.allowed, error: ctx.row.error, timedOut: ctx.row.timedOut, stdout: (ctx.row.stdout || '').slice(0, 100), stderr: (ctx.row.stderr || '').slice(0, 140) }) : 'NO ROW'} devices=${JSON.stringify(control.devices)}`);
      }
      continue;
    }
    for (const id of Object.keys(ESCAPE_VECTORS[batch])) controlSignals[`${batch}/${id}`] = (ESCAPE_VECTORS[batch][id].signal ?? readSignal(id))(ctxOf(control, id));
    const restricted = execute(batch, true);
    report.reconnaissance[batch] = Object.fromEntries((RECONNAISSANCE[batch] ?? []).map(id => [id, rowOf(restricted.rows, id)]));
    for (const [id, spec] of Object.entries(ESCAPE_VECTORS[batch])) {
      const c = rowOf(control.rows, id), r = rowOf(restricted.rows, id);
      const signal = spec.signal ?? readSignal(id);
      const borrowed = spec.control ? controlSignals[`${spec.control[0]}/${spec.control[1]}`] : undefined;
      const controlFired = borrowed ?? signal(ctxOf(control, id));
      const restrictedEscaped = signal(ctxOf(restricted, id));
      const attributionDenied = (spec.attribution ?? []).filter(a => deniedBy(rowOf(restricted.rows, a)));
      const networkDenied = spec.network === true && restricted.launch.observation?.[0]?.networkCapability === false
        && restricted.launch.observation?.[0]?.capabilities === 0;
      let verdict, why;
      if (!controlFired) { verdict = 'INCONCLUSIVE'; why = 'positive control did not establish the vector'; }
      else if (restrictedEscaped) { verdict = 'SUCCESS'; why = 'confined run produced the escape signal'; }
      else if (!r && !spec.rowless) { verdict = 'INCONCLUSIVE'; why = 'vector produced no record in the confined run'; }
      else if (r?.timedOut) { verdict = 'INCONCLUSIVE'; why = 'vector timed out; a timeout is not a blocked attack'; }
      else if (r && r.executed !== true) { verdict = 'INCONCLUSIVE'; why = 'vector never ran in the confined run'; }
      else if (DENIED.test(rowText(r)) || attributionDenied.length || networkDenied) {
        verdict = 'BLOCKED'; why = DENIED.test(rowText(r)) ? 'permission denial reported by the vector'
          : networkDenied ? 'attributed to the measured absence of any network capability'
            : `attributed to confined read denials of ${attributionDenied.join(', ')}`;
      } else if (restricted.launch.failure && (spec.attribution ?? []).length) {
        verdict = 'BLOCKED'; why = `confined launch refused (${restricted.launch.failure}) and the target could not be read`;
      } else { verdict = 'INCONCLUSIVE'; why = 'no escape, but the denial is not attributable to the boundary'; }
      report.vectors.push({ id, batch, verdict, why, attribution: attributionDenied, controlFrom: spec.control ?? null,
        control: { marker: control.markers.has(id), row: c }, restricted: { marker: restricted.markers.has(id), row: r },
        restrictedLaunch: restricted.launch });
      console.log(`${verdict === 'BLOCKED' ? 'PASS' : 'FAIL'} ${verdict} ${batch}/${id} — ${why}`);
    }
    for (const id of CAPABILITY_VECTORS[batch] ?? []) {
      const r = rowOf(restricted.rows, id);
      const held = !!r && r.allowed === true;
      report.vectors.push({ id, batch, verdict: held ? 'CAPABILITY-HELD' : 'INCONCLUSIVE',
        why: held ? 'legitimate confined capability preserved' : 'capability missing in the confined run', restricted: { row: r } });
      console.log(`${held ? 'PASS' : 'FAIL'} ${held ? 'CAPABILITY-HELD' : 'INCONCLUSIVE'} ${batch}/${id}`);
    }
  }

  const final = devices();
  report.reconnaissance.finalDevices = final;
  report.reconnaissance.aliasLeftovers = Object.keys(final).filter(k => baseline[k] === undefined);
  report.reconnaissance.removedAfterRun = aliasRemovals;
  cleanAliases();
  report.reconnaissance.devicesAfterCleanup = devices();
  const stillMapped = Object.keys(report.reconnaissance.devicesAfterCleanup).filter(k => baseline[k] === undefined);
  assert.deepEqual(stillMapped, [], `device namespace left dirty: ${JSON.stringify(stillMapped)}`);

  fs.writeFileSync(path.join(os.tmpdir(), 'canary-confined-git-escape.json'), JSON.stringify(report, null, 2));
  if (controlsOnly) {
    console.log(`CONTROLS-ONLY mode: no security verdict is reported. Evidence: ${path.join(os.tmpdir(), 'canary-confined-git-escape.json')}`);
  } else {
    const counts = report.vectors.reduce((a, v) => (a[v.verdict] = (a[v.verdict] ?? 0) + 1, a), {});
    console.log(`Confined Git escape battery: ${JSON.stringify(counts)}`);
    console.log(`Trusted checkout readable: ${report.vectors.some(v => v.id === 'trusted-checkout-listing' && v.verdict === 'SUCCESS') ? 'YES' : 'NO'}`);
    assert.ok(!counts.SUCCESS && !counts.INCONCLUSIVE, 'escape battery incomplete: no SUCCESS and no INCONCLUSIVE may remain');
  }
} finally {
  if (enrolled) {
    removeMeasurementAuthority(store, enrolled.id);
    for (const name of [enrolled.profile, enrolled.profile + '.Verifier']) native(store, { mode: 'identity', name, delete: true, result: path.join(root, 'deleted.json') });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
