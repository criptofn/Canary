// v1.3 §17 — WHAT DOES CANARY COST ON *EVERY* TURN, WHETHER OR NOT IT IS USED?
//
// The token requirement is measured on turns and accumulated context: in the recorded ledgers the
// dominant term is cache-read, because every turn re-reads the whole conversation. Anything Canary
// puts into that conversation is therefore paid once per turn, not once per session. The MCP server
// is exactly that kind of cost: its instructions and its tool definitions are advertised to the
// client at handshake time and re-sent on every request afterwards.
//
// So this probe measures the actual setup default (everyday) and the opt-in expert path separately.
// It attributes the bytes per tool, because even an uncalled tool is sent on every turn.
//
// It also records the shape the BENCHMARK measures. Historically
// `tooling/benchmark/run-trial.mjs` ran the agent with `--strict-mcp-config` and NO
// `--mcp-config`, which kept a developer's own MCP servers out of the measurement but had a
// second consequence: the fixture's own `.mcp.json`, written by the `canary setup` the trial
// just ran, was not loaded either. The measured canary arms were therefore the Stop-hook-only
// shape, and the payload measured below was NOT in the 92.7% figure.
//
// v1.5 fixed the harness omission: `run-trial.mjs` passes `--mcp-config <fixture>/.mcp.json`
// whenever setup produced one. The later profile split changed which tools setup writes, so the
// historic v1.5 token results are NOT measurements of today's everyday profile. This probe measures
// bytes and checks that future trial runs load and record the actual setup-generated config.
//
// No token total is reused or inferred from these byte measurements.
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

/** The candidate lifecycle tools the audit measured as costing 177.8% of plain. */
const CEREMONY = ['canary_work', 'canary_finish'];
const EXPERT_ONLY = ['canary_agents', ...CEREMONY];

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
  const measure = (profile) => {
    const srv = run(process.execPath, [cli, 'mcp', '--profile', profile], project, rpc);
    assert(srv.status === 0, `${profile} MCP server failed: ${srv.stdout}${srv.stderr}`);
    const replies = (srv.stdout ?? '').split('\n').filter((l) => l.trim().startsWith('{'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const init = replies.find((r) => r.id === 1);
    const list = replies.find((r) => r.id === 2);
    const tools = list?.result?.tools ?? [];
    const instructions = init?.result?.instructions ?? '';
    const perTool = tools.map((t) => ({ name: t.name, bytes: Buffer.byteLength(JSON.stringify(t), 'utf8') }))
      .sort((a, b) => b.bytes - a.bytes);
    const toolsBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    const instrBytes = Buffer.byteLength(instructions, 'utf8');
    return { profile, init, tools, instructions, perTool, toolsBytes, instrBytes, standingBytes: toolsBytes + instrBytes };
  };
  const everyday = measure('everyday');
  const expert = measure('expert');
  const { init, tools, instructions, perTool, standingBytes } = everyday;
  const instrBytes = everyday.instrBytes;
  const toolsBytes = everyday.toolsBytes;
  const expertCeremonyBytes = expert.perTool.filter((t) => CEREMONY.includes(t.name))
    .reduce((a, t) => a + t.bytes, 0);

  console.log(`INFO everyday payload (setup default): ${standingBytes} B = ${instrBytes} B instructions + ${toolsBytes} B tool definitions (${tools.length} tools)`);
  for (const t of perTool) console.log(`INFO   ${String(t.bytes).padStart(5)} B  ${t.name}`);
  console.log(`INFO expert payload: ${expert.standingBytes} B = ${expert.instrBytes} B instructions + ${expert.toolsBytes} B tool definitions (${expert.tools.length} tools)`);
  console.log(`INFO expert lifecycle tools (${CEREMONY.join(', ')}): ${expertCeremonyBytes} B`);

  check('A1-the-server-answers-the-handshake-with-instructions-a-client-really-receives', () => {
    assert(init?.result?.serverInfo?.name === 'canary', 'no canary serverInfo');
    assert(instrBytes > 0, 'the server advertised NO instructions, so this probe would measure nothing');
  });

  check('A2-the-standing-payload-is-measured-and-attributed-per-tool', () => {
    assert(standingBytes > 0, 'standing payload is empty');
    assert(perTool.length === tools.length, 'not every advertised tool was attributed');
  });

  check('A2b-the-reference-everyday-handshake-stays-under-3900-bytes', () => {
    assert(standingBytes <= 3900,
      `everyday initialize+tools payload exceeds the 3,900-byte reference budget: ${standingBytes} B`);
  });

  check('A3-acceptance-is-still-not-advertised-as-a-tool', () => {
    assert(!tools.some((t) => /accept/i.test(t.name)), 'canary_accept was advertised');
  });

  check('A4-setup-default-is-the-compact-everyday-profile-and-expert-is-explicit', () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    const args = mcp?.mcpServers?.canary?.args;
    assert(Array.isArray(args) && args.slice(-3).join('\0') === ['mcp', '--profile', 'everyday'].join('\0'),
      `setup did not configure the everyday profile: ${JSON.stringify(args)}`);
    assert(EXPERT_ONLY.every((n) => expert.tools.some((t) => t.name === n)),
      `expert profile omitted an isolation lifecycle tool: ${JSON.stringify(expert.tools.map((t) => t.name))}`);
    assert(EXPERT_ONLY.every((n) => !tools.some((t) => t.name === n)),
      'the everyday profile still advertises expert-only tools');
    assert(expert.tools.length === tools.length + EXPERT_ONLY.length,
      `expected expert to add exactly ${EXPERT_ONLY.length} tools: everyday=${tools.length}, expert=${expert.tools.length}`);
    assert(standingBytes <= expert.standingBytes * 0.7,
      `everyday payload is not at least 30% smaller: everyday=${standingBytes} B, expert=${expert.standingBytes} B`);
  });

  check('A5-the-trial-harness-loads-and-records-the-setup-generated-MCP-config', () => {
    const trial = fs.readFileSync(path.join(repo, 'tooling/benchmark/run-trial.mjs'), 'utf8');
    assert(trial.includes("'--strict-mcp-config'"),
      'the trial harness no longer pins hermeticity; re-read what the measured arms contain');
    assert(trial.includes("'--mcp-config'"),
      'trial runs must pass --mcp-config so the agent sees the project MCP config');
    assert(/mcpConfig/.test(trial),
      'the harness must record whether the MCP config was loaded');
  });

  const open = [];
  console.log(`NOTE benchmark comparability: run-trial.mjs loads the setup-generated MCP config, but the historical v1.5 token totals do not measure today's ${standingBytes} B everyday payload. No token-saving claim is made from this probe.`);
  console.log('RESOLVED the-everyday-path-advertises-the-expert-ceremony: setup writes the everyday profile; '
    + 'canary_work and canary_finish appear only when the operator chooses the expert profile.');
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
