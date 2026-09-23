#!/usr/bin/env node
/**
 * REQUIREMENT BINDINGS IN A NON-NODE PROJECT — the invariant's reach, measured.
 *
 * MEASURED gap this verifies the fix for: bindings lived in `package.json` `canary.proofs`, so a
 * Python, Rust, Go — or any project the universal contract covers — could not bind a stated
 * requirement to a sealed check AT ALL. The invariant ("every objective requirement must have a
 * frozen proof obligation or remain NOT PROVEN") was therefore satisfiable only in Node projects,
 * and everything else could only ever end in human acceptance.
 *
 * `canary.project.json` now carries `proofs` (`<64-hex requirement digest> -> <declared check
 * name>`), and `canary bind` writes into whichever declaration surface the project has. This probe
 * drives that path with the real CLI on a real repository:
 *
 *   1. a manifest that declares two checks AND binds two requirement digests -> setup seals one plan
 *      whose authority records both bindings, and `doctor` is READY once the checks pass;
 *   2. `canary bind` on that project writes into `canary.project.json` (not package.json), and the
 *      new binding is only credited after `setup` re-seals;
 *   3. a manifest binding that names a check the manifest does not declare is REFUSED by setup —
 *      an unsealed or unknown proof is worth nothing.
 *
 * Usage: node tooling/probes/universal-requirement-binding.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const { materialDigest } = await import(`file://${path.join(REPO, 'apps', 'cli', 'dist', 'src', 'authorization.js').replace(/\\/g, '/')}`);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const REQ_TRIM = 'leading and trailing whitespace is trimmed from the result';
const REQ_EMPTY = 'an empty or whitespace-only input becomes the word empty';
const REQ_CASE = 'the result is lower-case';

const CHECK_TRIM = "'use strict';\nconst { normalize } = require('../src/text.js');\nprocess.exit(normalize('  a  ') === 'a' ? 0 : 1);\n";
const CHECK_EMPTY = "'use strict';\nconst { normalize } = require('../src/text.js');\nprocess.exit(normalize('') === 'empty' ? 0 : 1);\n";
const CHECK_CASE = "'use strict';\nconst { normalize } = require('../src/text.js');\nprocess.exit(normalize('AbC') === 'abc' ? 0 : 1);\n";

/** A universal project: no package.json anywhere, checks declared in the manifest. */
function makeUniversal(bindings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-universal-bind-'));
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'text.js'), "module.exports = { normalize: (t) => { const s = String(t).trim(); return s === '' ? 'empty' : s.toLowerCase(); } };\n");
  fs.writeFileSync(path.join(root, 'checks', 'trim.cjs'), CHECK_TRIM);
  fs.writeFileSync(path.join(root, 'checks', 'empty.cjs'), CHECK_EMPTY);
  fs.writeFileSync(path.join(root, 'checks', 'case.cjs'), CHECK_CASE);
  fs.writeFileSync(path.join(root, 'canary.project.json'), `${JSON.stringify({
    schema: 'canary-project/1',
    scopes: [{ path: '.', checks: [
      { name: 'check-trim', kind: 'tests', argv: ['node', 'checks/trim.cjs'] },
      { name: 'check-empty', kind: 'tests', argv: ['node', 'checks/empty.cjs'] },
      { name: 'check-case', kind: 'tests', argv: ['node', 'checks/case.cjs'] },
    ] }],
    ...(bindings === null ? {} : { proofs: bindings }),
  }, null, 2)}\n`);
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'universal-bind@canary.local']);
  git(['config', 'user.name', 'Universal Binding Probe']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  return root;
}

const canary = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 240_000, windowsHide: true });
const cfgOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
const manifestOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'canary.project.json'), 'utf8'));

