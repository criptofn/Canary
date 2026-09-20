// v1.3 §E2 — CAN THE HARNESS'S CONSENT GATE BE SATISFIED WITHOUT A HUMAN, AND WITHOUT BLESSING
// SERVERS CANARY DID NOT WRITE?
//
// The integration probe established the honest state: `canary setup` writes the MCP entry, Claude Code
// READS it, and then holds it at "Pending approval" until a human approves the project's MCP servers
// once, interactively. For a product whose whole promise is "install it and forget it", a step that
// requires the user to answer a prompt before their agent can use Canary is a real gap — so this probe
// asks the only question that matters: can Canary close it from inside the settings file it already
// writes?
//
// It can only be closed if the answer is NARROW. `enableAllProjectMcpServers` would approve every
// server in `.mcp.json`, including one a teammate or an attacker added — Canary would be vouching for
// software it never inspected, which is the exact inversion of "the worker must not own the root of
// trust". So this probe measures both halves:
//
//   * does a settings-level pre-approval actually change the state Claude Code reports?
//   * does it approve OUR entry only, leaving a stranger's entry exactly as un-approved as before?
//
// If the narrow form works, setup can write it. If only the broad form works, setup must NOT write it,
// and the gap stays reported. Either answer is a measurement; this probe passes on the measurement.
//
// Host-bound by construction: no Claude Code CLI here, no measurement — an explicit SKIP, never a pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const claude = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mcp-consent-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

if (!fs.existsSync(claude)) {
  console.log(`SKIP host-bound: no Claude Code CLI at ${claude} — the harness's consent gate cannot be measured here`);
  console.log('\n=== mcp consent: SKIP (host-bound) — NOT a pass ===');
  process.exit(0);
}

const run = (exe, args, cwd) => spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });

/** The state Claude Code reports for one named server, or null when it is not listed. */
const stateOf = (text, name) => {
  const line = text.split('\n').find((l) => new RegExp(`^\\s*${name}\\s*:`).test(l));
  if (!line) return null;
  if (/Pending approval/i.test(line)) return 'pending-approval';
  if (/Connected/i.test(line)) return 'connected';
  if (/Failed to connect/i.test(line)) return 'failed-to-connect';
  if (/Rejected/i.test(line)) return 'rejected';
  return `unrecognised: ${line.trim()}`;
};

