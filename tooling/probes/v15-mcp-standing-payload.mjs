/**
 * v1.5 — is the standing MCP payload actually IN the session, and what does it COST?
 *
 * WHY THIS EXISTS
 * ---------------
 * The historical everyday token claim (Plain 409,824 vs Canary 379,792 = 92.7 %)
 * EXCLUDED a standing MCP payload of ~5,726 bytes per turn. The v1.3 audit recorded
 * that as an open limitation and quoted it as an ESTIMATE derived from bytes ÷ 4.
 *
 * The v1.5 reconnaissance found the real mechanism, and it is not an estimator gap:
 * `tooling/benchmark/run-trial.mjs` passes `--strict-mcp-config` with NO
 * `--mcp-config`, so the Canary MCP server is never launched and its instructions
 * and tool schemas never enter the session at all. The provider-native usage total
 * therefore never contained them.
 *
 * This probe answers two questions with a MEASUREMENT rather than a derivation:
 *
 *   1. does the Canary MCP server's standing payload actually load into a
 *      non-interactive `claude -p` session when `--mcp-config` is passed?
 *   2. what does it cost in PROVIDER-NATIVE tokens, measured as the difference
 *      between two otherwise identical sessions?
 *
 * That converts "≈1,432 tokens (bytes ÷ 4, derived)" into a measured figure, and it
 * tells us whether the fair v1.5 benchmark can include the payload at all.
 *
 * WHAT IS HELD CONSTANT: same cwd, same prompt, same model, same permission mode,
 * same allowed tools, same setting sources, same environment. The ONLY difference
 * between the two arms is whether `--mcp-config <repo>/.mcp.json` is passed.
 *
 * Exit 0 only if every run produced a parseable usage ledger (three per arm).
 * Prints PASS/FAIL lines. Fixtures live only under the OS temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const REPEATS = 3;
/** Deliberately trivial: the task's own tokens must not swamp the standing payload. */
const PROMPT = 'Reply with exactly one word: ok';

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (ok) pass++; else fail++;
};

if (!fs.existsSync(cli)) {
  console.error(`FAIL no built CLI at ${cli} — run \`npm run build\` first`);
  process.exit(1);
}

/** The same env the benchmark harness builds: the user's settings `env` fills gaps. */
function agentEnv() {
  const env = { ...process.env };
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    for (const [k, v] of Object.entries(settings.env ?? {})) {
      if (typeof v === 'string' && !env[k]) env[k] = v;
    }
  } catch { /* no user settings: the CLI's own environment is used as-is */ }
  return env;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-v15-mcp-'));
const dir = path.join(root, 'project');
fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mcp-standing-probe', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }));
const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
git('init'); git('config', 'user.name', 'Canary probe'); git('config', 'user.email', 'probe@localhost');
git('add', '.'); git('commit', '-m', 'base');

