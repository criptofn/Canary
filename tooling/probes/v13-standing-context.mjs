// v1.3 §17 — WHAT DOES CANARY COST ON *EVERY* TURN, WHETHER OR NOT IT IS USED?
//
// The token requirement is measured on turns and accumulated context: in the recorded ledgers the
// dominant term is cache-read, because every turn re-reads the whole conversation. Anything Canary
// puts into that conversation is therefore paid once per turn, not once per session. The MCP server
// is exactly that kind of cost: its instructions and its tool definitions are advertised to the
// client at handshake time and re-sent on every request afterwards.
//
// So this probe measures the standing payload of the everyday path — the bytes a real client
// receives before the model has done anything — and attributes them per tool, because a tool that
// the everyday user never calls is still paid for on every turn.
//
// It also records the shape the BENCHMARK measures. Historically
// `tooling/benchmark/run-trial.mjs` ran the agent with `--strict-mcp-config` and NO
// `--mcp-config`, which kept a developer's own MCP servers out of the measurement but had a
// second consequence: the fixture's own `.mcp.json`, written by the `canary setup` the trial
// just ran, was not loaded either. The measured canary arms were therefore the Stop-hook-only
// shape, and the payload measured below was NOT in the 92.7% figure.
//
// v1.5 CLOSED THAT. `run-trial.mjs` now passes `--mcp-config <fixture>/.mcp.json` whenever the
// fixture has one (i.e. for every arm that ran `canary setup`), so the standing payload IS
// inside the measurement, and the everyday figure was re-derived from a fresh run
// (`docs/BENCHMARK-EVERYDAY-1.5.md`). A4 below now asserts that state, so a regression that
// silently drops the payload — and thereby flatters Canary — fails this probe.
//
// ESTIMATES ARE LABELLED. Everything in the PASS/FAIL checks is measured. The token arithmetic
// in the measurement section is provider-native (measured by
// `tooling/probes/v15-mcp-standing-payload.mjs`); the bytes/4 figure is kept only as a labelled
// cross-check that the two disagree by a large factor, which is itself worth knowing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-standing-'));
const project = path.join(temp, 'project');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The tools that belong to the EXPERT surface: the candidate lifecycle the audit measured as
 *  costing 177.8% of plain. An everyday user never calls these, and pays for them per turn. */
const CEREMONY = ['canary_work', 'canary_finish'];

const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'local-trust') };
const run = (exe, args, cwd, input) => spawnSync(exe, args, {
  cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300000,
  ...(input === undefined ? {} : { input }),
});

