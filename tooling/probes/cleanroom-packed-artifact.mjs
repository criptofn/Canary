#!/usr/bin/env node
/**
 * M1 CLEAN-ROOM PROOF (gpv.10) — the packed artifact must stand alone.
 *
 * Packs via tooling/pack.mjs, then installs the EXACT .tgz (npm install, no
 * publish, no registry) into an unrelated temp repo whose path contains
 * SPACES, and plays the lazy-vibecoder journey THROUGH THE INSTALLED ARTIFACT
 * ONLY: bin-shim execution, setup -> READY, doctor, the literal Stop-hook
 * command string (the exact bytes Claude Code runs, quotes + spaces included),
 * a failing project that must BLOCK, uninstall that preserves unrelated
 * config, and a stale hook that stays silent afterwards.
 *
 * Also audits the tarball itself: exact bundle/manifest/native-asset allowlist; no
 * monorepo paths, no secrets, no .night-run/cage content, zero runtime deps.
 *
 * First-class probe (repo workflow rule): fixtures under OS temp only,
 * self-cleaning, PASS/FAIL lines, exit 0 only when everything passed.
 */
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CANARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WIN = process.platform === 'win32';
const MB32 = 32 * 1024 * 1024;
let failures = 0;
const check = (n, label, cond, extra = '') => {
  if (cond) console.log(`STEP-${n} PASS: ${label}`);
  else { failures++; console.log(`STEP-${n} FAIL: ${label} ${extra}`); }
  return cond;
};
const sh = (cmd, opts = {}) =>
  spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: MB32, timeout: opts.timeout ?? 240_000, ...opts });

console.log(`node ${process.version} ${process.platform}; packed-artifact clean-room proof`);

// ---- 1) pack ----
const packed = sh(`"${process.execPath}" "tooling/pack.mjs"`, { cwd: CANARY });
check(1, 'tooling/pack.mjs exits 0', packed.status === 0, (packed.stdout ?? '') + (packed.stderr ?? ''));
// The npm tarball lives in its OWN subdirectory: `pack/standalone/` holds the
// single-executable distribution, and packing the tarball must not destroy it.
const PACK_DIR = path.join(CANARY, 'pack', 'npm');
const tgzs = fs.existsSync(PACK_DIR) ? fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.tgz')) : [];
if (!check(1, 'exactly one tarball produced', tgzs.length === 1, JSON.stringify(tgzs))) finish();
const TGZ = path.join(PACK_DIR, tgzs[0]);

