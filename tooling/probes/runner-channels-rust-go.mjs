#!/usr/bin/env node
/**
 * Rust and Go runner-channel measurements (v1.1 Phase 2).
 *
 * The previous session reported both as IMPLEMENTED_BUT_HOST_UNVERIFIED because
 * neither toolchain was installed. They are now provisioned workspace-locally
 * (see tooling/toolchains.mjs), so the honest question is no longer "can we run
 * them" but "what observation channel does each actually offer" — and that must
 * be MEASURED, because the answer decides whether a strong label is reachable:
 *
 *   Rust: does stable libtest expose an EVENT stream (a per-test machine-readable
 *         record Canary could re-count), or only a text summary? A text summary is
 *         a CLAIM; if that is all there is, the adapter must stay
 *         INCONCLUSIVE_ONLY and say exactly why.
 *         Also: is CARGO_TARGET_<TRIPLE>_RUNNER honored, i.e. can Canary own the
 *         launch of each test binary?
 *   Go:   `go test -json` is a documented event stream — test whether it is
 *         emitted and parseable per test, and whether `go test -exec=<shim>`
 *         lets Canary own the test-binary launch.
 *
 * The probe asserts only FACTS it then relies on, prints all of them, and exits
 * non-zero if a fact it needs is not true. It never installs anything and never
 * touches global machine state: every toolchain invocation gets CARGO_HOME /
 * RUSTUP_HOME / GOROOT / GOPATH / GOCACHE pointing into the workspace.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const TC = path.join(REPO, '_toolchains');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

if (!fs.existsSync(TC)) { console.error('FAIL: no workspace-local toolchains — run `node tooling/toolchains.mjs all` first'); process.exit(1); }

const GO = path.join(TC, 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
const CARGO = path.join(TC, 'rust', 'cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const CARGO_HOME = path.join(TC, 'rust', 'cargo');
const RUSTUP_HOME = path.join(TC, 'rust', 'rustup');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-rustgo-'));

const goEnv = {
  GOROOT: path.join(TC, 'go'),
  GOPATH: path.join(TC, 'gopath'),
  GOCACHE: path.join(TC, 'gocache'),
  GOTOOLCHAIN: 'local',
  GOPROXY: 'off',
  GOFLAGS: '-mod=mod',
  PATH: `${path.join(TC, 'go', 'bin')};${process.env.PATH ?? ''}`,
  SystemRoot: process.env.SystemRoot ?? 'C:\\WINDOWS',
};
const rustEnv = {
  CARGO_HOME, RUSTUP_HOME, CARGO_TERM_COLOR: 'never', RUSTUP_TOOLCHAIN: 'stable',
  PATH: `${path.join(CARGO_HOME, 'bin')};${process.env.PATH ?? ''}`,
  SystemRoot: process.env.SystemRoot ?? 'C:\\WINDOWS',
  USERPROFILE: process.env.USERPROFILE ?? '',
};

const run = (exe, args, opts = {}) => spawnSync(exe, args, { encoding: 'utf8', timeout: 900_000, windowsHide: true, ...opts });

// ══════════════════════════════════ Rust ══════════════════════════════════
console.log('=== Rust ===');
const rustcV = run(path.join(CARGO_HOME, 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'), ['-vV'], { env: rustEnv });
console.log((rustcV.stdout ?? '').trim());
const hostTriple = /^host: (\S+)$/m.exec(rustcV.stdout ?? '')?.[1];
assert(hostTriple !== undefined, `could not read the host triple from rustc -vV:\n${rustcV.stdout}${rustcV.stderr}`);

const crate = path.join(TMP, 'rustcrate');
fs.mkdirSync(path.join(crate, 'src'), { recursive: true });
fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "canary_probe"\nversion = "0.1.0"\nedition = "2021"\n');
fs.writeFileSync(path.join(crate, 'src', 'lib.rs'), [
  'pub fn add(a: i32, b: i32) -> i32 { a + b }',
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    use super::*;',
  '    #[test]',
  '    fn adds() { assert_eq!(add(1, 1), 2); }',
  '    #[test]',
  '    fn subtracts_ok() { assert_eq!(add(5, -5), 0); }',
  '    #[test]',
  '#[ignore]',
  '    fn ignored_one() { panic!("never runs"); }',
  '}',
  '',
].join('\n'));

const cargoTest = run(CARGO, ['test', '--quiet'], { cwd: crate, env: rustEnv });
console.log(`\n-- cargo test --quiet (default toolchain, exit ${cargoTest.status}) --`);
console.log(((cargoTest.stdout ?? '') + (cargoTest.stderr ?? '')).trim().split('\n').slice(-6).join('\n'));

/**
 * HOST PRECONDITION, not a fact about libtest: the MSVC target needs
 * `link.exe` from Visual Studio Build Tools, which is absent here. That is a
 * *toolchain* gap, and reporting it as "Rust has no event stream" would be
 * exactly the kind of inference-from-a-truncated-error this repo forbids. So the
 * toolchain is retried on the GNU target (which bundles its own linker), and if
 * NO toolchain can build, the channel facts are reported as SKIPPED — never as
 * measured-negative.
 */
