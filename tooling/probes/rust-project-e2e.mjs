#!/usr/bin/env node
/**
 * A REAL Rust project verified end to end by Canary (v1.1 Phase 2 follow-up).
 *
 * THE DEFECT THIS PROVES FIXED, measured: setup pinned whatever `cargo` PATH
 * resolved to — which for a rustup install is the PROXY at `<cargo home>/bin` —
 * and that proxy cannot run inside Canary's sanitized environment
 * ("rustup could not choose a version of cargo to run": RUSTUP_HOME/HOME are
 * redirected). So a Rust plan could be discovered, sealed, and then never
 * execute. The real toolchain binary at `<rustup home>/toolchains/<tc>/bin/cargo`
 * needs no environment at all and runs fine.
 *
 * The Rust adapter therefore DECLARES the literal toolchain locations, and setup
 * prefers adapter-declared directories over PATH. This probe asserts the sealed
 * program is the REAL toolchain binary (not the proxy) and that `doctor` reaches
 * READY by actually running `cargo test` / `cargo check` / `cargo build`.
 *
 * Skips honestly (exit 3) when no Rust toolchain exists.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const TC = path.join(REPO, '_toolchains', 'rust');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(s, re, msg) { assert(re.test(s), `${msg}\n     expected /${re}/ in:\n     ${String(s).split('\n').slice(0, 18).join('\n     ')}`); }

if (!fs.existsSync(CLI)) { console.error(`FAIL: missing built CLI (run npm run build): ${CLI}`); process.exit(1); }

/** Rustup/cargo homes: the workspace-local install if present, else the user's. */
function resolveRust() {
  const local = { cargoHome: path.join(TC, 'cargo'), rustupHome: path.join(TC, 'rustup') };
  const localOk = fs.existsSync(path.join(local.rustupHome, 'toolchains')) || fs.existsSync(path.join(local.cargoHome, 'bin'));
  const homes = localOk
    ? local
    : { cargoHome: path.join(os.homedir(), '.cargo'), rustupHome: path.join(os.homedir(), '.rustup') };
  const toolchainsDir = path.join(homes.rustupHome, 'toolchains');
  let toolchains = [];
  try { toolchains = fs.readdirSync(toolchainsDir); } catch { toolchains = []; }
  const real = toolchains
    .map((tc) => path.join(toolchainsDir, tc, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'))
    .find((p) => fs.existsSync(p));
  return { ...homes, toolchains, real: real ?? null };
}

const rust = resolveRust();
if (rust.real === null) {
  console.log('SKIP  Rust: no rustup toolchain found (no <rustup home>/toolchains/*/bin/cargo)');
  console.log('      provision with: node tooling/toolchains.mjs rust');
  console.log('PROBE-PASS-WITH-SKIP — 1 explicit host-bound SKIP; the Rust path was NOT executed here');
  process.exit(3);
}
console.log(`rust: real toolchain binary ${rust.real}`);
console.log(`homes: RUSTUP_HOME=${rust.rustupHome} CARGO_HOME=${rust.cargoHome}`);

const env = {
  ...process.env,
  RUSTUP_HOME: rust.rustupHome,
  CARGO_HOME: rust.cargoHome,
  CARGO_TERM_COLOR: 'never',
  // The workspace-local install has one toolchain and it is the GNU one; a
  // user-wide rustup has its own default. Naming it keeps the probe deterministic
  // without pretending the default exists.
  ...(rust.toolchains.includes('stable-x86_64-pc-windows-gnu') ? { RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-gnu' } : {}),
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-rust-e2e-'));
const root = path.join(TMP, 'crate');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
// v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
// `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
// machine that has Claude Code installed and failed on every CI runner.
fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "canary_e2e"\nversion = "0.1.0"\nedition = "2021"\n');
fs.writeFileSync(path.join(root, 'src', 'lib.rs'), [
  'pub fn greet(name: &str) -> String { format!("hello {name}") }',
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    use super::*;',
  '    #[test]',
  '    fn greets() { assert_eq!(greet("world"), "hello world"); }',
  '}',
  '',
].join('\n'));

const run = (args, timeout = 900_000) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout, env });
const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000 });

assert(git('init', '-b', 'main').status === 0, 'git init failed');
git('config', 'user.email', 'rust@canary.local');
git('config', 'user.name', 'Rust E2E');
git('add', '-A');
git('commit', '-m', 'initial');

const setup = run(['setup', '--yes']);
console.log(`\n--- canary setup (exit ${setup.status}) ---`);
console.log(`${setup.stdout ?? ''}${setup.stderr ?? ''}`.trim().split('\n').slice(0, 14).join('\n'));

check('setup seals the REAL toolchain binary, not the rustup proxy', () => {
  assert(setup.status === 0, `setup must succeed on a crate:\n${setup.stdout}${setup.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
  const argv0s = (cfg.plan ?? []).filter((s) => s.argv !== undefined).map((s) => s.argv[0]);
  assert(argv0s.length >= 2, `expected cargo argv steps: ${JSON.stringify(cfg.plan)}`);
  for (const a of argv0s) {
    assert(path.isAbsolute(a), `every sealed program must be an absolute path, got ${a}`);
    assert(/cargo(\.exe)?$/i.test(a), `expected a cargo program, got ${a}`);
    // The whole point: NOT `<cargo home>/bin/cargo` (the proxy).
    const inToolchains = /[\\/]toolchains[\\/]/.test(a);
    assert(inToolchains, `setup sealed the PATH PROXY (${a}); it must prefer the real toolchain binary under <rustup home>/toolchains/<tc>/bin`);
  }
});

const doctor = run(['doctor']);
console.log(`\n--- canary doctor (exit ${doctor.status}) ---`);
console.log(`${doctor.stdout ?? ''}${doctor.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n'));

check('doctor EXECUTES the Rust plan under the sanitized env and reaches READY', () => {
  const out = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`;
  assert(doctor.status === 0, `doctor must be READY for a green crate:\n${out}`);
  assertMatch(out, /READY/, 'READY must be earned by running the sealed plan');
  assert(!/could not choose a version of cargo/.test(out), 'the rustup-proxy failure is back');
});

check('the Rust checks really ran (a failing test would be reported, not ignored)', () => {
  fs.writeFileSync(path.join(root, 'src', 'lib.rs'), [
    'pub fn greet(name: &str) -> String { format!("goodbye {name}") }',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '    #[test]',
    '    fn greets() { assert_eq!(greet("world"), "hello world"); }',
    '}',
    '',
  ].join('\n'));
  const bad = run(['doctor']);
  const out = `${bad.stdout ?? ''}${bad.stderr ?? ''}`;
  assert(bad.status !== 0, `a failing Rust test must not produce a green verdict:\n${out}`);
  assertMatch(out, /FAIL|not green|NEEDS ATTENTION/i, 'the failure must be reported');
});

console.log(`\n=== rust project e2e: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
console.log(`scratch: ${TMP}`);
if (failures === 0 || process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
