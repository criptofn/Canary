#!/usr/bin/env node
/**
 * A REAL Go project verified end to end by Canary (v1.1 Phase 2 follow-up).
 *
 * This is the proof that the Go toolchain declaration actually works through the
 * PRODUCT, not just in a hand-run shell: `canary setup` seals an absolute `go`
 * path, and `canary doctor` executes `go test ./...` and `go vet ./...` inside
 * Canary's sanitized environment.
 *
 * WHY IT NEEDED A FIX AT ALL, measured: under the sanitized env Go aborted with
 * `build cache is required, but could not be located: GOCACHE is not defined and
 * %LocalAppData% is not defined` — HOME/USERPROFILE are redirected, and Go
 * derives its cache from them. The Go adapter now declares a workspace-scoped
 * GOCACHE/GOPATH through the same narrow, allowlisted injection the observer env
 * uses (values must resolve inside Canary's workspace, so a PROJECT cannot steer
 * them). This probe is what turns that from a plausible fix into an observed one.
 *
 * Skips honestly (exit 3) when no Go toolchain exists, so it is usable as an
 * oracle step on hosts that cannot run it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(s, re, msg) { assert(re.test(s), `${msg}\n     expected /${re}/ in:\n     ${String(s).split('\n').slice(0, 18).join('\n     ')}`); }

if (!fs.existsSync(CLI)) { console.error(`FAIL: missing built CLI (run npm run build): ${CLI}`); process.exit(1); }

/** Go from PATH, or the workspace-local install (no admin rights needed). */
function resolveGo() {
  const onPath = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 30_000 });
  if (onPath.status === 0) return { exe: null, binDir: null, version: (onPath.stdout ?? '').trim() };
  const tc = path.join(REPO, '_toolchains', 'go', 'bin');
  const exe = path.join(tc, process.platform === 'win32' ? 'go.exe' : 'go');
  if (!fs.existsSync(exe)) return null;
  const r = spawnSync(exe, ['version'], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? { exe, binDir: tc, version: (r.stdout ?? '').trim() } : null;
}

const go = resolveGo();
if (go === null) {
  console.log('SKIP  Go: no toolchain on PATH and none workspace-local — run: node tooling/toolchains.mjs go');
  console.log('PROBE-PASS-WITH-SKIP — 1 explicit host-bound SKIP; the Go path was NOT executed here');
  process.exit(3);
}
console.log(`go: ${go.version}${go.binDir === null ? ' (system)' : ' (workspace-local)'}`);

const sep = process.platform === 'win32' ? ';' : ':';
const env = go.binDir === null ? { ...process.env } : { ...process.env, PATH: `${go.binDir}${sep}${process.env.PATH ?? ''}` };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-go-e2e-'));
const root = path.join(TMP, 'goproject');
fs.mkdirSync(root, { recursive: true });
// v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
// `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
// machine that has Claude Code installed and failed on every CI runner.
fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/greeter\n\ngo 1.22\n');
fs.writeFileSync(path.join(root, 'greeter.go'), 'package greeter\n\n// Greet returns a greeting.\nfunc Greet(name string) string { return "hello " + name }\n');
fs.writeFileSync(path.join(root, 'greeter_test.go'), [
  'package greeter',
  '',
  'import "testing"',
  '',
  'func TestGreet(t *testing.T) {',
  '\tif Greet("world") != "hello world" { t.Fatal("wrong greeting") }',
  '}',
  '',
].join('\n'));

const run = (args, timeout = 600_000) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout, env });
const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000 });

for (const args of [['init', '-b', 'main']]) assert(git(...args).status === 0, `git ${args.join(' ')} failed`);
git('config', 'user.email', 'go@canary.local');
git('config', 'user.name', 'Go E2E');
git('add', '-A');
git('commit', '-m', 'initial');

const setup = run(['setup', '--yes']);
console.log(`\n--- canary setup (exit ${setup.status}) ---`);
console.log(`${setup.stdout ?? ''}${setup.stderr ?? ''}`.trim().split('\n').slice(0, 14).join('\n'));

check('setup discovers the Go checks and seals an absolute go path', () => {
  assert(setup.status === 0, `setup must succeed on a Go module:\n${setup.stdout}${setup.stderr}`);
  // The plan prints the PINNED ABSOLUTE program, so match the pinned shape
  // (`<...>\go.exe test ./...`) rather than the bare declared name.
  assertMatch(setup.stdout ?? '', /go(\.exe)?\s+test\b/i, 'the plan must name the go test check');
  assertMatch(setup.stdout ?? '', /go(\.exe)?\s+vet\b/i, 'and the go vet check');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
  const argv0s = (cfg.plan ?? []).filter((s) => s.argv !== undefined).map((s) => s.argv[0]);
  assert(argv0s.length >= 2, `expected the Go steps to be argv steps: ${JSON.stringify(cfg.plan)}`);
  for (const a of argv0s) {
    assert(path.isAbsolute(a), `every sealed program must be an ABSOLUTE path, got ${a}`);
    assert(/go(\.exe)?$/i.test(a), `expected a go program, got ${a}`);
  }
});

const doctor = run(['doctor']);
console.log(`\n--- canary doctor (exit ${doctor.status}) ---`);
console.log(`${doctor.stdout ?? ''}${doctor.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n'));

check('doctor EXECUTES the Go plan under the sanitized env and reaches READY', () => {
  const out = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`;
  assert(doctor.status === 0, `doctor must be READY for a green Go project — this is the whole point of the toolchain declaration:\n${out}`);
  assertMatch(out, /READY/, 'READY must be earned by running the sealed plan');
  // The failure this fix removes, named so a regression is unmistakable:
  assert(!/GOCACHE is not defined/.test(out), 'the Go build-cache failure is back');
  assert(!/could not be located/.test(out), 'the Go build-cache failure is back');
});

check('the Go checks really ran (a failing test would be reported, not ignored)', () => {
  // Sanity: make the test fail and require the verdict to follow. Without this,
  // "READY" could come from a plan that never ran anything.
  fs.writeFileSync(path.join(root, 'greeter_test.go'), [
    'package greeter',
    '',
    'import "testing"',
    '',
    'func TestGreet(t *testing.T) {',
    '\tif Greet("world") != "goodbye world" { t.Fatal("deliberate failure") }',
    '}',
    '',
  ].join('\n'));
  const bad = run(['doctor']);
  const out = `${bad.stdout ?? ''}${bad.stderr ?? ''}`;
  assert(bad.status !== 0, `a failing Go test must not produce a green verdict:\n${out}`);
  assertMatch(out, /FAIL|not green|NEEDS ATTENTION/i, 'the failure must be reported');
});

console.log(`\n=== go project e2e: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
console.log(`scratch: ${TMP}`);
if (failures === 0 || process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
