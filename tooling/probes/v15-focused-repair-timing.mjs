#!/usr/bin/env node
/** Controlled repair timing on two real projects, with explicit installed binaries. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const beforeCli = arg('before-cli'), afterCli = arg('after-cli'), scratch = arg('scratch-root'), out = arg('out');
const beforePackage = arg('before-package'), afterPackage = arg('after-package');
const repeats = Number(arg('repeats') ?? 5);
for (const value of [beforeCli, afterCli, beforePackage, afterPackage, scratch, out]) assert.ok(value && path.isAbsolute(value), 'absolute CLI, package, scratch and output paths required');
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 9 && repeats % 2 === 1, 'odd repetition count from 3 to 9 required');
assert.ok(!fs.existsSync(out), 'new evidence directory required');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => hash(fs.readFileSync(file));
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
assert.ok(fs.statSync(npm).isFile());
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-focused-repair-timing-'));
fs.mkdirSync(out, { recursive: true });
const save = (file, value) => fs.writeFileSync(path.join(out, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|CLAUDE|CANARY_TRUST)/i.test(key)));
const commands = [], rows = [], controls = [];
let failure = null;
const allProjects = [
  { name: 'Hermes', source: 'hermes-agent', base: '7d0eb49c46d83184638fa093b44a15222feb8c51', selected: 'test', count: 2,
    repairFile: 'scripts/smoke-test.js', otherFile: 'scripts/server-smoke-test.js' },
  { name: 'Refactron', source: 'refactron', base: '1fe40d8505bbb0cac703c976401c17213abf1e9d', selected: 'typecheck', count: 3,
    repairFile: 'src/verify/repair-timing-control.test.ts', otherFile: 'tests/unit/verify/repair-timing-control.test.ts' },
];
const selectedProjects = arg('projects')?.split(',') ?? allProjects.map((project) => project.name);
assert.ok(selectedProjects.length && new Set(selectedProjects).size === selectedProjects.length
  && selectedProjects.every((name) => allProjects.some((project) => project.name === name)), 'unique supported projects required');
const projects = allProjects.filter((project) => selectedProjects.includes(project.name));
const manifest = { startedAt: new Date().toISOString(), instrumentSha256: fileHash(import.meta.filename),
  beforeCli, beforeCliSha256: fileHash(beforeCli), afterCli, afterCliSha256: fileHash(afterCli),
  beforePackage, beforePackageSha256: fileHash(beforePackage), afterPackage, afterPackageSha256: fileHash(afterPackage),
  node: process.version, platform: process.platform, repeats, warmupsPerArm: 1, projects,
  threshold: 'at least 25% less median wall time on BOTH projects', nativeAgentSession: false,
  limitation: 'Hermes operator binds its existing server-smoke command as e2e in both arms; no added sleeps or synthetic slow checks.' };
save('manifest.json', manifest); save('instrument.mjs', fs.readFileSync(import.meta.filename, 'utf8'));
function run(name, exe, args, cwd, extra = {}) {
  const started = performance.now(), startedAt = new Date().toISOString();
  const result = spawnSync(exe, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true,
    timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  const record = { name, executable: exe, args, cwd, startedAt, elapsedMs: performance.now() - started,
    exitCode: result.status, signal: result.signal, error: result.error?.message ?? null };
  save(`${name}.out.log`, result.stdout ?? ''); save(`${name}.err.log`, result.stderr ?? ''); commands.push(record);
  assert.equal(result.error, undefined, `${name}: process failed`);
  return { ...record, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function must(name, exe, args, cwd, extra) {
  const result = run(name, exe, args, cwd, extra); assert.equal(result.exitCode, 0, `${name}: see raw logs`); return result;
}
function check(name, cli, repo, args, expectedExit, trust) {
  const evidenceRoot = path.join(repo, '.canary/evidence');
  const before = new Set(fs.readdirSync(evidenceRoot));
  const result = run(name, process.execPath, [cli, 'doctor', ...args, '--json'], repo, { CANARY_TRUST_STORE: trust });
  assert.equal(result.exitCode, expectedExit, `${name}: see raw logs`);
  const envelope = JSON.parse(result.stdout);
  const bundles = fs.readdirSync(evidenceRoot).filter((file) => !before.has(file));
  assert.equal(bundles.length, 1, `${name}: exactly one current verification bundle required`);
  const bundleDir = path.join(evidenceRoot, bundles[0]);
  const bundle = JSON.parse(fs.readFileSync(path.join(bundleDir, 'verification.json'), 'utf8'));
  assert.equal(path.resolve(bundle.canaryEntry), path.resolve(cli));
  fs.cpSync(bundleDir, path.join(out, `${name}-evidence`), { recursive: true, errorOnExist: true });
  return { name, elapsedMs: result.elapsedMs, status: envelope.status, steps: bundle.steps,
    executedChecks: bundle.steps.filter((step) => Array.isArray(step.execArgv) && step.execArgv.length > 0).length };
}
const median = (values) => { const sorted = values.toSorted((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
try {
  for (const project of projects) {
    const arms = [];
    for (const [arm, cli] of [['before', beforeCli], ['after', afterCli]]) {
      const repo = path.join(temp, `${project.name}-${arm}`), trust = path.join(temp, `${project.name}-${arm}-trust`);
      fs.mkdirSync(repo);
      const git = (name, args) => must(`${project.name}-${arm}-${name}`, 'git', ['-C', repo, ...args], temp);
      git('init', ['init', '--initial-branch=repair-timing']);
      git('fetch', ['fetch', '--depth=1', path.join(scratch, project.source), project.base]);
      git('checkout', ['reset', '--hard', 'FETCH_HEAD']);
      assert.equal(must(`${project.name}-${arm}-head`, 'git', ['-C', repo, 'rev-parse', 'HEAD'], temp).stdout.trim(), project.base);
      fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
      if (project.name === 'Hermes') {
        const pkgFile = path.join(repo, 'package.json'), pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        assert.equal(pkg.scripts['server-smoke'], 'node scripts/server-smoke-test.js');
        pkg.scripts.e2e = pkg.scripts['server-smoke']; fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
      } else {
        must(`${project.name}-${arm}-dependencies`, process.execPath, [npm, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], repo);
        must(`${project.name}-${arm}-prerequisite`, process.execPath, [npm, 'run', 'build'], repo);
      }
      git('base-add', ['add', '-A']); git('base-commit', ['-c', 'user.name=Canary repair timing', '-c', 'user.email=timing@localhost', 'commit', '--allow-empty', '-m', 'operator repair workload']);
      const toolDirs = project.name === 'Refactron' ? [path.join(scratch, 'python311'), path.join(scratch, 'python311/Scripts'), 'C:/Program Files/Git/cmd', 'C:/Program Files/Git/usr/bin'] : [];
      must(`${project.name}-${arm}-setup`, process.execPath, [cli, 'setup', '--yes', ...toolDirs.flatMap((dir) => ['--toolchain-dir', dir])], repo, { CANARY_TRUST_STORE: trust });
      const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.canary/canary.local.json'), 'utf8'));
      assert.equal(cfg.plan.length, project.count);
      save(`${project.name}-${arm}-package.json`, fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
      save(`${project.name}-${arm}-config.json`, cfg);
      const repair = path.join(repo, project.repairFile), original = fs.existsSync(repair) ? fs.readFileSync(repair, 'utf8') : null;
      const broken = project.name === 'Hermes' ? `${original}\nassert.equal(1, 2, 'controlled regression-test mistake');\n`
        : "export const repairValue: number = 'wrong type';\n";
      const repaired = project.name === 'Hermes' ? original : broken.replace("'wrong type'", '1');
      if (project.name === 'Refactron') {
        // tsconfig includes src/** and excludes tests/**. Put the typed test helper
        // in its actual typecheck scope, with a separate runnable regression test.
        const test = path.join(repo, project.otherFile); fs.mkdirSync(path.dirname(test), { recursive: true });
        fs.writeFileSync(test, "import { it, expect } from 'vitest';\nimport { repairValue } from '../../../src/verify/repair-timing-control.test.js';\nit('controlled repair', () => expect(repairValue).toBe(1));\n");
      }
      fs.mkdirSync(path.dirname(repair), { recursive: true }); fs.writeFileSync(repair, broken);
      const rejected = check(`${project.name}-${arm}-broken`, cli, repo, arm === 'after' ? ['--check', project.selected] : [], 2, trust);
      assert.ok(rejected.steps.some((step) => !step.ok)); controls.push(rejected);
      fs.writeFileSync(repair, repaired);
      const checkpoint = fileHash(path.join(repo, '.canary/last-checkpoint.json'));
      arms.push({ arm, cli, repo, trust, checkpoint });
    }
    for (let round = 0; round <= repeats; round++) {
      for (const item of round % 2 ? arms.toReversed() : arms) {
        const args = item.arm === 'after' ? ['--check', project.selected] : [];
        const measured = check(`${project.name}-${item.arm}-${round === 0 ? 'warmup' : `repeat-${round}`}`, item.cli, item.repo, args, 0, item.trust);
        assert.equal(measured.executedChecks, item.arm === 'after' ? 1 : project.count);
        if (item.arm === 'after') {
          assert.equal(measured.status, 'PARTIAL');
          assert.equal(fileHash(path.join(item.repo, '.canary/last-checkpoint.json')), item.checkpoint);
        } else assert.equal(measured.status, 'READY');
        if (round > 0) rows.push({ project: project.name, arm: item.arm, round, ...measured });
        console.log(`PASS ${project.name}/${item.arm}/${round}: ${Math.round(measured.elapsedMs)} ms, ${measured.executedChecks} executed checks`);
      }
    }
    const after = arms.find((item) => item.arm === 'after');
    const other = path.join(after.repo, project.otherFile);
    const otherBefore = fs.readFileSync(other, 'utf8');
    fs.writeFileSync(other, project.name === 'Hermes' ? `${otherBefore}\nassert.equal(1, 2, 'independent remaining failure');\n`
      : otherBefore.replace('toBe(1)', 'toBe(2)'));
    const partial = check(`${project.name}-other-failure-partial`, after.cli, after.repo, ['--check', project.selected], 0, after.trust);
    assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.executedChecks, 1);
    assert.equal(fileHash(path.join(after.repo, '.canary/last-checkpoint.json')), after.checkpoint);
    const full = check(`${project.name}-other-failure-full`, after.cli, after.repo, [], 2, after.trust);
    assert.ok(full.steps.some((step) => !step.ok)); controls.push(partial, full);
    fs.writeFileSync(other, otherBefore);
    const final = check(`${project.name}-final-full`, after.cli, after.repo, [], 0, after.trust);
    assert.equal(final.status, 'READY'); assert.equal(final.executedChecks, project.count); controls.push(final);
  }
} catch (error) { failure = error.stack ?? String(error); console.error(failure); }
finally {
  const comparisons = projects.map((project) => {
    const med = (arm) => { const trials = rows.filter((row) => row.project === project.name && row.arm === arm); return trials.length === repeats ? median(trials.map((row) => row.elapsedMs)) : null; };
    const beforeMs = med('before'), afterMs = med('after');
    return { project: project.name, beforeMedianMs: beforeMs, afterMedianMs: afterMs,
      reductionPercent: beforeMs !== null && afterMs !== null ? 100 * (1 - afterMs / beforeMs) : null,
      thresholdMet: beforeMs !== null && afterMs !== null && afterMs <= beforeMs * 0.75 };
  });
  assert.equal(fileHash(beforeCli), manifest.beforeCliSha256); assert.equal(fileHash(afterCli), manifest.afterCliSha256);
  assert.equal(fileHash(beforePackage), manifest.beforePackageSha256); assert.equal(fileHash(afterPackage), manifest.afterPackageSha256);
  save('summary.json', { ...manifest, finishedAt: new Date().toISOString(), commands, rows, controls, comparisons,
    status: failure ? 'incomplete' : 'complete', failure, benefitAchieved: !failure && comparisons.every((row) => row.thresholdMet),
    manualOperatorEdits: 'Scripted controlled mistakes and repairs in independent copies; no model or manual mid-run interventions.' });
  const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, file)).isFile()).sort();
  save('SHA256SUMS', `${files.map((file) => `${fileHash(path.join(out, file))}  ${file.replaceAll('\\', '/')}`).join('\n')}\n`);
  assert.equal(fs.realpathSync.native(temp), path.join(fs.realpathSync.native(os.tmpdir()), path.basename(temp)));
  fs.rmSync(temp, { recursive: true });
  for (const row of comparisons) console.log(`${row.thresholdMet ? 'PASS' : 'NOT MET'} ${row.project} median reduction: ${row.reductionPercent?.toFixed(1) ?? 'incomplete'}%`);
  process.exitCode = failure ? 1 : comparisons.every((row) => row.thresholdMet) ? 0 : 2;
}
