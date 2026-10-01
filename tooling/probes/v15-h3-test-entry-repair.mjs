#!/usr/bin/env node
/** Controlled post-pilot repair: keep weak agent tests, then add real invalid-width assertions. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (key) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? null : process.argv[i + 1]; };
const cli = arg('cli'), archive = arg('input-archive'), out = arg('out'), artifact = arg('artifact-sha256');
const allowMissingEntry = process.argv.includes('--allow-missing-startup-entry');
for (const value of [cli, archive, out]) assert.ok(value && path.isAbsolute(value));
assert.match(artifact ?? '', /^[a-f0-9]{64}$/); assert.ok(!fs.existsSync(out));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
for (const line of fs.readFileSync(path.join(archive, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const [, digest, file] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
  assert.ok(digest && file); assert.equal(hash(fs.readFileSync(path.join(archive, file))), digest);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-h3-test-entry-'));
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'trust') };
const root = path.resolve(import.meta.dirname, '../..');
const commands = [], phases = [], stores = [];
const save = (file, value) => fs.writeFileSync(path.join(out, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
save('instrument.mjs', fs.readFileSync(import.meta.filename, 'utf8'));
const cliHash = hash(fs.readFileSync(cli));
function run(name, executable, args, cwd = root, input) {
  const result = spawnSync(executable, args, { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  save(`${name}.stdout.txt`, result.stdout ?? ''); save(`${name}.stderr.txt`, result.stderr ?? '');
  commands.push({ name, executable, args, cwd, exitCode: result.status, error: result.error?.message ?? null });
  assert.equal(result.status, 0, `${name}: see captured output`); assert.equal(result.error, undefined);
  return result.stdout.trim();
}
let failure = null, repo = null;
try {
  const prepared = path.join(temp, 'prepared');
  run('prepare', process.execPath, [path.join(root, 'tooling/probes/v15-pilot-prepare.mjs'), '--tasks', 'H3', '--out', prepared,
    '--scratch-root', 'C:\\Users\\Johannes\\Desktop\\canary-ws5-scratch', '--cli', cli, '--artifact-sha256', artifact]);
  const preparation = JSON.parse(fs.readFileSync(path.join(prepared, 'preparation-summary.json'), 'utf8'));
  save('preparation-summary.json', preparation);
  fs.cpSync(path.join(prepared, 'preflight'), path.join(out, 'preflight'), { recursive: true });
  const canary = preparation.records.find((record) => record.arm === 'canary');
  repo = canary.repo;
  for (const record of preparation.records) {
    stores.push(JSON.parse(fs.readFileSync(path.join(record.output, 'attempt-result.json'), 'utf8')).trustStore);
  }
  env.CANARY_TRUST_STORE = JSON.parse(fs.readFileSync(path.join(canary.output, 'attempt-result.json'), 'utf8')).trustStore;
  const config = JSON.parse(fs.readFileSync(path.join(repo, '.canary/canary.local.json'), 'utf8'));
  const protectedFiles = ['package.json', '.canary/canary.local.json', '.claude/settings.json', '.codex/hooks.json', '.mcp.json'];
  const protectedHashes = () => Object.fromEntries(protectedFiles.map((file) => [file, hash(fs.readFileSync(path.join(repo, file)))]));
  const initial = protectedHashes();
  const instructions = JSON.parse(run('initialize', process.execPath, [cli, 'mcp', '--profile', 'everyday'], repo,
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')).result.instructions;
  save('startup-entry.json', { present: instructions.includes('node scripts/smoke-test.js'), required: !allowMissingEntry });
  if (!allowMissingEntry) assert.ok(instructions.includes('node scripts/smoke-test.js'));
  save('startup-instructions.txt', instructions);
  const git = (name, ...args) => run(name, 'git', ['-C', repo, ...args]);
  const commit = (name) => { git(`${name}-add`, 'add', '-A'); git(`${name}-commit`, 'commit', '-m', name); };
  const source = 'src/agent/matrixNormCore.js', weak = 'scripts/matrixNormCore-regression-test.js';
  for (const file of [source, weak]) {
    const bytes = fs.readFileSync(path.join(archive, 'H3-canary/files', file));
    save(`input-${path.basename(file)}`, bytes.toString('utf8'));
    fs.writeFileSync(path.join(repo, file), bytes);
  }
  function check(name, expected) {
    const output = run(name, process.execPath, [cli, 'checkpoint'], repo,
      JSON.stringify({ cwd: repo, hook_event_name: 'Stop', stop_hook_active: false }));
    const checkpoint = JSON.parse(fs.readFileSync(path.join(repo, '.canary/last-checkpoint.json'), 'utf8'));
    const hook = output ? JSON.parse(output) : {};
    const currentHashes = protectedHashes();
    const row = { name, expected, checkpoint, hook, protectedUnchanged: JSON.stringify(currentHashes) === JSON.stringify(initial),
      expectedStatusMatched: checkpoint.status === expected };
    phases.push(row); save(`${name}-checkpoint.json`, checkpoint);
    assert.equal(checkpoint.source, 'checkpoint'); assert.equal(checkpoint.status, expected);
    assert.equal(hook.decision === 'block', expected !== 'pass');
    assert.deepEqual(currentHashes, initial);
    console.log(`PASS ${name}: ${checkpoint.status}, blocked=${hook.decision === 'block'}`);
  }
  commit('agent-result-unwired'); check('unwired', 'unproven');
  const smoke = path.join(repo, 'scripts/smoke-test.js');
  fs.appendFileSync(smoke, '\nimport "./matrixNormCore-regression-test.js";\n');
  commit('wire-weak-agent-tests'); check('weak-wired', 'unproven');
  const strong = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/agent/matrixNormCore.js', import.meta.url), 'utf8');
const quantize = vm.runInNewContext(source.replace(/^export /gm, '') + '\\nquantizeSymmetric', { TypeError });
for (const bits of [0, 1, 1.5, 17, NaN, Infinity, '4', null]) assert.throws(() => quantize([[1, -1]], bits), TypeError);
for (let bits = 2; bits <= 16; bits++) assert.ok(quantize([[0, 1, -1], [0.5, -0.5, 0]], bits).flat().every(Number.isFinite));
console.log('PASS actual implementation rejects invalid widths and keeps valid widths finite');
`;
  save('operator-regression.test.js', strong);
  fs.writeFileSync(path.join(repo, 'scripts/quantize-validation.test.js'), strong);
  fs.appendFileSync(smoke, 'import "./quantize-validation.test.js";\n');
  commit('add-real-invalid-width-assertions'); check('strong-wired', 'pass');
  assert.ok(phases.at(-1).checkpoint.next.includes('CHECK TEXT WRITTEN BY THE WORKER ITSELF'));
  assert.match(config.baseline?.head ?? '', /^[a-f0-9]{40,64}$/i);
  git('negative-restore-source', 'restore', '--source', config.baseline.head, '--worktree', '--staged', '--', source);
  commit('negative-old-implementation'); check('negative', 'fail');
  save('final-smoke-test.js', fs.readFileSync(smoke, 'utf8'));
  assert.equal(hash(fs.readFileSync(cli)), cliHash);
} catch (error) { failure = error.stack ?? String(error); console.error(failure); }
finally {
  if (repo && fs.existsSync(path.join(repo, '.canary/evidence'))) {
    fs.cpSync(path.join(repo, '.canary/evidence'), path.join(out, 'product-evidence'), { recursive: true });
  }
  save('summary.json', { cli, cliSha256: cliHash, artifactSha256: artifact, archive, commands, phases, failure,
    status: !failure && phases.length === 4 ? 'complete' : 'incomplete', modelCalls: 0,
    note: 'Operator-written post-pilot control; no autonomous agent benefit or actual native session completion is claimed.' });
  const relative = path.relative(os.tmpdir(), temp); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(temp, { recursive: true, force: true });
  for (const store of stores) {
    const relation = path.relative(path.join(os.tmpdir(), 'canary-v15-validation-trust'), store);
    assert.ok(relation && !relation.startsWith('..') && !path.isAbsolute(relation) && /^[a-f0-9]{64}$/.test(relation));
    fs.rmSync(store, { recursive: true, force: true });
  }
  const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, file)).isFile()).sort();
  save('SHA256SUMS', `${files.map((file) => `${hash(fs.readFileSync(path.join(out, file)))}  ${file.replaceAll('\\', '/')}`).join('\n')}\n`);
  process.exitCode = failure ? 1 : 0;
}
