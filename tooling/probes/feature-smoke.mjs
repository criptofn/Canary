#!/usr/bin/env node
/**
 * G. FEATURE-COMPLETE SMOKE (v1.1 item G).
 *
 * One run that walks the whole product surface end to end and says, per feature,
 * PASS / FAIL / SKIP — where SKIP is an EXPLICIT host-bound statement, never a
 * quiet pass. Exit 0 only when nothing failed and nothing was skipped; 1 on any
 * failure; 3 when everything that could run passed with listed SKIPs.
 *
 * Two deliberate choices:
 *
 *  - For the two guarantees that already have an authoritative demonstration
 *    (protected authority -> m9-authority, stale/forged proof rejection ->
 *    m8-promotion) this smoke RUNS THOSE PROBES rather than re-implementing their
 *    scenarios. A second implementation of a security scenario is a second thing
 *    to drift, and its green would prove less than theirs.
 *  - For Rust and Go it reports SKIP, because neither toolchain is installed on
 *    this host. An unexecuted path is not demonstrated, and this file will not
 *    pretend otherwise.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTerminal } from '../test-support/terminal.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const PASS_JS = `node "${path.join(FX, 'f-pass.js')}"`;

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);

/** The runner registry is a library, not a probe, so it is imported directly
 *  (top-level await: this file is ESM). */
const RUNNERS_MODULE = path.join(REPO, 'packages', 'runner', 'executor', 'dist', 'src', 'runners.js');
const runners = fs.existsSync(RUNNERS_MODULE) ? await import(`file://${RUNNERS_MODULE.replace(/\\/g, '/')}`) : null;

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(s, re, msg) { assert(re.test(s), `${msg}\n      expected /${re}/ in:\n      ${String(s).split('\n').slice(0, 24).join('\n      ')}`); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-feature-smoke-'));
let failures = 0;
let skips = 0;
const skip = (reason) => ({ skip: true, reason });

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
const canary = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 600_000 });
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-m', msg); };

function mk(name, files) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this every fixture here that
  // expects setup to SUCCEED passed only on a machine with Claude Code installed, and the
  // fixtures that expect a refusal could be refused for the wrong reason on a CI runner.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'smoke@canary.local');
  git(root, 'config', 'user.name', 'Feature Smoke');
  commit(root, 'initial');
  return root;
}
const nodeRepo = (name, extraScripts = {}) => mk(name, {
  'package.json': JSON.stringify({ name, private: true, scripts: { test: PASS_JS, ...extraScripts } }, null, 2) + '\n',
});

/** Run an authoritative probe and require its verdict. Declared with the other
 *  helpers (not next to its first use) because the ecosystem features above the
 *  re-use section also call it. */