// `canary setup --yes` is what a real user runs, and it is what writes `.mcp.json`.
const setup = spawnSync(process.execPath, [cli, 'setup', '--yes', dir], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
check(setup.status === 0, 'canary setup --yes', `exit ${setup.status}${setup.status === 0 ? '' : ' :: ' + (setup.stderr ?? '').slice(0, 300)}`);

const mcpFile = path.join(dir, '.mcp.json');
const mcpPresent = fs.existsSync(mcpFile);
check(mcpPresent, 'setup wrote .mcp.json', mcpPresent ? mcpFile : 'ABSENT — nothing to measure');
if (!mcpPresent) { console.log('\nRESULT: the standing payload cannot be measured: setup wrote no MCP config.'); process.exit(1); }
const mcpJson = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
const servers = Object.keys(mcpJson.mcpServers ?? {});
check(servers.includes('canary'), '.mcp.json declares the canary server', `servers=[${servers.join(', ')}]`);

/** One session. Returns the provider-native ledger, or null when none was parsed. */
function session(useMcp) {
  const args = [
    '-p', PROMPT,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',
    '--setting-sources', 'project,local',
    '--allowedTools', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  ];
  if (useMcp) args.push('--mcp-config', mcpFile);
  const r = spawnSync('claude', args, { cwd: dir, encoding: 'utf8', windowsHide: true, env: agentEnv(), timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  let usage = null, sawMcpTool = false, model = null, isError = null;
  for (const line of String(r.stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    // Evidence that the server's TOOLS were advertised to the model at all.
    if (/mcp__canary/i.test(t)) sawMcpTool = true;
    if (ev.type === 'result') {
      const u = ev.usage ?? {};
      const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
      usage = {
        input: n(u.input_tokens), output: n(u.output_tokens),
        cacheRead: n(u.cache_read_input_tokens), cacheCreation: n(u.cache_creation_input_tokens),
      };
      usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
      model = ev.model ?? null;
      isError = ev.is_error ?? null;
    }
  }
  return { usage, sawMcpTool, model, isError, status: r.status, stderr: String(r.stderr ?? '').slice(0, 400) };
}

console.log('');
console.log('--- sessions (identical except --mcp-config) ---');
const off = [], on = [];
for (let i = 0; i < REPEATS; i++) {
  const a = session(false); off.push(a);
  console.log(`no-mcp   run ${i + 1}: ${a.usage ? `total=${a.usage.total} (in=${a.usage.input} out=${a.usage.output} cacheR=${a.usage.cacheRead} cacheC=${a.usage.cacheCreation})` : `NO LEDGER status=${a.status} ${a.stderr}`} mcpToolSeen=${a.sawMcpTool}`);
}
for (let i = 0; i < REPEATS; i++) {
  const b = session(true); on.push(b);
  console.log(`with-mcp run ${i + 1}: ${b.usage ? `total=${b.usage.total} (in=${b.usage.input} out=${b.usage.output} cacheR=${b.usage.cacheRead} cacheC=${b.usage.cacheCreation})` : `NO LEDGER status=${b.status} ${b.stderr}`} mcpToolSeen=${b.sawMcpTool}`);
}

const ledgers = [...off, ...on].filter((s) => s.usage);
check(ledgers.length === REPEATS * 2, 'every session produced a provider-native ledger', `${ledgers.length}/${REPEATS * 2}`);
const models = [...new Set(ledgers.map((s) => s.model).filter(Boolean))];
check(models.length <= 1, 'both arms ran the same model', `models=[${models.join(', ')}]`);
const toolSeen = on.filter((s) => s.sawMcpTool).length;
check(toolSeen > 0, 'the canary MCP tools were ADVERTISED to the model with --mcp-config',
  `${toolSeen}/${REPEATS} sessions mentioned mcp__canary (control arm: ${off.filter((s) => s.sawMcpTool).length}/${REPEATS})`);

if (ledgers.length === REPEATS * 2) {
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mo = mean(off.filter((s) => s.usage).map((s) => s.usage.total));
  const mn = mean(on.filter((s) => s.usage).map((s) => s.usage.total));
  const delta = mn - mo;
  console.log('');
  console.log('--- provider-native cost of the standing MCP payload ---');
  console.log(`mean total WITHOUT --mcp-config : ${mo.toFixed(0)}`);
  console.log(`mean total WITH    --mcp-config : ${mn.toFixed(0)}`);
  console.log(`delta (this is the payload)     : ${delta.toFixed(0)} tokens`);
  console.log(`per-session detail              : off=[${off.filter((s) => s.usage).map((s) => s.usage.total).join(', ')}] on=[${on.filter((s) => s.usage).map((s) => s.usage.total).join(', ')}]`);
} else {
  console.log('');
  console.log('NOT MEASURED: without a ledger for every session, no token delta may be quoted.');
}

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`RESULT: ${fail === 0 ? 'the standing payload was measurable' : 'NOT a clean measurement'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
