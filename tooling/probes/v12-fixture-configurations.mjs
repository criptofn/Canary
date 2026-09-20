#!/usr/bin/env node
/**
 * EVERY BENCHMARK FIXTURE'S DECLARED CONFIGURATION, CHECKED AGAINST THE FIXTURE ITSELF.
 *
 * WHY THIS EXISTS (v1.2, open items 6 and 7). `benchmarkConfig: { arm, registerRequirements }` is the
 * field that stops a fixture silently measuring a configuration it was not authored for — but the
 * field is only worth anything if the DECLARATION IS TRUE, and `docs/V1.2-PLAN.md` records the exact
 * way it was got wrong the first time: the six v1.2 fixtures were declared `registerRequirements:
 * true` "because the pilot ran them that way", which would have blessed the configuration whose
 * guarded verdicts are already documented as NOT being about the code.
 *
 * The decision that has to be right is per fixture: registering a stated requirement is only a valid
 * configuration when that requirement is BOUND to a sealed check. Otherwise it derives a
 * `per-requirement` duty nothing can discharge and the Stop hook refuses correct work — a false red.
 * So this probe does not trust anyone's reasoning, including its author's:
 *
 *   1. STRUCTURAL — every fixture declares a full configuration (both axes), not just an arm. An
 *      arm-only declaration cannot be matched against a run that registered requirements, which is
 *      the case that caused the harm.
 *   2. MEASURED, PER FIXTURE — copy the fixture's project, `git init`, `canary setup --yes`,
 *      register the fixture's OWN stated requirements with `canary task`, and then read the two
 *      files the PRODUCT wrote: the task record's requirement digests and the sealed authority's
 *      proof bindings. A requirement is bound when its digest maps to a script the sealed plan runs.
 *      The probe computes no digest of its own — the digests are Canary's, so a change to the
 *      digest rule cannot make this probe agree with a stale copy of that rule.
 *   3. THE INVARIANT — `registerRequirements: true` requires EVERY stated requirement to be
 *      bound. Bindings do not force a trial to register requirements. A fixture
 *      with no requirements array must declare `false`, because for it the flag is a no-op.
 *
 * What this probe does NOT check: whether a declared configuration has been RUN. A declaration is a
 * statement about what the fixture is authored for, and several fixtures declare a configuration no
 * trial has used yet; their notes say so.
 *
 * Usage: node tooling/probes/v12-fixture-configurations.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FIXTURES = path.join(REPO, 'tooling', 'benchmark', 'fixtures');
const ARMS = new Set(['plain', 'guarded', 'invisible', 'canary', 'workflow']);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const fixtureNames = fs.readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(FIXTURES, d.name, 'fixture.json')))
  .map((d) => d.name).sort();

const metaOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'fixture.json'), 'utf8'));
const declaredOf = (meta) => {
  if (Array.isArray(meta.benchmarkConfigs)) return meta.benchmarkConfigs;
  if (meta.benchmarkConfig !== undefined) return [meta.benchmarkConfig];
  if (Array.isArray(meta.benchmarkArms)) return meta.benchmarkArms.map((arm) => ({ arm }));
  if (typeof meta.benchmarkArm === 'string') return [{ arm: meta.benchmarkArm }];
  return [];
};
const requirementsOf = (meta) => (Array.isArray(meta.requirements) ? meta.requirements.filter((r) => typeof r === 'string' && r.trim() !== '') : []);

const git = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
const canary = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true });

/**
 * MEASURE ONE FIXTURE. Returns { digests, unbound, setupExit, taskExit } read from the product's own
 * files, or throws with the evidence attached — a fixture whose project cannot be sealed is a probe
 * failure, never a silent skip, because a skip here would silently excuse a false declaration.
 */