const runProbe = (rel, label, expect) => {
  const r = spawnSync(process.execPath, [path.join(REPO, rel)], { cwd: REPO, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert(r.status === expect.status, `${label} exited ${r.status}, expected ${expect.status}:\n${out.split('\n').slice(-14).join('\n')}`);
  assertMatch(out, expect.match, `${label} did not report its verdict`);
  return out;
};

function feature(name, fn) {
  try {
    const r = fn();
    if (r && r.skip) { skips++; console.log(`SKIP  ${name}  ${r.reason}`); return; }
    console.log(`PASS  ${name}${r && r.note ? `  — ${r.note}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split('\n').join('\n      ')}`);
  }
}
function toolchain(cmd) {
  // `go version` vs `cargo --version`: Go's version command takes no dashes, and
  // asking it for `--version` errors — which silently read as "no toolchain".
  const argv = cmd === 'go' ? ['version'] : ['--version'];
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? (r.stdout ?? '').trim().split('\n')[0] : null;
}
/** A toolchain counts as available if it is on PATH OR provisioned workspace-locally
 *  (`node tooling/toolchains.mjs all`), because the latter is how this repository
 *  makes Rust and Go validatable without administrator rights. */
function toolchainWithLocal(which) {
  const onPath = toolchain(which);
  if (onPath !== null) return onPath;
  const tc = path.join(REPO, '_toolchains');
  const bin = which === 'go'
    ? path.join(tc, 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
    : path.join(tc, 'rust', 'cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  if (!fs.existsSync(bin)) return null;
  const env = which === 'rust'
    ? { ...process.env, CARGO_HOME: path.join(tc, 'rust', 'cargo'), RUSTUP_HOME: path.join(tc, 'rust', 'rustup'), RUSTUP_TOOLCHAIN: 'stable' }
    : process.env;
  const r = spawnSync(bin, which === 'go' ? ['version'] : ['--version'], { encoding: 'utf8', timeout: 120_000, env });
  return r.status === 0 ? `${(r.stdout ?? '').trim().split('\n')[0]} (workspace-local)` : null;
}

// ────────────────────────────── ecosystems ──────────────────────────────
feature('Node: objective work -> finish -> PROMOTED (no subjective duty)', () => {
  const root = nodeRepo('node-work');
  assert(canary(['setup', '--yes'], root).status === 0, 'setup must succeed on a plain Node repo');
  const w = canary(['work', 'w1', 'behaviour-preserving change', '--kind', 'refactor'], root);
  assert(w.status === 0, `work failed:\n${w.stdout}${w.stderr}`);
  const cand = path.join(root, '.canary', 'candidates', 'w1');
  assert(fs.existsSync(cand), 'work must print and create the candidate directory');
  fs.writeFileSync(path.join(cand, 'work.txt'), 'done\n');
  commit(cand, 'worker work');
  const f = canary(['finish', 'w1'], root);
  assert(f.status === 0, `finish failed:\n${f.stdout}${f.stderr}`);
  assertMatch(f.stdout, /PROMOTED/, 'finish must promote when the proof holds');
  assertMatch(f.stdout, /ACCEPTED/, 'and record the post-promotion proof verdict');
  return { note: 'work -> commit in the candidate -> finish -> base fast-forwarded' };
});

feature('Python: a real project with NO package.json anywhere', () => {
  const py = toolchain('python');
  if (py === null) return skip('no python on PATH — the Python journey cannot be executed here');
  const root = mk('python-only', {
    'pyproject.toml': '[project]\nname = "smoke-py"\nversion = "0.1.0"\n',
    'tests/test_ok.py': 'import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n',
  });
  assert(!fs.existsSync(path.join(root, 'package.json')), 'the fixture must have no package.json');
  const s = canary(['setup', '--yes'], root);
  assert(s.status === 0, `setup must succeed and find a runnable check:\n${s.stdout}${s.stderr}`);
  assertMatch(s.stdout, /python/i, 'the plan must name the python ecosystem');
  assertMatch(s.stdout, /unittest/i, 'unittest is discovered from the project layout, never invented');
  const d = canary(['doctor'], root);
  assert(d.status === 0, `doctor must be READY on a green Python project:\n${d.stdout}${d.stderr}`);
  assertMatch(d.stdout, /READY/, 'READY must be earned by running the sealed plan');
  return { note: `${py}; sealed check = python -m unittest discover` };
});

feature('Rust: cargo-compatible path', () => {
  const v = toolchainWithLocal('rust');
  if (v === null) return skip('no Rust toolchain (system or workspace-local) — run: node tooling/toolchains.mjs rust');
  // A REAL crate through the product. This is also the regression guard for the
  // resolution fix: setup must seal the REAL toolchain binary, because the rustup
  // PATH proxy cannot run under Canary's sanitized env.
  const out = runProbe('tooling/probes/rust-project-e2e.mjs', 'rust-project-e2e', { status: 0, match: /rust project e2e: ALL PASS/ });
  assertMatch(out, /toolchains[\\/]/, 'setup must seal the toolchain binary, not the proxy');
  assertMatch(out, /READY/, 'doctor must reach READY on a green crate');
  return { note: `${v}; setup sealed the real toolchain cargo and doctor ran cargo check/test/build under the sanitized env` };
});

feature('Go: go-compatible path', () => {
  const v = toolchainWithLocal('go');
  if (v === null) return skip('no Go toolchain (system or workspace-local) — run: node tooling/toolchains.mjs go');
  // A REAL Go project through the product: setup seals an absolute `go` path,
  // doctor executes `go test ./...` and `go vet ./...` under the sanitized env.
  const out = runProbe('tooling/probes/go-project-e2e.mjs', 'go-project-e2e', { status: 0, match: /go project e2e: ALL PASS/ });
  assertMatch(out, /READY/, 'doctor must reach READY on a green Go project');
  assertMatch(out, /a failing test would be reported/, 'the probe must have run its failing-test control');
  return { note: `${v}; setup + doctor executed the sealed Go plan under the sanitized env, and a deliberately broken test correctly failed the run` };
});

feature('Polyglot at the root: Node + a DECLARED Python scope', () => {
  const py = toolchain('python');
  if (py === null) return skip('no python on PATH — polyglot composition cannot be executed here');
  const root = mk('polyglot', {
    'package.json': JSON.stringify({ name: 'poly', private: true, scripts: { test: PASS_JS } }, null, 2) + '\n',
    'backend/pyproject.toml': '[project]\nname = "backend"\nversion = "0.1.0"\n',
    'backend/tests/test_ok.py': 'import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n',
    'canary.scopes.json': JSON.stringify({ schema: 'canary-scopes/1', scopes: [{ path: 'backend', ecosystem: 'python' }] }, null, 2) + '\n',
  });
  const s = canary(['setup', '--yes'], root);
  assert(s.status === 0, `setup failed:\n${s.stdout}${s.stderr}`);
  assertMatch(s.stdout, /python/i, 'the declared Python scope must contribute');
  assertMatch(s.stdout, /unittest|tests/, 'and contribute its own check');
  return { note: 'root Node check + declared backend/ Python check in ONE sealed plan' };
});

feature('Nested polyglot: scopes declared, NO root manifest', () => {
  const py = toolchain('python');
  if (py === null) return skip('no python on PATH — nested scope composition cannot be executed here');
  const root = mk('nested-polyglot', {
    'web/package.json': JSON.stringify({ name: 'web', private: true, scripts: { test: PASS_JS } }, null, 2) + '\n',
    'backend/pyproject.toml': '[project]\nname = "backend"\nversion = "0.1.0"\n',
    'backend/tests/test_ok.py': 'import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n',
    // a decoy that must NEVER be reached
    'archive/python-golden/pyproject.toml': '[project]\nname = "archived"\nversion = "0.0.1"\n',
    'canary.scopes.json': JSON.stringify({ schema: 'canary-scopes/1', scopes: [
      { path: 'web', ecosystem: 'node' }, { path: 'backend', ecosystem: 'python' }] }, null, 2) + '\n',
  });
  const s = canary(['setup', '--yes'], root);
  assert(s.status === 0, `setup failed:\n${s.stdout}${s.stderr}`);
  assertMatch(s.stdout, /web/i, 'the declared Node scope must contribute');
  assertMatch(s.stdout, /backend/i, 'the declared Python scope must contribute');
  assert(!/archived|archive/i.test(s.stdout), `the UNDECLARED archive/ tree must never contribute:\n${s.stdout}`);
  return { note: 'web/ Node + backend/ Python, archive/ excluded by construction' };
});

// ────────────────────────────── integrations ──────────────────────────────
feature('Claude integration: reported as GATED, never as advisory', () => {
  const root = nodeRepo('claude-int');
  assert(canary(['setup', '--yes'], root).status === 0, 'setup must wire the harness');
  const a = canary(['agents'], root);
  assertMatch(a.stdout, /claude/i, 'Claude Code must be named');
  assertMatch(a.stdout, /GATED/i, 'and its capability must be the real one');
  return { note: 'canary agents reports the real table for this repository' };
});

feature('Codex integration: reported as GATED, wired by setup, never as advisory', () => {
  // v1.4 §C — this feature used to assert the ADVISORY AGENTS.md block for Codex, because
  // `agents.ts` said "no completion hook exists to gate". That was measured false (codex-cli
  // 0.154.0: `hooks stable true`, a `Stop` event with the same stdin/stdout contract, and
  // `v14-codex-stop-hook.mjs` drives it). The assertions are therefore about the STRONGER claim, and
  // the advisory path is still asserted below for an integration that really is advisory.
  const root = nodeRepo('codex-int');
  // Declare the harness IN THE FIXTURE: `setup` reads `<root>/.codex` or the operator's `~/.codex`,
  // so without this the feature would depend on whose machine runs the probe.
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  assert(canary(['setup', '--yes'], root).status === 0, 'setup must succeed');
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  assert(fs.existsSync(hooksFile), 'setup must install the Codex Stop hook');
  const handlers = (JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []);
  assert(handlers.filter((h) => /checkpoint$/.test(String(h.command))).length === 1,
    `expected exactly one Canary Stop handler, got ${JSON.stringify(handlers)}`);
  const a = canary(['agents'], root);
  assertMatch(a.stdout, /GATED\s+OpenAI Codex CLI/, 'Codex must be reported with its real capability');
  assertMatch(a.stdout, /hook installed here/, 'and the hook must be reported as installed HERE');
  // The one step Canary does not own: an untrusted hook does not run. A GATED row without it would
  // be a written file read as protection.
  assertMatch(a.stdout, /one-time review and trust/, 'the trust step must be on the row');
  const advisory = canary(['agents', 'install', 'codex'], root);
  assert(advisory.status === 2, 'a GATING integration is installed by setup, not by an advisory command');
  return { note: 'Stop hook installed into .codex/hooks.json; GATED once trusted; advisory command refused' };
});

feature('Advisory capability: the marked AGENTS.md block is written and removable', () => {
  // The advisory mechanism itself still exists and is still exercised — through an integration that
  // is genuinely advisory, so the claim and the mechanism stay matched.
  const root = nodeRepo('advisory-int');
  assert(canary(['setup', '--yes'], root).status === 0, 'setup must succeed');
  const i = canary(['agents', 'install', 'generic'], root);
  assert(i.status === 0, `install failed:\n${i.stdout}${i.stderr}`);
  const agentsMd = path.join(root, 'AGENTS.md');
  assert(fs.existsSync(agentsMd), 'the advisory block must land in AGENTS.md');
  const text = fs.readFileSync(agentsMd, 'utf8');
  assert(/canary/i.test(text), 'the block must tell the agent to consult Canary');
  assert(/result --json|doctor/i.test(text), 'and name the real commands');
  const u = canary(['agents', 'uninstall', 'generic'], root);
  assert(u.status === 0, `uninstall failed:\n${u.stdout}${u.stderr}`);
  assert(!/canary/i.test(fs.readFileSync(agentsMd, 'utf8')), 'uninstall must remove exactly its own block');
  return { note: 'marked, removable, advisory-only — it cannot gate' };
});

feature('Generic agent: one JSON envelope, and an MCP handshake with no second authority', () => {
  const root = nodeRepo('generic-agent');
  assert(canary(['setup', '--yes'], root).status === 0, 'setup must succeed');
  const r = canary(['result', '--json'], root);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  assert(lines.length === 1, `stdout must carry exactly ONE envelope, got ${lines.length}:\n${r.stdout}`);
  const env = JSON.parse(lines[0]);
  assert(env.schema === 'canary-result/1', `wrong schema: ${env.schema}`);
  assertMatch(String(env.status), /CONNECTED/, 'a wired repo must report CONNECTED');

  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'canary_accept', arguments: { name: 'c' } } }),
  ].join('\n') + '\n';
  const m = spawnSync(process.execPath, [CLI, 'mcp'], { cwd: root, input, encoding: 'utf8', timeout: 180_000 });
  const replies = m.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  assert(replies.length === 3, `expected one reply per request:\n${m.stdout}`);
  assert(replies[0].result.serverInfo.name === 'canary', 'the MCP server must identify itself');
  const tools = replies[1].result.tools.map((t) => t.name);
  assert(!tools.includes('canary_accept'), 'acceptance must never be an MCP tool');
  assert(replies[2].result.isError === true, 'asking for acceptance by name must be refused, not silently absent');
  return { note: 'result --json: 1 envelope; mcp: 6 tools, accept refused with the reason' };
});

// ────────────────────────────── workflow ──────────────────────────────
feature('Subjective acceptance: a judgement closed from a terminal, never by an agent', () => {
  const root = nodeRepo('subjective');
  assert(canary(['setup', '--yes'], root).status === 0, 'setup must succeed');
  assert(canary(['task', 'make it look nicer', '--kind', 'ui'], root).status === 0, 'task registration must succeed');
  assert(canary(['isolate', 'c', root], root).status === 0, 'isolate must succeed');
  const cand = path.join(root, '.canary', 'candidates', 'c');
  fs.writeFileSync(path.join(cand, 'ui.txt'), 'styling\n');
  commit(cand, 'ui work');

  const v1 = canary(['isolate', '--verify', 'c'], root);
  assert(v1.status === 2, 'a subjective duty must block until accepted');
  assertMatch(v1.stdout, /NOT PROVEN/, 'and must say so');
  assertMatch(v1.stdout, /canary accept/, 'and print the real recovery command');

  const plain = canary(['accept', 'c'], root);
  assert(plain.status === 2, 'a PIPE session must be refused: an agent cannot accept its own work');
  assertMatch(plain.stdout, /REFUSED/, 'and must say why');

  const t = createTerminal({ repo: REPO, cli: CLI });
  const a = t.run(root, ['accept', 'c'], 'c\n');
  assertMatch(String(a.stdout), /ACCEPTED from this interactive terminal/, `accept must land:\n${a.stdout}`);
  const v2 = canary(['isolate', '--verify', 'c'], root);
  assert(v2.status === 0, `after acceptance the candidate must PASS:\n${v2.stdout}`);
  return t.provenRealPty
    ? { note: 'closed from a REAL pty; the non-TTY path was refused first' }
    : skip('the acceptance act EXECUTED and passed through the in-process terminal driver, but this host has no drivable real pty (see tty-capability.mjs) — the pty allocation itself is NOT proven here');
});

feature('Adaptive fast path: opt-in, sealed, and it says what it left out', () => {
  const root = mk('fastpath', {
    'package.json': JSON.stringify({ name: 'fastpath', private: true, scripts: { test: PASS_JS, typecheck: PASS_JS }, canary: { paths: { typecheck: ['src/**'] } } }, null, 2) + '\n',
    'src/app.js': 'export const v = 1;\n',
  });
  const s = canary(['setup', '--yes'], root);
  assert(s.status === 0, `setup must seal the declaration:\n${s.stdout}${s.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
  assert(cfg.planAuthority?.stepPaths?.typecheck?.[0] === 'src/**', 'canary.paths must be SEALED with the plan');
  fs.writeFileSync(path.join(root, 'README.md'), '# docs only\n');
  commit(root, 'docs only');
  const fast = canary(['doctor', '--fast'], root);
  assertMatch(fast.stdout, /skip/i, `--fast must print every skip:\n${fast.stdout}`);
  assertMatch(fast.stdout, /typecheck/, 'and name the check it left out');
  const full = canary(['doctor'], root);
  assert(!/skip/i.test(full.stdout), `WITHOUT --fast the full plan runs:\n${full.stdout}`);
  return { note: 'declaration sealed at setup; skips named in the output' };
});

feature('Runner observations: four runners can reach a strong label, and only those', () => {
  assert(runners !== null, `missing built registry: ${RUNNERS_MODULE}`);
  const { observationCapabilityFor, runnerRegistryProblems, RUNNER_ADAPTERS } = runners;
  assert(runnerRegistryProblems().length === 0, `the registry is inconsistent: ${runnerRegistryProblems().join('; ')}`);
  const strong = RUNNER_ADAPTERS.filter((a) => a.capability === 'STRONG').map((a) => a.id).sort();
  assert(JSON.stringify(strong) === JSON.stringify(['mocha', 'node-test', 'pytest', 'unittest']),
    `the observed set must be exactly the four implemented channels: ${JSON.stringify(strong)}`);
  // Each authority is a different KIND of binding, and each is named.
  const byId = new Map(RUNNER_ADAPTERS.map((a) => [a.id, a]));
  assert(byId.get('mocha').observation.authority === 'package-pin', 'mocha is bound by a repo pin');
  assert(byId.get('node-test').observation.authority === 'runtime-identity', 'node:test IS the verifying runtime');
  assert(byId.get('pytest').observation.authority === 'operator-identity', 'pytest is bound by a sealed identity');
  assert(byId.get('unittest').observation.authority === 'operator-identity', 'unittest is bound by a sealed identity');
  for (const ref of [{ program: 'jest' }, { script: 'cargo test' }, { script: 'ctest --test-dir build' }, { program: 'who-knows' }]) {
    assert(observationCapabilityFor(ref).capability === 'INCONCLUSIVE_ONLY', `an unobserved runner must be INCONCLUSIVE: ${JSON.stringify(ref)}`);
  }
  return { note: 'STRONG = {mocha, node-test, pytest, unittest}; every other or unknown runner is INCONCLUSIVE by construction' };
});

feature('Universal project: an ecosystem Canary has no adapter for is DISCOVERED, not refused', () => {
  // The discovery path needs a tool to BE there. `make`/`cmake`/`ctest` are not on
  // this host, so two deterministic fixture tools are built with the workspace-local
  // Go toolchain and put on PATH — which is exactly the substitution the owner's
  // brief allows: real executable behaviour, no language-specific Canary logic.
  const GO = path.join(REPO, '_toolchains', 'go', 'bin', 'go.exe');
  if (!fs.existsSync(GO)) return skip('no workspace-local Go toolchain to build the fixture tools');
  const toolDir = path.join(TMP, 'universal-tools');
  fs.mkdirSync(toolDir, { recursive: true });
  const build = (name, behaviour) => {
    const src = path.join(TMP, `fx-${name}.go`);
    fs.writeFileSync(path.join(TMP, 'fx-go.mod'), 'module fx\n\ngo 1.21\n');
    fs.writeFileSync(src, behaviour);
    const r = spawnSync(GO, ['build', '-o', path.join(toolDir, `${name}.exe`), src], {
      cwd: TMP, encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, GOCACHE: path.join(TMP, 'fx-cache'), GOPATH: path.join(TMP, 'fx-path'), GOTOOLCHAIN: 'local' },
    });
    assert(r.status === 0, `building the ${name} fixture failed: ${r.stdout}${r.stderr}`);
  };
  // A ctest-shaped tool that can be made to fail, and a cmake-shaped one that passes.
  build('ctest', 'package main\n\nimport (\n\t"fmt"\n\t"os"\n\t"strings"\n)\n\nfunc main() {\n\traw, _ := os.ReadFile("ctest.marker")\n\tif strings.Contains(string(raw), "FAIL") {\n\t\tfmt.Println("100% tests passed, 0 tests failed out of 3")\n\t\tfmt.Println("Failed: 1")\n\t\tos.Exit(8)\n\t}\n\tfmt.Println("100% tests passed, 0 tests failed out of 3")\n}\n');
  build('cmake', 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("-- build complete") }\n');

  const root = mk('universal-discovery', {
    'CMakeLists.txt': 'project(demo C)\nadd_executable(demo main.c)\nenable_testing()\nadd_test(NAME smoke COMMAND demo)\n',
    'build/CMakeCache.txt': '# configured by a previous run\n',
    'main.c': 'int main(void){return 0;}\n',
  });
  // `mk` already git-initialised and committed. Put the fixture tools on PATH for
  // setup — the ONE moment PATH is consulted, after which the sealed plan holds
  // absolute paths.
  const setupEnv = { ...process.env, PATH: `${toolDir}${path.delimiter}${process.env.PATH ?? ''}` };
  const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { cwd: root, encoding: 'utf8', timeout: 600_000, env: setupEnv });
  assert(setup.status === 0, `setup must onboard a discovered universal project:\n${setup.stdout}${setup.stderr}`);
  assertMatch(setup.stdout, /package manager: universal/, 'the contract is named');
  assertMatch(setup.stdout, /ctest/, 'the CTest check was DISCOVERED from the CMake configuration');

  const config = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
  const argvSteps = config.plan.filter((s) => Array.isArray(s.argv));
  assert(argvSteps.length >= 2, `expected discovered argv checks: ${JSON.stringify(config.plan)}`);
  assert(argvSteps.every((s) => s.adapter === 'universal'), 'every discovered step names its contract');
  assert(argvSteps.every((s) => path.isAbsolute(s.argv[0])), `setup must PIN the programs absolutely: ${JSON.stringify(argvSteps.map((s) => s.argv))}`);
  assert(argvSteps.some((s) => s.kind === 'tests'), 'the test check was discovered');

  // Run with NO fixture tools on PATH: the pinned absolute paths are the authority.
  const doctor = canary(['doctor', root], root);
  assert(doctor.status === 0, `the discovered checks must run and pass:\n${doctor.stdout}${doctor.stderr}`);
  assertMatch(doctor.stdout, /tests: .*ctest\.exe --test-dir build --output-on-failure \(exit 0\)/, 'the discovered test check really ran');

  // And a failing check fails the run.
  fs.writeFileSync(path.join(root, 'ctest.marker'), 'FAIL\n');
  const failed = canary(['doctor', root], root);
  assert(failed.status !== 0, `a failing discovered check must fail:\n${failed.stdout}`);

  // Ambiguity is asked about, never resolved by preference.
  const ambiguous = mk('universal-ambiguous', { 'Taskfile.yml': 'tasks:\n  test:\n    cmds: [true]\n', Justfile: 'test:\n  true\n' });
  const amb = canary(['setup', '--yes', ambiguous], ambiguous);
  assert(amb.status !== 0, 'an ambiguous repository must NOT be onboarded by guessing');
  assertMatch(amb.stdout, /ambiguous/, 'and it must say why');

  // Nothing is invented when nothing anchors a command.
  const empty = mk('universal-empty', { 'README.md': '# nothing to discover\n', 'main.c': 'int main(void){return 0;}\n' });
  const none = canary(['setup', '--yes', empty], empty);
  assert(none.status !== 0, 'a repository with no anchored check must not be given an invented plan');
  return { note: `${argvSteps.length} checks DISCOVERED from CMake/CTest evidence, pinned absolutely, executed; ambiguity asked about; nothing invented` };
});

feature('Provider-only routing: a configured provider closes the local accept/promote path', async () => {
  const mod = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'provider', 'routing.js');
  assert(fs.existsSync(mod), `missing built routing module: ${mod}`);
  const routing = await import(`file://${mod.replace(/\\/g, '/')}`);
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-smoke-store-'));
  try {
    // No token and no enrolled identity: NOT a provider, so the local path stays
    // (asserted, because "closing" the local path must not change a machine that
    // never installed one).
    assert(routing.brokerRoutingRequired({ root: store }) === false, 'a bare store is not a configured provider');
    const bare = await routing.reservePromotionThroughBroker({ projectId: 'p', candidate: 'c' }, { root: store });
    assert(bare.routed === false, 'with no provider the act is not routed at all');
    // A broker token IS a configured provider, and then the act must be routed and
    // must FAIL CLOSED when no broker answers.
    fs.writeFileSync(path.join(store, 'provider-token'), 'x'.repeat(64) + '\n');
    assert(routing.brokerRoutingRequired({ root: store }) === true, 'a token IS a configured provider');
    const routed = await routing.reservePromotionThroughBroker({ projectId: 'p', candidate: 'c' }, { root: store });
    assert(routed.routed === true && routed.ok === false, `an unreachable broker must be a refusal: ${JSON.stringify(routed)}`);
    assert(routed.code === 'connect-failed', `the refusal must name the cause: ${JSON.stringify(routed)}`);
    return { note: 'no provider => local path unchanged; provider => routed, and an unreachable broker fails closed' };
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

// ───────────────────── re-used authoritative demonstrations ─────────────────────
// (`runProbe` is declared with the other helpers at the top of this file.)

feature('Protected authority: candidate-modified Canary cannot judge its own mutation', () => {
  const out = runProbe('tooling/probes/m9-authority.mjs', 'm9-authority', { status: 0, match: /ALL PASS/ });
  return { note: `${(out.match(/^PASS .*$/gm) ?? []).length} authority scenarios (the §9 mandate fires)` };
});

feature('Stale/forged proof rejection: a stored PASS cannot authorize a promotion', () => {
  const out = runProbe('tooling/probes/m8-promotion.mjs', 'm8-promotion', { status: 0, match: /ALL PASS/ });
  return { note: `${(out.match(/^PASS .*$/gm) ?? []).length} promotion scenarios (live re-verification decides)` };
});

feature('Standalone install: a single executable that runs with no Node installed', () => {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const exe = path.join(REPO, 'pack', 'standalone', `canary-${process.platform}-${process.arch}${ext}`);
  if (!fs.existsSync(exe)) return skip(`no standalone artifact for this host — run \`npm run standalone\` first (expected ${exe})`);
  const sep = process.platform === 'win32' ? ';' : ':';
  const nodeDir = path.dirname(process.execPath);
  const env = { ...process.env, PATH: (process.env.PATH ?? '').split(sep).filter((d) => d.trim() !== '' && path.resolve(d).toLowerCase() !== path.resolve(nodeDir).toLowerCase()).join(sep) };
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 120_000, env });
  assert(r.status === 0 && /^canary \d+/.test((r.stdout ?? '').trim()), `the standalone binary must run with Node removed from PATH: ${r.stdout}${r.stderr}`);
  return { note: `${path.relative(REPO, exe)} --version -> ${(r.stdout ?? '').trim()} with Node off PATH` };
});

feature('HARDENED provider: proven where the host can prove it, SKIPPED where it cannot', () => {
  const out = runProbe('tooling/probes/provider-boundary.mjs', 'provider-boundary', { status: 0, match: /HONEST POSTURE HOLDS/ });
  assertMatch(out, /UNAVAILABLE/, 'the six boundary controls must be reported unavailable with reasons');
  return skip('this host has no second OS identity: not elevated, no provider store, no CanaryBroker service. The tripwire PROVED HARDENED is unreachable and named the exact privileged commands; the boundary itself is NOT claimed here');
});

feature('Python execution observation: a real unittest run is WATCHED, and text cannot forge it', () => {
  const py = toolchain('python');
  if (py === null) return skip('no python on PATH — the Python observation channel cannot be executed here');
  const out = runProbe('tooling/probes/runner-observation-python.mjs', 'python-observation', { status: 0, match: /python observation: ALL PASS/ });
  return {
    note: 'sitecustomize injected on PYTHONPATH; hello/pass/pending/bye observed; printed-summary forgery yields ZERO passes; '
      + 'a fabricated addSuccess is rejected',
  };
});

feature('Rust and Go channels: MEASURED with workspace-local toolchains, not assumed', () => {
  // These toolchains are provisioned user-locally by tooling/toolchains.mjs, so
  // "no toolchain" is no longer an acceptable reason to leave these unmeasured.
  const hasGo = toolchain('go') !== null || fs.existsSync(path.join(REPO, '_toolchains', 'go', 'bin', 'go.exe'));
  const hasRust = fs.existsSync(path.join(REPO, '_toolchains', 'rust', 'cargo', 'bin', 'cargo.exe'));
  if (!hasGo && !hasRust) return skip('no workspace-local toolchains — run: node tooling/toolchains.mjs all');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tooling', 'probes', 'runner-channels-rust-go.mjs')],
    { cwd: REPO, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // Exit 3 = the Rust facts could not be measured (no usable linker). That is an
  // honest host SKIP, never a failure, and never a pass.
  assert(r.status === 0 || r.status === 3, `channel measurement exited ${r.status}:\n${out.split('\n').slice(-12).join('\n')}`);
  assertMatch(out, /MEASURED/, 'the probe must report measured facts');
  if (r.status === 3) return skip('Go facts measured; Rust could not be measured on this host (no usable linker) — see the probe output');
  return { note: 'Go: -json per-test events + -exec shim honored. Rust: stable libtest has NO event stream (compiler refusal), runner shim honored' };
});

feature('Protected-provider capability reporting: HARDENED is measured, never declared', () => {
  const cli = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-smoke-provider-'));
  const env = { ...process.env, CANARY_TRUST_STORE: store };
  try {
    const status = spawnSync(process.execPath, [cli, 'provider', 'status', '--json'], { encoding: 'utf8', timeout: 120_000, env });
    const line = (status.stdout ?? '').split(/\r?\n/).find((l) => l.trim().startsWith('{'));
    const envelope = line ? JSON.parse(line) : null;
    assert(envelope !== null, `no envelope: ${status.stdout}${status.stderr}`);
    assert(envelope.schema === 'canary-provider-status/1', `wrong schema: ${envelope.schema}`);
    assert(envelope.status === 'NOT CONNECTED', `a provider without a boundary must not read READY: ${envelope.status}`);
    assert(envelope.exitCode === 2, `exitCode must be 2, got ${envelope.exitCode}`);
    assert(Array.isArray(envelope.problems) && envelope.problems.length === 6,
      `all six controls must be reported missing, got ${JSON.stringify(envelope.problems)}`);

    // The PROVIDER must not be installed as a side effect of asking about it.
    if (process.platform === 'win32') {
      const q = spawnSync('sc.exe', ['query', 'CanaryBroker'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      assert(q.status !== 0, 'a CanaryBroker service exists — asking about the provider must not install it');
    }
    const call = spawnSync(process.execPath, [cli, 'provider', 'call', 'broker.hello'], { encoding: 'utf8', timeout: 60_000, env });
    assert(call.status !== 0, 'a worker call with no broker running must be refused, not silently done locally');
    return { note: 'NOT CONNECTED, 6 controls missing, no service installed as a side effect, worker call refused' };
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

feature('Provider activation state: the privileged step is prepared and NOT taken', () => {
  const cli = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
  const plan = spawnSync(process.execPath, [cli, 'provider', 'install-plan'], { encoding: 'utf8', timeout: 120_000 });
  const out = `${plan.stdout ?? ''}${plan.stderr ?? ''}`;
  assert(plan.status === 0, `install-plan failed: ${out.slice(-400)}`);
  assertMatch(out, /OWNER AUTHORIZATION REQUIRED/, 'the plan must name what it waits for');
  for (const needle of ['net user', 'sc.exe create', 'icacls']) assert(out.includes(needle), `the plan must name ${needle}`);
  assertMatch(out, /Nothing in this command executed any of the above/, 'it must state that nothing ran');
  return { note: 'exact privileged commands + rollback + post-state + verification command printed; executed: none' };
});

// ────────────────────────────── verdict ──────────────────────────────
console.log(`\n=== feature-complete smoke: ${failures} FAIL, ${skips} host-bound SKIP ===`);
console.log('Features: node, python(no package.json), rust, go, polyglot, nested polyglot, claude, codex,');
console.log('          generic agent, objective work/finish, subjective acceptance, adaptive fast path,');
console.log('          runner observations, protected authority, stale proof rejection, standalone, HARDENED.');
console.log(`Scratch: ${TMP}`);
if (process.env.CANARY_SMOKE_CLEAN === '1') fs.rmSync(TMP, { recursive: true, force: true });
if (failures > 0) { console.log(`FEATURE-SMOKE: ${failures} FAILURE(S)`); process.exit(1); }
if (skips > 0) { console.log(`PROBE-PASS-WITH-SKIP — ${skips} explicit host-bound SKIP(s); NOT full feature acceptance on this host`); process.exit(3); }
console.log('FEATURE-SMOKE: ALL PASS');
process.exit(0);
