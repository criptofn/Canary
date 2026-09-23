// v1.3 §E — does the AGENT actually accept what `setup` wired?
//
// The journey probe verifies the MCP server answers the protocol (handshake, tools/list) and that the
// Stop hook decides correctly. Neither of those answers the question a user asks: *is my editor
// actually connected to this?* That question has a deterministic answer, because the agent CLI exposes
// it without spending a single model token: `claude mcp list` reports, per server, the exact command
// it read and whether the connection is live.
//
// MEASURED, and the reason this file exists: the answer is NOT "connected". Claude Code reads Canary's
// project entry and then holds it at "Pending approval" until a human approves the project's MCP
// server once, in an interactive session. That is Claude Code's consent gate, not a Canary defect —
// and it is exactly the kind of detail that turns into a false "seamless integration" claim if nobody
// measures it. So this probe ASSERTS what is Canary's (the entry is written and the agent READ its
// exact command) and REPORTS what is the harness's (the approval state), never asserting a human act.
//
// It is host-bound by construction: no Claude Code CLI, no measurement — an explicit SKIP, which is
// never a pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const claude = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-agent-integration-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};

if (!fs.existsSync(claude)) {
  console.log(`SKIP host-bound: no Claude Code CLI at ${claude} — the agent side of this integration cannot be measured here`);
  console.log(`\n=== agent integration: SKIP (host-bound) — NOT a pass ===`);
  process.exit(0);
}

const run = (exe, args, cwd) => spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });

try {
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(temp, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({
    name: 'agent-integration', private: true, scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(temp, 'package-lock.json'), JSON.stringify({
    name: 'agent-integration', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {},
  }, null, 2) + '\n');
  run(git, ['init', '-b', 'main'], temp);
  run(git, ['config', 'user.email', 'integration@canary.local'], temp);
  run(git, ['config', 'user.name', 'Integration Probe'], temp);
  run(git, ['add', '-A'], temp);
  run(git, ['commit', '-m', 'base'], temp);

  const setup = run(process.execPath, [cli, 'setup', '--yes'], temp);
  assert.equal(setup.status, 0, `setup must succeed:\n${setup.stdout}${setup.stderr}`);

  // ── what CANARY is responsible for: the entry exists, and it is ours by argv signature ──
  let doc = null;
  check('setup writes an MCP entry that names THIS Canary', () => {
    doc = JSON.parse(fs.readFileSync(path.join(temp, '.mcp.json'), 'utf8'));
    const entry = doc?.mcpServers?.canary;
    assert.ok(entry, `.mcp.json has no canary entry: ${JSON.stringify(doc)}`);
    assert.ok(Array.isArray(entry.args) && entry.args.at(-1) === 'mcp', `unexpected args: ${JSON.stringify(entry.args)}`);
    assert.ok(entry.args.some((a) => a.endsWith('main.js')), 'the entry must point at this CLI');
  });

  // ── what the AGENT is responsible for: it read that entry ──
  const listed = run(claude, ['mcp', 'list'], temp);
  const out = `${listed.stdout}${listed.stderr}`;
  console.log('--- claude mcp list ---');
  console.log(out.trimEnd());
  console.log('--- end ---');

  check('the agent CLI READS Canary from the project entry', () => {
    assert.equal(listed.status, 0, `claude mcp list exited ${listed.status}:\n${out}`);
    const line = out.split('\n').find((l) => /^\s*canary\s*:/.test(l));
    assert.ok(line, `Claude Code did not list a "canary" server:\n${out}`);
    assert.match(line, /mcp/, `the listed command must be the MCP server: ${line}`);
  });

  // ── the honest part: the state of the harness's own consent gate, reported not asserted ──
  const line = out.split('\n').find((l) => /^\s*canary\s*:/.test(l)) ?? '';
  const state = /Pending approval/i.test(line) ? 'PENDING HUMAN APPROVAL (Claude Code asks once, in an interactive session)'
    : /Connected/i.test(line) ? 'connected'
      : /Failed to connect/i.test(line) ? 'FAILED TO CONNECT' : 'unrecognised';
  console.log(`\nOBSERVED integration state: ${state}`);
  console.log('  This is the harness\'s consent gate, not Canary\'s code: Canary writes the entry and the');
  console.log('  server answers the protocol (see the journey probe); Claude Code decides when to honour it.');
  const failedToConnect = /Failed to connect/i.test(line);
  check('the agent does not report our server as BROKEN', () => {
    assert.equal(failedToConnect, false, `Claude Code could not run the server: ${line}`);
  });

  console.log(`\n=== agent integration: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} (1 host-reported state above, reported not asserted) ===`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
