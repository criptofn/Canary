import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [cliArg, outputArg] = process.argv.slice(2);
assert.ok(cliArg && outputArg, 'usage: node v15-bind-intake-regression.mjs <explicit-cli> <new-evidence-dir>');
const cli = fs.realpathSync(cliArg);
const output = path.resolve(outputArg);
fs.mkdirSync(output, { recursive: false });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-bind-intake-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const records = [];
const observations = [];
const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'store') };
function invoke(id, executable, args, cwd) {
  const r = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  fs.writeFileSync(path.join(output, `${id}.stdout.txt`), r.stdout ?? '');
  fs.writeFileSync(path.join(output, `${id}.stderr.txt`), r.stderr ?? '');
  records.push({ id, executable, args, exitCode: r.status, signal: r.signal, error: r.error?.message ?? null });
  assert.equal(r.error, undefined, `${id}: ${r.error}`);
  return r;
}
function observe(id, passed, details) {
  observations.push({ id, passed, details });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${JSON.stringify(details)}`);
}
try {
  assert.equal(invoke('version', process.execPath, [cli, '--version'], temp).status, 0);
  const root = path.join(temp, 'project');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const manifest = path.join(root, 'package.json');
  const original = JSON.stringify({ scripts: { test: 'node check.cjs' } }) + '\n';
  fs.writeFileSync(manifest, original);
  fs.copyFileSync(new URL('../test-support/fixtures/f-pass.js', import.meta.url), path.join(root, 'check.cjs'));
  for (const [id, args] of [['init', ['init', '-b', 'main']], ['add', ['add', '.']],
    ['commit', ['-c', 'user.name=Canary Regression', '-c', 'user.email=regression@canary.local', 'commit', '-m', 'baseline']]]) {
    assert.equal(invoke(id, 'git', args, root).status, 0);
  }
  assert.equal(invoke('setup', process.execPath, [cli, 'setup', '--yes'], root).status, 0);
  const head = invoke('head-before', 'git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const config = path.join(root, '.canary/canary.local.json');
  const sealed = fs.readFileSync(config);
  const first = 'Keep stable identifiers across runs';
  for (const [id, tail] of [['typo', ['--requirment', 'Preserve distinct parameter cases']],
    ['missing', ['--requirement']], ['empty', ['--requirement', '']],
    ['typo-json', ['--requirment', 'Preserve distinct parameter cases', '--json']],
    ['extra-positional', ['Preserve distinct parameter cases']]]) {
    fs.writeFileSync(manifest, original);
    const r = invoke(id, process.execPath, [cli, 'bind', 'test', '--requirement', first, ...tail], root);
    const after = fs.readFileSync(manifest);
    fs.writeFileSync(path.join(output, `${id}.manifest.json`), after);
    let jsonMatches = true;
    if (tail.includes('--json')) {
      try {
        const envelope = JSON.parse(r.stdout);
        jsonMatches = envelope.command === 'bind' && envelope.exitCode === r.status && envelope.status === 'NEEDS ATTENTION';
      } catch { jsonMatches = false; }
    }
    observe(id, r.status === 3 && after.equals(Buffer.from(original)) && fs.readFileSync(config).equals(sealed) && jsonMatches,
      { exitCode: r.status, manifestUnchanged: after.equals(Buffer.from(original)), sealUnchanged: fs.readFileSync(config).equals(sealed),
        ...(tail.includes('--json') ? { jsonMatches } : {}) });
  }
  fs.writeFileSync(manifest, original);
  const valid = invoke('valid-dash-text', process.execPath, [cli, 'bind', 'test', '--requirement', first,
    '--requirement', '--strict preserves warnings as errors'], root);
  const proofs = JSON.parse(fs.readFileSync(manifest, 'utf8')).canary?.proofs ?? {};
  observe('valid-dash-text', valid.status === 0 && Object.keys(proofs).length === 2
    && Object.values(proofs).every((script) => script === 'test') && fs.readFileSync(config).equals(sealed),
    { exitCode: valid.status, proofs, sealUnchanged: fs.readFileSync(config).equals(sealed) });
  fs.writeFileSync(manifest, original);
  const missing = invoke('option-as-text', process.execPath, [cli, 'bind', 'test', '--requirement', first,
    '--requirement', '--reseal'], root);
  const headAfter = invoke('head-after', 'git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const unchanged = fs.readFileSync(manifest).equals(Buffer.from(original));
  observe('option-as-text', missing.status === 3 && unchanged && head === headAfter
    && fs.readFileSync(config).equals(sealed), { exitCode: missing.status, manifestUnchanged: unchanged,
    headUnchanged: head === headAfter, sealUnchanged: fs.readFileSync(config).equals(sealed) });
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ cli, cliSha256: hash(fs.readFileSync(cli)),
    // Development CLIs import this module; bundled packages contain it in the entry bytes.
    onboardingSha256: fs.existsSync(path.join(path.dirname(cli), 'onboarding.js'))
      ? hash(fs.readFileSync(path.join(path.dirname(cli), 'onboarding.js'))) : null,
    instrumentSha256: hash(fs.readFileSync(new URL(import.meta.url))), runtime: process.execPath,
    records, observations }, null, 2) + '\n');
  assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()), 'cleanup must stay inside OS temp');
  fs.rmSync(temp, { recursive: true, force: true });
}
const passed = observations.filter((o) => o.passed).length;
console.log(`BIND-INTAKE: ${passed}/${observations.length} PASS`);
process.exitCode = observations.length === 7 && passed === 7 ? 0 : 1;