function measure(name, meta) {
  const project = path.join(FIXTURES, name, 'project');
  assert(fs.existsSync(project), `${name} has no project/ directory to measure`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fixture-cfg-'));
  try {
    fs.cpSync(project, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
    // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
    // machine that has Claude Code installed and failed on every CI runner.
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'fixture-config@canary.local']);
    git(root, ['config', 'user.name', 'Fixture Configuration Probe']);
    git(root, ['add', '-A']);
    const commit = git(root, ['commit', '-m', 'fixture as shipped']);
    assert(commit.status === 0, `${name}: git commit failed: ${commit.stderr}`);

    const setup = canary(root, ['setup', '--yes']);
    const cfgPath = path.join(root, '.canary', 'canary.local.json');
    assert(fs.existsSync(cfgPath), `${name}: setup wrote no config (exit ${setup.status}): ${setup.stdout}${setup.stderr}`);

    const reqs = requirementsOf(meta);
    const intent = typeof meta.intent === 'string' && meta.intent !== '' ? meta.intent : 'the stated task';
    const task = canary(root, ['task', intent, ...reqs.flatMap((r) => ['--requirement', r])]);
    const taskPath = path.join(root, '.canary', 'task', 'current.json');
    if (reqs.length > 0) {
      assert(task.status === 0, `${name}: canary task failed (exit ${task.status}): ${task.stdout}${task.stderr}`);
      assert(fs.existsSync(taskPath), `${name}: canary task wrote no record`);
    }

    const digests = fs.existsSync(taskPath)
      ? (JSON.parse(fs.readFileSync(taskPath, 'utf8')).requirementDigests ?? [])
      : [];
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const bindings = cfg.planAuthority?.proofBindings ?? {};
    const inPlan = (script) => cfg.plan.some((s) => s.script === script);
    const unbound = digests.filter((d) => bindings[d] === undefined || !inPlan(bindings[d]));
    return { digests, unbound, setupExit: setup.status, taskExit: task.status };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('── 1. every fixture declares the configuration it is authored for');
check('1. each fixture declares BOTH axes (arm and registerRequirements)', () => {
  assert(fixtureNames.length > 0, 'no fixtures found');
  for (const name of fixtureNames) {
    const declared = declaredOf(metaOf(name));
    assert(declared.length > 0, `${name} declares no benchmarkConfig/benchmarkConfigs (and no legacy benchmarkArm)`);
    for (const d of declared) {
      assert(typeof d.arm === 'string' && ARMS.has(d.arm), `${name} declares arm ${JSON.stringify(d.arm)} — not one of ${[...ARMS].join(', ')}`);
      assert(typeof d.registerRequirements === 'boolean',
        `${name} declares arm "${d.arm}" WITHOUT registerRequirements — an arm-only declaration cannot be matched against a run that registered requirements, which is the case that produced the recorded false red (docs/V1.2-PLAN.md open item 7)`);
    }
  }
  console.log(`     ${fixtureNames.length} fixture(s): every one declares arm + registerRequirements`);
});

console.log('\n── 2. measured against each fixture\'s own sealed bindings');
const measured = [];
check('2. every registration-enabled configuration has sealed bindings', () => {
  for (const name of fixtureNames) {
    const meta = metaOf(name);
    const configurations = declaredOf(meta);
    const declared = { registerRequirements: configurations.some(c => c.registerRequirements) };
    const reqs = requirementsOf(meta);
    const m = measure(name, meta);
    const bound = m.unbound.length === 0;
    measured.push({ name, declared: declared.registerRequirements, reqs: reqs.length, digests: m.digests.length, unbound: m.unbound.length });
    console.log(`     ${name.padEnd(26)} declared=${String(declared.registerRequirements).padEnd(5)} stated=${String(reqs.length).padEnd(3)} digested=${String(m.digests.length).padEnd(3)} unbound=${m.unbound.length}`);

    if (reqs.length === 0) {
      assert(m.digests.length === 0, `${name}: declares no requirements but the task record carries ${m.digests.length} digest(s)`);
      assert(declared.registerRequirements === false,
        `${name} declares registerRequirements:true but states no requirements — for this fixture the flag is a no-op, so the declaration names a configuration that does not exist`);
      continue;
    }
    assert(m.digests.length === reqs.length, `${name}: stated ${reqs.length} requirement(s) but the task record digested ${m.digests.length}`);
    assert(!declared.registerRequirements || bound,
      `${name} declares a registerRequirements:true configuration, but ${m.unbound.length} of ${reqs.length} requirements have no sealed check`);
  }
});

console.log('\n── 3. the corpus reading this establishes');
check('3. the fixtures that can measure the coverage machinery POSITIVELY are named', () => {
  const positive = measured.filter((m) => m.declared === true).map((m) => m.name);
  console.log(`     registerRequirements:true — ${positive.length > 0 ? positive.join(', ') : '(none)'}`);
  console.log(`     registerRequirements:false — ${measured.length - positive.length} fixture(s)`);
  for (const m of measured.filter((x) => x.declared === true)) {
    assert(m.unbound === 0 && m.reqs > 0, `${m.name} is declared as the positive configuration but is not bound`);
  }
});

console.log(`\n=== fixture configurations: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