try {
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({
    name: 'mcp-consent', private: true, scripts: { test: 'node greeting.test.cjs' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(temp, 'package-lock.json'), JSON.stringify({
    name: 'mcp-consent', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {},
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(temp, 'greeting.cjs'), 'module.exports = (n) => `Hello, ${n}!`;\n');
  fs.writeFileSync(path.join(temp, 'greeting.test.cjs'),
    "const assert = require('node:assert');\nassert.strictEqual(require('./greeting.cjs')('a'), 'Hello, a!');\n");
  run(git, ['init', '-b', 'main'], temp);
  run(git, ['config', 'user.email', 'consent@canary.local'], temp);
  run(git, ['config', 'user.name', 'Consent Probe'], temp);
  run(git, ['add', '-A'], temp);
  run(git, ['commit', '-m', 'base'], temp);

  const setup = run(process.execPath, [cli, 'setup', '--yes'], temp);
  assert(setup.status === 0, `setup must succeed:\n${setup.stdout}${setup.stderr}`);

  // A STRANGER in the same .mcp.json. Canary did not write this and must never vouch for it. It is
  // added BEFORE any settings change so both entries face the identical consent state.
  const mcpPath = path.join(temp, '.mcp.json');
  const mcpDoc = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  mcpDoc.mcpServers.stranger = { command: 'node', args: ['stranger-server.js'] };
  fs.writeFileSync(mcpPath, JSON.stringify(mcpDoc, null, 2) + '\n');

  const before = `${run(claude, ['mcp', 'list'], temp).stdout}${run(claude, ['mcp', 'list'], temp).stderr}`;
  const beforeCanary = stateOf(before, 'canary');
  const beforeStranger = stateOf(before, 'stranger');
  console.log(`INFO as setup left it:  canary=${beforeCanary}  stranger=${beforeStranger}`);

  check('A1-setup-alone-leaves-our-server-unapproved (the gap this probe is about)', () => {
    assert(beforeCanary !== null, 'Claude Code did not list the canary server at all');
    assert(beforeCanary === 'pending-approval',
      `expected the reported gap to be "pending-approval", got "${beforeCanary}" — if this changed, `
      + 'the integration claim in the audit and the README must be re-derived');
  });

  // ── which settings form, if any, changes the reported state? ──
  // Guessing costs a cycle each time, so the probe tries every form the harness documents or that the
  // settings reference implies, and reports what each one actually did. The hook file is preserved
  // exactly: a candidate that quietly dropped Canary's Stop hook would look like progress and be a
  // regression.
  const settingsPath = path.join(temp, '.claude', 'settings.json');
  const localPath = path.join(temp, '.claude', 'settings.local.json');
  const hookOnly = fs.readFileSync(settingsPath, 'utf8');
  console.log(`INFO project settings keys as setup left them: ${Object.keys(JSON.parse(hookOnly)).join(', ') || '(none)'}`);

  const VARIANTS = [
    { name: 'project+enabledMcpjsonServers', file: settingsPath, body: { enabledMcpjsonServers: ['canary'] } },
    { name: 'project+enableAllProjectMcpServers', file: settingsPath, body: { enableAllProjectMcpServers: true } },
    { name: 'local+enabledMcpjsonServers', file: localPath, body: { enabledMcpjsonServers: ['canary'] } },
    { name: 'local+enableAllProjectMcpServers', file: localPath, body: { enableAllProjectMcpServers: true } },
  ];

  const outcomes = [];
  for (const v of VARIANTS) {
    fs.writeFileSync(settingsPath, hookOnly);
    fs.rmSync(localPath, { force: true });
    const base = v.file === settingsPath ? JSON.parse(hookOnly) : {};
    fs.writeFileSync(v.file, JSON.stringify({ ...base, ...v.body }, null, 2) + '\n');

    const text = `${run(claude, ['mcp', 'list'], temp).stdout}${run(claude, ['mcp', 'list'], temp).stderr}`;
    const c = stateOf(text, 'canary');
    const s = stateOf(text, 'stranger');
    // A second, independent view of the same question: `mcp get` reports one server in detail, and it
    // is a different code path from the summary line. If both views agree the setting did nothing, the
    // claim is about the harness rather than about one formatter.
    const get = run(claude, ['mcp', 'get', 'canary'], temp);
    const getText = `${get.stdout}${get.stderr}`.replace(/\s+/g, ' ').trim().slice(0, 300);
    outcomes.push({ variant: v.name, canary: c, stranger: s, get: getText });
    console.log(`INFO ${v.name.padEnd(34)} canary=${c}  stranger=${s}`);
    console.log(`INFO   mcp get canary: ${getText || '(no output)'}`);
  }

  // Leave the fixture in the state setup produced, so anything after this reads the real product state.
  fs.writeFileSync(settingsPath, hookOnly);
  fs.rmSync(localPath, { force: true });

  check('A2-the-hooks-canary-wrote-survive-every-candidate-settings-form', () => {
    const now = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert(JSON.stringify(now) === JSON.stringify(JSON.parse(hookOnly)),
      'the probe did not restore the project settings exactly');
    assert(JSON.stringify(now).includes('Stop'), 'the Stop hook is not in the restored settings');
  });

  const flippers = outcomes.filter((o) => o.canary !== 'pending-approval' && o.canary !== null);
  const broadFlippers = flippers.filter((o) => o.variant.includes('enableAllProjectMcpServers'));
  const cleanNarrow = flippers.filter((o) => !o.variant.includes('enableAllProjectMcpServers') && o.stranger !== 'connected');

  console.log(`\nINFO forms that changed the reported state: ${flippers.length === 0 ? 'NONE' : flippers.map((f) => `${f.variant} -> ${f.canary}`).join('; ')}`);
  if (flippers.length === 0) {
    console.log('INFO CONCLUSION: on this harness version the consent gate is NOT reachable from the settings files');
    console.log('INFO Canary writes. Setup must not pretend otherwise, and the approval stays a human act.');
  } else if (cleanNarrow.length > 0) {
    console.log(`INFO CONCLUSION: ${cleanNarrow.map((f) => f.variant).join(', ')} closes the gate WITHOUT approving the stranger — setup may write it.`);
  } else if (broadFlippers.length > 0) {
    console.log('INFO CONCLUSION: only the BROAD form works, and it approves the stranger too. Setup must NOT write it:');
    console.log('INFO Canary would be vouching for a server it never inspected, which inverts "the worker must not own the root of trust".');
  }

  check('A3-no-candidate-settings-form-vouches-for-a-server-canary-did-not-write', () => {
    const bad = outcomes.filter((o) => o.stranger === 'connected');
    assert(bad.length === 0,
      `${bad.map((b) => b.variant).join(', ')} approved the STRANGER as well; Canary would be vouching for `
      + 'software it never inspected — do not ship this');
  });

  console.log(`\n=== mcp consent: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — measured on ${path.basename(claude)} ===`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.log(`FAIL mcp consent — ${String(e?.message ?? e)}`);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
