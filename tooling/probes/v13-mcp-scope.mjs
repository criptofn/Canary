// v1.3 §21 — WHICH MCP SCOPE AVOIDS THE HARNESS'S APPROVAL GATE?
//
// The integration gap, measured in §E2: `canary setup` registers its MCP server at PROJECT scope (a
// `.mcp.json` in the repository), and Claude Code holds a project-scoped server at "Pending approval"
// until a human approves it once. §E2 then showed no settings file Canary can write closes that gate — so
// the remaining question is not how to satisfy the gate but how to AVOID it: `claude mcp add` takes
// `-s, --scope <local|user|project>`, and the default is `local`, not `project`.
//
// The distinction is a security distinction, not a preference, and that is why it is worth measuring
// carefully. A PROJECT-scoped server arrives from a file in the repository, which a clone or a branch can
// change without the user doing anything — so requiring approval is CORRECT behaviour and must not be
// worked around. A LOCAL-scoped server is the user's own private configuration for this project: nobody
// else can put it there, which is why it is plausible that no consent gate applies.
//
// So this probe measures what each scope actually produces, and reports it. It deliberately does NOT
// assert that local scope is the right choice: if local scope avoids the gate, that is a decision for the
// product (it changes what teammates get from a clone), not something a probe should assume.
//
// It uses a throwaway minimal MCP server and a throwaway project, and removes every entry it creates.
// NOTE ON SIDE EFFECTS, because this probe is unusual: `-s local` writes to the user's own Claude Code
// configuration (`~/.claude.json`), so the probe removes both entries in `finally` AND sweeps any leftover
// from an interrupted earlier run before it starts. It never reads or writes that file itself — the
// harness CLI owns it, and the probe only calls `claude mcp add` / `claude mcp remove`.
//
// Host-bound: no Claude Code CLI, no measurement — an explicit SKIP, never a pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const claude = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mcp-scope-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

if (!fs.existsSync(claude)) {
  console.log(`SKIP host-bound: no Claude Code CLI at ${claude} — MCP scope cannot be measured here`);
  console.log('\n=== mcp scope: SKIP (host-bound) — NOT a pass ===');
  process.exit(0);
}

const run = (exe, args, cwd) => spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });
/** The status Claude Code reports for one named server. */
const stateOf = (text, name) => {
  const line = text.split('\n').find((l) => new RegExp(`^\\s*${name}\\s*:`).test(l));
  if (!line) return 'not-listed';
  if (/Pending approval/i.test(line)) return 'pending-approval';
  if (/Connected/i.test(line)) return 'connected';
  if (/Failed to connect/i.test(line)) return 'failed-to-connect';
  if (/Rejected/i.test(line)) return 'rejected';
  return `unrecognised: ${line.trim()}`;
};