let rustEnvUsed = rustEnv;
let rustBuildable = cargoTest.status === 0;
let rustWhy = '';
if (!rustBuildable) {
  const err = (cargoTest.stdout ?? '') + (cargoTest.stderr ?? '');
  if (/link\.exe.*not found|linker .* not found/i.test(err)) {
    console.log('\n  MSVC linker absent -> retrying on the GNU toolchain (bundles its own linker)');
    const gnuEnv = { ...rustEnv, RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-gnu' };
    const gnu = run(CARGO, ['test', '--quiet'], { cwd: crate, env: gnuEnv });
    console.log(`  -- cargo test --quiet (GNU toolchain, exit ${gnu.status}) --`);
    console.log(((gnu.stdout ?? '') + (gnu.stderr ?? '')).trim().split('\n').slice(-6).join('\n'));
    if (gnu.status === 0) { rustBuildable = true; rustEnvUsed = gnuEnv; }
    else rustWhy = `no usable Rust linker on this host: MSVC link.exe is absent and the GNU toolchain failed too (${((gnu.stdout ?? '') + (gnu.stderr ?? '')).trim().split('\n').slice(-3).join(' | ')})`;
  } else {
    rustWhy = `cargo test failed for a non-linker reason: ${err.trim().split('\n').slice(-4).join(' | ')}`;
  }
}
let rustSkipped = 0;
const rustSkip = (reason) => { rustSkipped++; console.log(`SKIP  ${reason}`); };

if (rustBuildable) {
  console.log(`\n-- cargo test (usable toolchain, exit 0) --`);
  check('cargo test really runs and reports a libtest summary', () => {
    const r = run(CARGO, ['test', '--quiet'], { cwd: crate, env: rustEnvUsed });
    assert(r.status === 0, `cargo test failed: ${((r.stdout ?? '') + (r.stderr ?? '')).slice(-800)}`);
    assert(/test result: ok\. 2 passed; 0 failed; 1 ignored/.test(r.stdout ?? ''),
      `expected a libtest summary, got:\n${r.stdout}`);
  });

  // Does stable libtest expose a per-test EVENT stream? This is the question that
  // decides STRONG-vs-INCONCLUSIVE for Rust: a text summary is a CLAIM.
  const jsonAttempt = run(CARGO, ['test', '--quiet', '--', '--format', 'json'], { cwd: crate, env: rustEnvUsed });
  const jsonOut = (jsonAttempt.stdout ?? '') + (jsonAttempt.stderr ?? '');
  console.log(`\n-- cargo test -- --format json (exit ${jsonAttempt.status}) --`);
  console.log(jsonOut.trim().split('\n').slice(0, 6).join('\n'));
  const jsonEvents = jsonOut.split('\n').filter((l) => l.trim().startsWith('{')).length;
  console.log(`JSON event lines: ${jsonEvents}`);

  check('MEASURED: stable libtest offers NO machine-readable per-test event stream', () => {
    assert(jsonAttempt.status !== 0 || jsonEvents === 0,
      `stable libtest produced ${jsonEvents} JSON event lines — if that is real, Rust CAN have a re-countable channel and the adapter should use it`);
    assert(/unstable|json/i.test(jsonOut), `the refusal should name the unstable format: ${jsonOut.slice(0, 400)}`);
  });

  // Can Canary own the launch of each test binary? The runner key is per TARGET
  // triple, so it must be the triple the BUILD used — not rustc's default host
  // (this host has no MSVC linker, so the build ran on the GNU toolchain, and the
  // first run of this probe used the MSVC key and wrongly concluded "not honored").
  const usedTriple = (() => {
    const r = run(path.join(CARGO_HOME, 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'), ['-vV'], { env: rustEnvUsed });
    return /^host: (\S+)$/m.exec(r.stdout ?? '')?.[1] ?? hostTriple;
  })();
  const shimLog = path.join(TMP, 'rust-shim-ran.txt');
  const shim = path.join(TMP, 'rust-shim.cmd');
  fs.writeFileSync(shim, `@echo off\r\necho %* >> "${shimLog}"\r\n%*\r\n`);
  const runnerKey = `CARGO_TARGET_${usedTriple.toUpperCase().replace(/-/g, '_')}_RUNNER`;
  const withRunner = run(CARGO, ['test', '--quiet'], { cwd: crate, env: { ...rustEnvUsed, [runnerKey]: shim } });
  const shimRan = fs.existsSync(shimLog);
  console.log(`\n-- target triple in use: ${usedTriple}`);
  console.log(`-- ${runnerKey}=<shim> (exit ${withRunner.status}) -- shim invoked: ${shimRan}`);
  if (shimRan) console.log(fs.readFileSync(shimLog, 'utf8').trim().split('\n').slice(0, 2).join('\n'));

  check('MEASURED: cargo honors a Canary-owned runner shim (so Canary can own the test-binary launch)', () => {
    assert(shimRan, `${runnerKey} was not honored — Canary cannot intercept the test-binary launch this way`);
    assert(withRunner.status === 0, `the run through the shim must still pass: ${((withRunner.stdout ?? '') + (withRunner.stderr ?? '')).slice(-400)}`);
  });
} else {
  console.log(`\nRust channel facts NOT measured: ${rustWhy}`);
  rustSkip(`Rust: ${rustWhy}`);
  console.log('  (the adapter contract is still written against the DOCUMENTED behaviour, and the exact');
  console.log('   validation command for a host WITH a usable linker is printed at the end of this probe)');
}

// ═══════════════════════════════════ Go ═══════════════════════════════════
console.log('\n=== Go ===');
const goV = run(GO, ['version'], { env: goEnv });
console.log((goV.stdout ?? '').trim());

const mod = path.join(TMP, 'gomod');
fs.mkdirSync(mod, { recursive: true });
fs.writeFileSync(path.join(mod, 'go.mod'), 'module example.com/canaryprobe\n\ngo 1.22\n');
fs.writeFileSync(path.join(mod, 'lib.go'), 'package probe\n\nfunc Add(a, b int) int { return a + b }\n');
fs.writeFileSync(path.join(mod, 'lib_test.go'), [
  'package probe',
  '',
  'import "testing"',
  '',
  'func TestAdds(t *testing.T) { if Add(1, 1) != 2 { t.Fatal("nope") } }',
  'func TestAlsoAdds(t *testing.T) { if Add(2, 2) != 4 { t.Fatal("nope") } }',
  'func TestSkipped(t *testing.T) { t.Skip("not today") }',
  '',
].join('\n'));

const goTest = run(GO, ['test', './...'], { cwd: mod, env: goEnv });
console.log(`\n-- go test ./... (exit ${goTest.status}) --`);
console.log(((goTest.stdout ?? '') + (goTest.stderr ?? '')).trim().split('\n').slice(-5).join('\n'));

check('go test really runs', () => {
  assert(goTest.status === 0, `go test failed: ${((goTest.stdout ?? '') + (goTest.stderr ?? '')).slice(-800)}`);
});

const goJson = run(GO, ['test', '-json', './...'], { cwd: mod, env: goEnv });
const events = (goJson.stdout ?? '').split('\n').filter((l) => l.trim().startsWith('{'))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const passEvents = events.filter((e) => e.Action === 'pass' && typeof e.Test === 'string');
const skipEvents = events.filter((e) => e.Action === 'skip' && typeof e.Test === 'string');
console.log(`\n-- go test -json (exit ${goJson.status}) -- events=${events.length} test-pass=${passEvents.length} test-skip=${skipEvents.length}`);
console.log(`  pass ids: ${passEvents.map((e) => e.Test).join(', ')}`);

check('MEASURED: go test -json emits a per-test event stream Canary can independently re-count', () => {
  assert(goJson.status === 0, `go test -json failed: ${((goJson.stdout ?? '') + (goJson.stderr ?? '')).slice(-500)}`);
  assert(passEvents.length === 2, `expected 2 per-test pass events, got ${passEvents.length}`);
  assert(skipEvents.length === 1, `expected 1 per-test skip event, got ${skipEvents.length}`);
  assert(passEvents.every((e) => typeof e.Test === 'string' && e.Test !== ''), 'each pass event must name its test');
});

// Can Canary own the test-binary launch in Go?
const goShimLog = path.join(TMP, 'go-shim-ran.txt');
const goShim = path.join(TMP, 'go-shim.cmd');
fs.writeFileSync(goShim, `@echo off\r\necho %* >> "${goShimLog}"\r\n%*\r\n`);
const withExec = run(GO, ['test', `-exec=${goShim}`, './...'], { cwd: mod, env: goEnv });
const goShimRan = fs.existsSync(goShimLog);
console.log(`\n-- go test -exec=<shim> (exit ${withExec.status}) -- shim invoked: ${goShimRan}`);
if (goShimRan) console.log(fs.readFileSync(goShimLog, 'utf8').trim().split('\n').slice(0, 2).join('\n'));

check('MEASURED: go test -exec honors a Canary-owned shim (Canary can own the test-binary launch)', () => {
  assert(goShimRan, '-exec was not honored — Canary cannot intercept the test-binary launch this way');
  assert(withExec.status === 0, `the run through the shim must still pass: ${((withExec.stdout ?? '') + (withExec.stderr ?? '')).slice(-400)}`);
});

const SKIPS = [];
// ═══════════ can Canary's SANITIZED environment run these toolchains? ═══════════
// A toolchain that only works with the caller's environment is useless to Canary:
// verification children get `sanitizedEnv` — PATH = the Node install dir plus the
// OS dirs, HOME/USERPROFILE redirected to an isolated workspace dir, and nothing
// else. This is the decisive fact for whether a Rust or Go step can run at all,
// and it is the same class of question that made bare `git` fail inside a sealed
// step earlier in this project. Measured, not assumed.
console.log('\n=== under a sanitized environment (what a Canary step actually gets) ===');
const isolatedHome = path.join(TMP, 'isolated-home');
fs.mkdirSync(isolatedHome, { recursive: true });
const sanitized = (extra = {}) => ({
  PATH: `${path.dirname(process.execPath)};${path.join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32')};${process.env.SystemRoot ?? 'C:\\WINDOWS'}`,
  PATHEXT: '.EXE;.CMD',
  SystemRoot: process.env.SystemRoot ?? 'C:\\WINDOWS',
  ComSpec: path.join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'cmd.exe'),
  TEMP: path.join(TMP, 'tmp'), TMP: path.join(TMP, 'tmp'),
  HOME: isolatedHome, USERPROFILE: isolatedHome,
  ...extra,
});
fs.mkdirSync(path.join(TMP, 'tmp'), { recursive: true });

const goSanitized = run(GO, ['test', './...'], { cwd: mod, env: sanitized() });
const goSanitizedOk = goSanitized.status === 0;
console.log(`-- go test under sanitized env (exit ${goSanitized.status}) --`);
console.log(((goSanitized.stdout ?? '') + (goSanitized.stderr ?? '')).trim().split('\n').slice(0, 4).join('\n'));

// Rust: try the RUSTUP PROXY first (what a normal install seals), then the real
// toolchain binary (which finds its own rustc and needs no RUSTUP_HOME).
const cargoProxy = run(CARGO, ['test', '--quiet'], { cwd: crate, env: sanitized() });
const realCargo = path.join(RUSTUP_HOME, 'toolchains', 'stable-x86_64-pc-windows-gnu', 'bin', 'cargo.exe');
const cargoDirect = fs.existsSync(realCargo)
  ? run(realCargo, ['test', '--quiet'], { cwd: crate, env: sanitized() })
  : null;
console.log(`-- cargo (rustup proxy) under sanitized env (exit ${cargoProxy.status}) --`);
console.log(((cargoProxy.stdout ?? '') + (cargoProxy.stderr ?? '')).trim().split('\n').slice(0, 3).join('\n'));
if (cargoDirect !== null) {
  console.log(`-- real toolchain cargo under sanitized env (exit ${cargoDirect.status}) --`);
  console.log(((cargoDirect.stdout ?? '') + (cargoDirect.stderr ?? '')).trim().split('\n').slice(0, 3).join('\n'));
}

console.log(`\nRESULT: go usable in a sanitized env: ${goSanitizedOk}; `
  + `cargo via rustup proxy: ${cargoProxy.status === 0}; `
  + `cargo direct: ${cargoDirect === null ? 'not present' : String(cargoDirect.status === 0)}`);
console.log('This is what decides whether a Go/Rust step can run INSIDE Canary, as opposed to');
console.log('on a developer shell: a toolchain that needs the caller\'s HOME is not runnable by a step.');
console.log(`later validation command for a Rust host WITH a usable linker (MSVC Build Tools, or the GNU toolchain):`);
console.log(`  node tooling/toolchains.mjs rust && node tooling/probes/runner-channels-rust-go.mjs`);
console.log(`  (it measures whether stable libtest exposes a per-test event stream and whether`);
console.log(`   CARGO_TARGET_<TRIPLE>_RUNNER is honored — the two facts the Rust adapter rests on)`);
console.log(`scratch: ${TMP}`);
if (failures === 0 || process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
if (failures > 0) process.exit(1);
process.exit(rustSkipped > 0 ? 3 : 0);