// ── 1. a manifest that declares checks AND binds requirement digests ────────
console.log('\n── a universal project with two BOUND requirements');
{
  const root = makeUniversal({ [materialDigest(REQ_TRIM)]: 'check-trim', [materialDigest(REQ_EMPTY)]: 'check-empty' });
  const setup = canary(root, ['setup', '--yes']);
  console.log(`   setup: exit ${setup.status}`);
  assert(setup.status === 0 || setup.status === 2, `setup must complete: ${setup.stdout}${setup.stderr}`);
  const cfg = cfgOf(root);
  check('1. the sealed plan contains the manifest-declared checks', () => {
    const scripts = cfg.plan.map((s) => s.script).sort();
    assert(scripts.join(',') === 'check-case,check-empty,check-trim', `plan scripts were ${scripts.join(',')}`);
  });
  check('2. the authority SEALED both bindings with the plan', () => {
    const bindings = cfg.planAuthority?.proofBindings ?? {};
    assert(bindings[materialDigest(REQ_TRIM)] === 'check-trim', `binding missing: ${JSON.stringify(bindings)}`);
    assert(bindings[materialDigest(REQ_EMPTY)] === 'check-empty', `binding missing: ${JSON.stringify(bindings)}`);
  });
  const task = canary(root, ['task', 'implement normalize', '--requirement', REQ_TRIM, '--requirement', REQ_EMPTY]);
  assert(task.status === 0, `task registration failed: ${task.stdout}${task.stderr}`);
  const doc = canary(root, ['doctor', root]);
  console.log(`   doctor: exit ${doc.status}`);
  const lines = `${doc.stdout}${doc.stderr}`.split('\n').filter((l) => /READY|NOT PROVEN|UNPROVEN|per-requirement/.test(l)).slice(0, 3);
  for (const l of lines) console.log(`     ${l.trim().slice(0, 170)}`);
  check('3. every bound requirement is COVERED: doctor is READY, not NOT PROVEN', () => {
    assert(doc.status === 0, `expected READY with all requirements bound, got exit ${doc.status}`);
    assert(/READY/.test(doc.stdout), 'the verdict word must be READY');
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 2. `canary bind` writes into the manifest, and only setup credits it ────
console.log('\n── `canary bind` on a manifest project');
{
  const root = makeUniversal(null);
  const setup = canary(root, ['setup', '--yes']);
  assert(setup.status === 0 || setup.status === 2, `setup must complete: ${setup.stdout}${setup.stderr}`);
  canary(root, ['task', 'implement normalize', '--requirement', REQ_CASE]);
  const before = canary(root, ['doctor', root]);
  check('4. before binding, the requirement is NOT PROVEN (fail closed)', () => {
    assert(before.status !== 0, `an unbound requirement must not reach READY: ${before.stdout}`);
    assert(/NOT PROVEN/.test(before.stdout), 'the verdict must say NOT PROVEN');
  });
  const bind = canary(root, ['bind', 'check-case', '--requirement', REQ_CASE]);
  console.log(`   canary bind: exit ${bind.status}`);
  check('5. bind writes into canary.project.json (there is no package.json)', () => {
    assert(bind.status === 0, `bind failed: ${bind.stdout}${bind.stderr}`);
    assert(!fs.existsSync(path.join(root, 'package.json')), 'a universal project has no package.json to write');
    assert(manifestOf(root).proofs?.[materialDigest(REQ_CASE)] === 'check-case', `manifest proofs were ${JSON.stringify(manifestOf(root).proofs)}`);
    assert(/canary setup/.test(bind.stdout), 'bind must name the sealing step');
  });
  check('6. the DECLARATION alone is not a proof — doctor still refuses until setup re-seals', () => {
    const sealed = cfgOf(root).planAuthority?.proofBindings ?? {};
    assert(sealed[materialDigest(REQ_CASE)] === undefined, 'the unsealed declaration must not be credited');
  });
  /**
   * The declaration is COMMITTED before re-sealing, exactly as in the Node probe: an uncommitted
   * binding stamps the baseline dirty, and the stronger comparison semantics then hold the verdict at
   * NOT PROVEN ("required baseline comparison could not be established") by design. This case is about
   * coverage being attainable, so the operator commits first.
   */
  const bindCommit = spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const bindSeal = spawnSync('git', ['-C', root, 'commit', '-m', 'bind the stated requirement to its declared check'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert(bindCommit.status === 0 && bindSeal.status === 0, `committing the declaration must succeed: ${bindCommit.stderr}${bindSeal.stderr}`);
  const reseal = canary(root, ['setup', '--yes']);
  const after = canary(root, ['doctor', root]);
  console.log(`   re-setup exit ${reseal.status}; doctor exit ${after.status}`);
  check('7. after re-sealing, the bound requirement is covered and doctor is READY', () => {
    assert(cfgOf(root).planAuthority?.proofBindings?.[materialDigest(REQ_CASE)] === 'check-case', 'the re-seal must record the binding');
    assert(after.status === 0, `expected READY, got exit ${after.status}: ${after.stdout.slice(0, 400)}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 3. a binding that names an undeclared check is refused ─────────────────
console.log('\n── a manifest binding that names a check it does not declare');
{
  const root = makeUniversal({ [materialDigest(REQ_TRIM)]: 'check-that-does-not-exist' });
  const setup = canary(root, ['setup', '--yes']);
  console.log(`   setup: exit ${setup.status}`);
  check('8. setup REFUSES a binding to a check the manifest does not declare (fail closed)', () => {
    assert(setup.status !== 0, `an unknown proof must stop setup: ${setup.stdout}`);
    assert(/is not a check this manifest declares/.test(`${setup.stdout}${setup.stderr}`), `the refusal must say why:\n${setup.stdout}${setup.stderr}`);
  });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== universal requirement binding: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