// A minimal stdio MCP server: answers `initialize` and stays alive, so "Connected" is reachable and the
// comparison is about the CONSENT GATE rather than about a server that cannot start.
const SERVER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'scope-probe', version: '1' } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    }
  }
});
`;

const PROJ = 'canary-scope-probe-project';
const LOCAL = 'canary-scope-probe-local';
const created = [];

try {
  const serverPath = path.join(temp, 'mcp-server.cjs');
  fs.writeFileSync(serverPath, SERVER);
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'scope-probe', private: true }, null, 2) + '\n');
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'scope@canary.local'],
    ['config', 'user.name', 'Scope Probe'], ['add', '-A'], ['commit', '-m', 'base']]) {
    const r = run(git, args, temp);
    assert(r.status === 0, `fixture git ${args[0]} failed: ${r.stdout}${r.stderr}`);
  }

  const add = (scope, name) => {
    // Sweep a leftover from an interrupted earlier run FIRST: `add` on an existing name fails, and a
    // leftover would make this look like a product defect rather than stale state.
    run(claude, ['mcp', 'remove', name, '-s', scope], temp);
    const r = run(claude, ['mcp', 'add', '-s', scope, name, '--', process.execPath, serverPath], temp);
    console.log(`INFO add -s ${scope} ${name}: exit ${r.status} ${`${r.stdout}${r.stderr}`.trim().split('\n').slice(-1)[0] ?? ''}`);
    if (r.status === 0) created.push({ scope, name });
    return r;
  };

  const projAdd = add('project', PROJ);
  const localAdd = add('local', LOCAL);
  check('A1-both-adds-succeeded (otherwise there is nothing to compare)', () => {
    assert(projAdd.status === 0, `project-scope add failed: ${projAdd.stdout}${projAdd.stderr}`);
    assert(localAdd.status === 0, `local-scope add failed: ${localAdd.stdout}${localAdd.stderr}`);
    assert(fs.existsSync(path.join(temp, '.mcp.json')), 'project scope wrote no .mcp.json');
  });

  const listed = run(claude, ['mcp', 'list'], temp);
  const text = `${listed.stdout}${listed.stderr}`;
  const projState = stateOf(text, PROJ);
  const localState = stateOf(text, LOCAL);
  console.log(`INFO project scope: ${projState}`);
  console.log(`INFO local scope  : ${localState}`);

  check('A2-project-scope-is-held-for-approval (the gate the current design triggers)', () => {
    assert(projState === 'pending-approval',
      `expected the project-scoped server to be held at "Pending approval", got "${projState}" — if this `
      + 'changed, the note `setup` prints and the audit both need re-deriving');
  });

  check('B1-REPORT-only: what local scope does', () => {
    // Reported rather than asserted: whether local scope should be used is a product decision, because it
    // changes what a teammate gets from a clone (nothing, until they run setup themselves).
    assert(localState !== 'not-listed', 'the local-scope server was not listed at all, so its state is unknown');
  });

  // ── C: CANARY'S OWN server, at local scope ──
  // A and B used a dummy server, which measures the SCOPE but not the claim the README makes. This
  // section registers the real `canary mcp` server at local scope, so the instruction a user is given
  // ("claude mcp add -s local canary -- canary mcp") rests on a measurement of Canary rather than of a
  // stand-in. `pending-approval` here would mean the README is wrong; `failed-to-connect` would mean the
  // server cannot start under a locally-scoped entry.
  const realCli = path.resolve(import.meta.dirname, '../../apps/cli/dist/src/main.js');
  const REAL = 'canary-scope-probe-real';
  let realState = 'not-measured';
  if (fs.existsSync(realCli)) {
    run(claude, ['mcp', 'remove', REAL, '-s', 'local'], temp);
    const addReal = run(claude, ['mcp', 'add', '-s', 'local', REAL, '--', process.execPath, realCli, 'mcp'], temp);
    if (addReal.status === 0) created.push({ scope: 'local', name: REAL });
    const listedReal = run(claude, ['mcp', 'list'], temp);
    realState = stateOf(`${listedReal.stdout}${listedReal.stderr}`, REAL);
    console.log(`INFO Canary's own server at local scope: ${realState} (add exit ${addReal.status})`);

    check('C1-CANARY-ITSELF-connects-at-local-scope-with-no-approval', () => {
      assert(realState !== 'pending-approval',
        'registering Canary\'s own server at local scope produced "pending-approval", so the README '
        + 'instruction is wrong and the seamlessness claim does not hold');
      assert(realState === 'connected',
        `expected "connected" for Canary's own server at local scope, got "${realState}" — a scope that `
        + 'skips the gate but cannot actually start the server would trade one failure for another');
    });
  } else {
    console.log(`INFO skipped section C: no built CLI at ${realCli} (run the build first)`);
  }

  const avoidsGate = localState !== 'pending-approval';
  console.log(`\nINFO CONCLUSION: local scope ${avoidsGate ? 'AVOIDS the approval gate' : 'ALSO requires approval'}`);  console.log('INFO Project scope is a file in the repository, so requiring consent is CORRECT there — a clone or');
  console.log('INFO a branch can change it without the user acting. Local scope is the user\'s own configuration,');
  console.log('INFO which is why it plausibly needs no gate. Choosing between them is a product decision: project');
  console.log('INFO scope gives a teammate the tools from a clone (each must approve); local scope means each');
  console.log('INFO developer runs `canary setup --yes` once, which is the documented model anyway.');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 mcp scope — measured on ${path.basename(claude)}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.log(`FAIL v1.3 mcp scope — ${String(e?.message ?? e)}`);
  process.exitCode = 1;
} finally {
  // Remove every entry this probe created, in both scopes, before deleting the directory.
  for (const { scope, name } of created) {
    const r = run(claude, ['mcp', 'remove', name, '-s', scope], temp);
    console.log(`INFO cleanup: removed ${name} (${scope}) exit ${r.status}`);
  }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