// ---- 2) tarball contents + manifest audit (pure Node; Windows bsdtar
//      mangles "C:" paths as remote-host syntax, and purity is cheaper anyway) ----
function tarFiles(tgzPath) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h[0] === 0) break; // end-of-archive zero block
    const name = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/[^0-7]/g, '') || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 0x30);
    if (type === '0' || type === '\0') files.set(name, buf.subarray(off + 512, off + 512 + size).toString('utf8'));
    off += 512 + Math.ceil(size / 512) * 512; // header + body rounded to blocks
  }
  return files;
}
const files = tarFiles(TGZ);
const entries = [...files.keys()];
check(2, 'tgz parses as a ustar archive with files', entries.length >= 2, JSON.stringify(entries));
console.log('  entries: ' + JSON.stringify(entries));
const stripped = entries.map((e) => e.replace(/^package\//, ''));
check(2, 'every entry lives under package/', entries.every((e) => e.startsWith('package/')));
const expected = ['package.json', 'dist/main.js',
  ...['CanaryConfinedLauncher.cs', 'CanaryBroker.cs', 'production-native.ps1', 'production-child.cjs', 'production-host.ps1', 'production-heartbeat.ps1'].map(f => `tools/windows-boundary/${f}`),
  ...['boundary-native-child.cs', 'boundary-native-parent.cs', 'boundary-native-run.ps1', 'confined-listener.cjs', 'confined-caller.cjs', 'medium-pipe.ps1'].map(f => `tooling/test-support/fixtures/${f}`)];
check(2, 'exact allowlist: bundle, manifest, native runtime and measured attack programs',
  stripped.length === expected.length && expected.every(f => stripped.includes(f)));
check(2, 'no node_modules / .night-run / cage / secrets / absolute paths in the listing',
  !entries.some((e) => /node_modules|[.][ ]?night-run|cage|secret|^package\/[a-zA-Z]:|\\/.test(e)));
const man = JSON.parse(files.get('package/package.json') ?? '');
check(2, 'manifest: zero runtime deps, not private, bin -> dist/main.js',
  man.dependencies === undefined && man.private === undefined && man.bin?.canary === 'dist/main.js' && man.type === 'module');
const bundle = files.get('package/dist/main.js') ?? '';
const fwd = CANARY.replaceAll('\\', '/');
check(2, 'bundle text carries no monorepo/home identity, no .night-run, no secrets',
  bundle.length > 100_000 && !bundle.includes(CANARY) && !bundle.includes(fwd) &&
  !bundle.includes('.night-run') && !bundle.includes('C:\\Users\\Johannes'),
  'possible leak: ' + JSON.stringify([CANARY, fwd].filter((p) => bundle.includes(p))));

// ---- 3) unrelated consumer repo, path WITH SPACES ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary m1 cleanroom '));
const REPO = path.join(TMP, 'my spaced app');
try {
  check(3, 'temp repo path really contains spaces', TMP.includes(' ') && REPO.includes(' '));
  fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });
  fs.mkdirSync(path.join(REPO, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ name: 'cleanroom-consumer', scripts: { test: 'node check.js' } }, null, 2));
  fs.writeFileSync(path.join(REPO, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(REPO, 'check.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(REPO, 'app.txt'), 'user data - must survive\n');
  // unrelated harness config: a $schema, a permission rule, and the user's OWN Stop hook
  fs.writeFileSync(path.join(REPO, '.claude', 'settings.json'), JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-custom-stop-notifier' }] }] },
  }, null, 2));

  const inst = sh(`npm install --no-audit --no-fund --ignore-scripts "${TGZ}"`, { cwd: REPO });
  check(3, 'npm install of the EXACT tarball exits 0 (offline-capable: no scripts, no deps)', inst.status === 0, (inst.stdout ?? '') + (inst.stderr ?? ''));
  const INSTALLED = path.join(REPO, 'node_modules', '@canary-rn', 'cli', 'dist', 'main.js');
  const SHIM = path.join(REPO, 'node_modules', '.bin', IS_WIN ? 'canary.cmd' : 'canary');
  check(3, 'installed bundle + bin shim present; no nested node_modules (zero-dep footprint)',
    fs.existsSync(INSTALLED) && fs.existsSync(SHIM) && !fs.existsSync(path.join(REPO, 'node_modules', '@canary-rn', 'cli', 'node_modules')));

  // ---- 4) bin shim execution (spaces in the install path are now live) ----
  const setup = sh(`"${SHIM}" setup --yes`, { cwd: REPO });
  check(4, 'bin shim runs: setup --yes exits 0 with READY', setup.status === 0 && /READY/.test(setup.stdout ?? ''), setup.stdout + (setup.stderr ?? ''));
  const cfgPath = path.join(REPO, '.canary', 'canary.local.json');
  if (!check(4, 'setup wrote its local config', fs.existsSync(cfgPath), 'journey cannot continue')) finish();
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  let realInstalled = INSTALLED; try { realInstalled = fs.realpathSync(INSTALLED); } catch { /* fall back to logical path */ }
  check(4, 'config cliPath points INTO the installed package (S1 corroboration will match)',
    path.normalize(cfg.cliPath) === path.normalize(realInstalled), cfg.cliPath);
  check(4, 'hookCommand carries the spaced path, double-quoted', cfg.hookCommand === `node "${cfg.cliPath}" checkpoint` && cfg.hookCommand.includes(' '));
  let smoke = {}; try { smoke = JSON.parse(fs.readFileSync(path.join(REPO, '.canary', 'last-checkpoint.json'), 'utf8')); } catch { /* check below reports it */ }
  check(4, 'setup smoke-ran the plan through the bundle: pass recorded', smoke.status === 'pass');

  // ---- 5) doctor ----
  const doc = sh(`"${SHIM}" doctor`, { cwd: REPO });
  check(5, 'doctor: READY, earned this invocation', doc.status === 0 && /READY/.test(doc.stdout ?? ''), doc.stdout ?? '');

  // ---- 6) the REAL Stop-hook contract: the literal command string Claude Code runs ----
  const hookJson = (active) => JSON.stringify({ session_id: 'packed-proof', cwd: REPO, hook_event_name: 'Stop', stop_hook_active: !!active });
  const passRun = sh(cfg.hookCommand, { cwd: REPO, input: hookJson(false) });
  check(6, 'green repo via literal hook string: silent allow (exit 0, empty stdout)', passRun.status === 0 && (passRun.stdout ?? '').trim() === '', passRun.stdout ?? '');
  fs.writeFileSync(path.join(REPO, 'check.js'), 'process.exit(1); // AI broke it\n');
  const failRun = sh(cfg.hookCommand, { cwd: REPO, input: hookJson(false) });
  const failOut = JSON.parse(failRun.stdout || '{}');
  check(6, 'broken repo via literal hook string: BLOCK with repair instruction', failOut.decision === 'block' && /Canary verification failed/.test(failOut.reason ?? ''), failRun.stdout ?? '');
  const loopOut = JSON.parse(sh(cfg.hookCommand, { cwd: REPO, input: hookJson(true) }).stdout || '{}');
  check(6, 'loop guard: active retry -> honest systemMessage, no repeated block', loopOut.decision === undefined && /still failing/.test(loopOut.systemMessage ?? ''));

  // ---- 7) uninstall preserves everything unrelated ----
  const staleHook = cfg.hookCommand;
  const un = sh(`"${SHIM}" uninstall`, { cwd: REPO });
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  const cmds = (settings.hooks?.Stop ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  check(7, 'uninstall exits 0; Canary project state gone; user files untouched',
    un.status === 0 && !fs.existsSync(path.join(REPO, '.canary')) && fs.readFileSync(path.join(REPO, 'app.txt'), 'utf8') === 'user data - must survive\n');
  check(7, 'unrelated config preserved exactly (schema + permission + user Stop hook; no Canary entry)',
    settings.$schema === 'https://json.schemastore.org/claude-code-settings.json' &&
    JSON.stringify(settings.permissions) === JSON.stringify({ allow: ['Bash(npm test)'] }) &&
    cmds.join('|') === 'echo my-custom-stop-notifier', JSON.stringify(cmds));
  const zombie = sh(staleHook, { cwd: REPO, input: hookJson(false) });
  check(7, 'stale hook entry after uninstall: silent absence, never a fake pass or crash', zombie.status === 0 && (zombie.stdout ?? '').trim() === '', zombie.stdout ?? '');
} finally {
  // best-effort self-clean; Windows can hold npm child handles briefly
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
    catch { const t = Date.now(); while (Date.now() - t < 250) { /* settle */ } }
  }
  if (fs.existsSync(TMP)) console.log(`WARN: temp dir not fully cleaned: ${TMP}`);
}

finish();
function finish() {
  console.log('');
  if (failures) { console.log(`CLEANROOM-PACKED-FAIL (${failures} failed checks)`); process.exit(1); }
  console.log('PACKED-CLEANROOM-PASS (7/7 acceptance steps)');
  process.exit(0);
}