try {
  fs.mkdirSync(project, { recursive: true });
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'standing-context', private: true, scripts: { test: 'node greeting.test.cjs' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'package-lock.json'), JSON.stringify({
    name: 'standing-context', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {},
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'greeting.cjs'), 'module.exports = (name) => `Hello, ${name}!`;\n');
  fs.writeFileSync(path.join(project, 'greeting.test.cjs'),
    "const assert = require('node:assert');\nconst g = require('./greeting.cjs');\nassert.strictEqual(g('a'), 'Hello, a!');\nconsole.log('ok');\n");

  // The fixture must be its OWN git repository. MEASURED (already once, in the vocabulary probe):
  // without this, `setup` walks up out of the temp dir to whatever repository encloses it and
  // reports UNSUPPORTED for that one instead — a real answer about the wrong project.
  run(git, ['init', '-b', 'main'], project);
  run(git, ['config', 'user.email', 'standing@canary.local'], project);
  run(git, ['config', 'user.name', 'Standing Probe'], project);
  run(git, ['add', '-A'], project);
  const commit = run(git, ['commit', '-m', 'base'], project);
  assert(commit.status === 0, `fixture commit failed: ${commit.stdout}${commit.stderr}`);

  const setup = run(process.execPath, [cli, 'setup', '--yes'], project);
  assert(/READY/.test(`${setup.stdout}${setup.stderr}`), `setup did not reach READY: ${setup.stdout}${setup.stderr}`);

  // The client handshake, byte for byte as a client sends it. `initialize` is where the standing
  // instructions arrive; `tools/list` is where the standing tool definitions arrive.
  const rpc = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v13-standing', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n');
  const srv = run(process.execPath, [cli, 'mcp'], project, rpc);
  const replies = (srv.stdout ?? '').split('\n').filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = replies.find((r) => r.id === 1);
  const list = replies.find((r) => r.id === 2);
  const tools = list?.result?.tools ?? [];
  const instructions = init?.result?.instructions ?? '';

  // Per-tool bytes, exactly as the client receives them.
  const perTool = tools.map((t) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes);
  const toolsBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  const instrBytes = Buffer.byteLength(instructions, 'utf8');
  const standingBytes = toolsBytes + instrBytes;
  const ceremonyBytes = perTool.filter((t) => CEREMONY.includes(t.name))
    .reduce((a, t) => a + t.bytes, 0);

  console.log(`INFO standing payload: ${standingBytes} B = ${instrBytes} B instructions + ${toolsBytes} B tool definitions (${tools.length} tools)`);
  for (const t of perTool) console.log(`INFO   ${String(t.bytes).padStart(5)} B  ${t.name}`);
  console.log(`INFO ceremony (${CEREMONY.join(', ')}): ${ceremonyBytes} B = ${(100 * ceremonyBytes / standingBytes).toFixed(1)}% of the standing payload`);

  check('A1-the-server-answers-the-handshake-with-instructions-a-client-really-receives', () => {
    assert(init?.result?.serverInfo?.name === 'canary', 'no canary serverInfo');
    assert(instrBytes > 0, 'the server advertised NO instructions, so this probe would measure nothing');
  });

  check('A2-the-standing-payload-is-measured-and-attributed-per-tool', () => {
    assert(standingBytes > 0, 'standing payload is empty');
    assert(perTool.length === tools.length, 'not every advertised tool was attributed');
  });

  check('A3-acceptance-is-still-not-advertised-as-a-tool', () => {
    assert(!tools.some((t) => /accept/i.test(t.name)), 'canary_accept was advertised');
  });

  check('A4-the-benchmark-INCLUDES-this-payload-and-cannot-silently-drop-it', () => {
    const trial = fs.readFileSync(path.join(repo, 'tooling/benchmark/run-trial.mjs'), 'utf8');
    assert(trial.includes("'--strict-mcp-config'"),
      'the trial harness no longer pins hermeticity; re-read what the measured arms contain');
    // v1.5 — the assertion is INVERTED from its historical form on purpose. It used to fail
    // when the harness started passing `--mcp-config`, with the message "the 92.7% figure
    // must be re-derived before it is quoted again". That re-derivation has now happened
    // (docs/BENCHMARK-EVERYDAY-1.5.md), so the probe pins the NEW correct state: the payload
    // must be passed, because dropping it again would understate Canary's cost.
    assert(trial.includes("'--mcp-config'"),
      'the trial harness no longer passes an --mcp-config, so the measured canary arms EXCLUDE the '
      + 'standing MCP payload again. That flatters Canary: the everyday figure in '
      + 'docs/BENCHMARK-EVERYDAY-1.5.md was measured WITH the payload inside. Restore the flag or '
      + 're-derive the published figure');
    assert(/mcpConfig/.test(trial),
      'the harness no longer RECORDS whether the payload was loaded, so a trial cannot show whether '
      + 'the standing cost was inside its own measurement');
  });

  // ── the standing payload's TOKEN cost: MEASURED provider-natively in v1.5 ──
  // `v15-mcp-standing-payload.mjs` differences two otherwise identical sessions that
  // differ only by `--mcp-config`, so this number is an observation, not a derivation.
  const MEASURED_TOKENS = 438;
  console.log(`\nMEASURED (provider-native; tooling/probes/v15-mcp-standing-payload.mjs) — the standing payload is ~${MEASURED_TOKENS} tokens, re-sent each turn:`);
  for (const n of [5, 10, 17, 25]) {
    console.log(`MEASURED   ${String(n).padStart(2)} turns -> ~${(MEASURED_TOKENS * n).toLocaleString('en-US')} token-equivalents of re-read context`);
  }
  const approxTokens = Math.round(standingBytes / 4);
  console.log(`CROSS-CHECK (derived: bytes/4, NOT measured) — ${standingBytes} B / 4 = ~${approxTokens} tokens.`);
  console.log(`            The derived figure OVERSTATES the measured one by ${(approxTokens / MEASURED_TOKENS).toFixed(1)}x, because`);
  console.log('            JSON tool schemas tokenise far better than 4 bytes/token. Do not quote bytes/4 as tokens.');

  const open = [];
  console.log('RESOLVED the-benchmark-excludes-the-standing-payload: v1.5 made run-trial.mjs pass '
    + '--mcp-config, so the ' + standingBytes + ' B measured here ARE inside the everyday figure, and the '
    + 'figure was re-derived from a fresh run (docs/BENCHMARK-EVERYDAY-1.5.md). The historical 92.7% '
    + 'excluded them and must not be quoted as current.');
  if (CEREMONY.every((n) => tools.some((t) => t.name === n))) {
    open.push('the-everyday-path-advertises-the-expert-ceremony: canary_work and canary_finish are in a '
      + 'flat module-level TOOLS array with no mode gating, so every client pays ' + ceremonyBytes + ' B per turn '
      + '(the audit measured that surface as costing 177.8% of plain when it is DRIVEN). Removing them '
      + 'from tools/list is a CAPABILITY decision, not an overhead cleanup — MCP has no hidden tool, so '
      + 'gating them makes them uncallable by any agent. Not taken here.');
  }
  if (/may, and should, call canary_doctor/i.test(instructions)) {
    open.push('the-instructions-invite-a-doctor-call-beside-automatic-verification: the same text says '
      + 'verification is AUTOMATIC and then tells the model it "may, and should, call canary_doctor". '
      + 'Whether that invitation COSTS a turn (a redundant check) or SAVES one (the model fixes before '
      + 'the Stop hook blocks it) is NOT measured. Do not remove it on the assumption that it is waste — '
      + 'that assumption is the failure mode the v1.3 audit already retracted once.');
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 standing context — ${standingBytes} B advertised per turn`);
  if (open.length > 0) {
    console.log(`OPEN FINDINGS (recorded, not asserted): ${open.length}`);
    for (const f of open) console.log(`  OPEN ${f}`);
  }
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.log(`FAIL v1.3 standing context — ${String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
