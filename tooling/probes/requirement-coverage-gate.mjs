#!/usr/bin/env node
/**
 * ARE AUTHORIZED REQUIREMENTS COVERED BY PROOF — or does canary say READY anyway?
 *
 * The invariant, in the owner's words: *Canary must never issue PASS/READY merely because the
 * configured tests are green if authorized user requirements are not independently covered by
 * adequate proof. Every objective requirement must have a frozen proof obligation or remain NOT
 * PROVEN. Subjective requirements require explicit human acceptance.*
 *
 * This probe drives the OPERATOR path directly: a green project, a task registered with stated
 * requirements and NO check bound to them. What must happen:
 *
 *   1. `doctor` must NOT be READY — the requirements are authorized and unproven, so the verdict is
 *      NOT PROVEN with a non-zero exit;
 *   2. the Stop hook must not be SILENT either — the worker is told what is unproven;
 *   3. the requirements must be named, so a human knows what to bind or accept;
 *   4. and the closing path the CLI prints must be one that can actually be taken in this context —
 *      an acceptance command naming a candidate that does not exist is a dead end, not a path.
 *
 * It also records the contrast case: a project with NO registered task has nothing authorized, so a
 * green plan is READY (the tool does not invent duties).
 *
 * Usage: node tooling/probes/requirement-coverage-gate.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);

const RUNNER = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const dir = path.join(__dirname, 'tests');",
  "let passing = 0, failing = 0;",
  "for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js')).sort()) {",
  "  const tests = require(path.join(dir, f));",
  "  for (const [name, fn] of Object.entries(tests)) {",
  "    try { fn(); passing += 1; } catch (e) { failing += 1; console.log('FAIL ' + name + ' — ' + (e && e.message ? e.message : e)); }",
  "  }",
  "}",
  "console.log(passing + ' passing (0.01s)');",
  "if (failing > 0) console.log(failing + ' failing');",
  "process.exit(failing > 0 ? 1 : 0);",
  '',
].join('\n');

function makeRepo(name, withTask) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `canary-reqcov-${name}-`));
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: `reqcov-${name}`, private: true, scripts: { test: 'node run-tests.js' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'run-tests.js'), RUNNER);
  fs.writeFileSync(path.join(root, 'src', 'greet.js'), "module.exports = { greet: (n) => 'hello ' + n };\n");
  fs.writeFileSync(path.join(root, 'tests', 'greet.test.js'), [
    "'use strict';",
    "const { greet } = require('../src/greet.js');",
    "module.exports = { 'greets': () => { if (greet('ada') !== 'hello ada') throw new Error('no'); } };",
    '',
  ].join('\n'));
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'reqcov@canary.local']);
  git(['config', 'user.name', 'Requirement Coverage Probe']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { cwd: root, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  if (setup.status !== 0 && setup.status !== 2) throw new Error(`setup failed: ${setup.stdout}${setup.stderr}`);
  if (withTask) {
    const t = spawnSync(process.execPath, [CLI, 'task', 'add a greeting that trims whitespace',
      '--requirement', 'the greeting trims leading and trailing whitespace',
      '--requirement', 'an empty name still produces the word hello',
    ], { cwd: root, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    if (t.status !== 0) throw new Error(`task registration failed: ${t.stdout}${t.stderr}`);
  }
  return root;
}
const doctor = (root) => {
  const r = spawnSync(process.execPath, [CLI, 'doctor', root], { cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
};
const hook = (root) => {
  const r = spawnSync(process.execPath, [CLI, 'checkpoint'], {
    cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true,
    input: JSON.stringify({ cwd: root, stop_hook_active: false, hook_event_name: 'Stop' }),
  });
  const text = (r.stdout ?? '').trim();
  let env = null;
  try { env = JSON.parse(text); } catch { env = null; }
  return { status: r.status, env, text };
};

// ── the contrast case: nothing authorized -> a green plan is READY ──────────
console.log('\n── control: no registered task, green plan');
const bare = makeRepo('bare', false);
{
  const d = doctor(bare);
  console.log(`   doctor: status=${d.status}`);
  check('control: with nothing authorized, a green plan is READY (no invented duty)', () => {
    assert(d.status === 0, `expected READY, got exit ${d.status}:\n${d.out.slice(0, 600)}`);
    assert(/READY/.test(d.out), 'the verdict word must be READY');
  });
  fs.rmSync(bare, { recursive: true, force: true });
}

// ── the case under test: two authorized requirements, no bound proof ───────
console.log('\n── two authorized requirements, no check bound to them');
const tasked = makeRepo('tasked', true);
{
  const d = doctor(tasked);
  const h = hook(tasked);
  console.log(`   doctor: status=${d.status}`);
  const doctorLines = d.out.split('\n').filter((l) => /NOT PROVEN|UNPROVEN|requirement|READY|next:/.test(l)).slice(0, 8);
  for (const l of doctorLines) console.log(`     ${l.trim().slice(0, 200)}`);
  console.log(`   checkpoint: decision=${String(h.env?.decision ?? '(none)')} systemMessage=${h.env?.systemMessage ? 'yes' : 'no'}`);

  check('1. doctor is NOT READY while an authorized requirement is unproven', () => {
    assert(d.status !== 0, `doctor exited 0 with authorized unproven requirements:\n${d.out.slice(0, 800)}`);
    assert(/NOT PROVEN/.test(d.out), `the verdict must say NOT PROVEN:\n${d.out.slice(0, 800)}`);
  });
  check('2. the unproven requirement is NAMED, so a human knows what to close', () => {
    assert(/per-requirement|requirement/i.test(d.out), `the requirement duty must be named:\n${d.out.slice(0, 800)}`);
    assert(/UNPROVEN/.test(d.out), 'the open obligation must be labelled UNPROVEN');
  });
  check('3. the Stop hook is not silent about it', () => {
    assert(h.text !== '', 'a completion with authorized unproven requirements must not pass in silence');
    assert(h.env?.decision === 'block' || (typeof h.env?.systemMessage === 'string' && h.env.systemMessage.length > 0),
      `expected a block or an honest message, got: ${h.text.slice(0, 300)}`);
  });
  check('4. the closing path printed is one that can actually be taken here', () => {
    // An acceptance command is only a path if there IS a candidate to accept; in the base-repo
    // (non-candidate) path the honest path is binding a sealed check or the operator's acceptance
    // of the base. A message that only says "canary accept <candidate>" would be a dead end.
    const candidates = fs.existsSync(path.join(tasked, '.canary', 'candidates'))
      ? fs.readdirSync(path.join(tasked, '.canary', 'candidates')).filter((n) => n !== 'README.md')
      : [];
    const next = /next: ([^\n]*)/.exec(d.out)?.[1] ?? '';
    console.log(`   candidates registered: ${candidates.length}; next: ${next.slice(0, 160)}`);
    if (candidates.length === 0 && /canary accept/.test(next)) {
      assert(/sealed|proofs|setup|human/i.test(next),
        `the printed next step offers only "canary accept <candidate>" while no candidate exists: ${next}`);
    }
  });

  /**
   * THE POSITIVE HALF: the invariant must be SATISFIABLE, not only fail-closed. `canary task` prints
   * each requirement's digest; binding that digest in `package.json` `canary.proofs` to a script the
   * sealed plan runs, then re-running setup, must turn the duty MET — coverage inside Canary's
   * declared proof boundary.
   */
  const taskOut = spawnSync(process.execPath, [CLI, 'task', 'add a greeting that trims whitespace',
    '--requirement', 'the greeting trims leading and trailing whitespace',
    '--requirement', 'an empty name still produces the word hello',
  ], { cwd: tasked, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const digests = [...String(taskOut.stdout ?? '').matchAll(/requirement \[[^\]]+\]: ([0-9a-f]{64})/g)].map((m) => m[1]);
  console.log(`   registration printed ${digests.length} requirement digest(s)`);
  check('5. the registration prints each requirement digest, with the binding recipe', () => {
    assert(digests.length === 2, `expected both requirement digests to be printed, got ${digests.length}:\n${String(taskOut.stdout ?? '').slice(0, 600)}`);
    assert(/canary": \{ "proofs"/.test(String(taskOut.stdout ?? '')), 'the binding recipe must be printed next to the digest');
  });
  if (digests.length === 2) {
    /**
     * THE OPERATOR ACT, not a hand-edit: `canary bind <script> --requirement "<text>"` writes the
     * declaration into package.json, and `canary setup` seals it. MEASURED reason this command exists:
     * declaring requirements without a binding cost a worker 1.5–1.7M tokens over 41–48 turns trying
     * to discharge a duty only an operator can close (`bench-r9`).
     */
    const bind = spawnSync(process.execPath, [CLI, 'bind', 'test',
      '--requirement', 'the greeting trims leading and trailing whitespace',
      '--requirement', 'an empty name still produces the word hello',
    ], { cwd: tasked, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    console.log(`   canary bind: exit ${bind.status}`);
    check('6. `canary bind` writes the declaration and names the sealing step', () => {
      assert(bind.status === 0, `bind must accept a script the plan runs:\n${bind.stdout}${bind.stderr}`);
      assert(/canary setup/.test(String(bind.stdout ?? '')), 'bind must name the step that seals it');
      const pkg = JSON.parse(fs.readFileSync(path.join(tasked, 'package.json'), 'utf8'));
      const proofs = pkg.canary?.proofs ?? {};
      assert(Object.keys(proofs).length === 2, `both digests must be recorded: ${JSON.stringify(proofs)}`);
      assert(Object.values(proofs).every((v) => v === 'test'), 'each digest maps to the named script');
    });
    const bad = spawnSync(process.execPath, [CLI, 'bind', 'lint-everything', '--requirement', 'anything at all'],
      { cwd: tasked, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    check('7. a binding to a script the sealed plan does NOT run is refused (fail closed)', () => {
      assert(bad.status !== 0, `an unsealed script cannot be a proof:\n${bad.stdout}`);
      assert(/does not run a script named/.test(String(bad.stdout ?? '')), `the refusal must say why:\n${bad.stdout}`);
    });
    /**
     * The declaration is an OPERATOR act that is COMMITTED before re-sealing. With the binding left
     * uncommitted the baseline is stamped dirty, and the stronger baseline-comparison semantics then
     * keep the verdict at NOT PROVEN ("required baseline comparison could not be established: the repo
     * was already dirty at setup") — correct fail-closed behaviour, pinned by
     * `apps/cli/dist/test/discrimination-completion.test.js`, and not what this case is about.
     */
    const bindCommit = spawnSync('git', ['-C', tasked, 'add', '-A'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const bindSeal = spawnSync('git', ['-C', tasked, 'commit', '-m', 'bind the stated requirements to their sealed checks'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert(bindCommit.status === 0 && bindSeal.status === 0, `committing the declaration must succeed: ${bindCommit.stderr}${bindSeal.stderr}`);
    const re = spawnSync(process.execPath, [CLI, 'setup', '--yes', tasked], { cwd: tasked, encoding: 'utf8', timeout: 240_000, windowsHide: true });
    console.log(`   re-setup after binding: exit ${re.status}`);
    const bound = doctor(tasked);
    console.log(`   doctor after binding: status=${bound.status}`);
    const lines = bound.out.split('\n').filter((l) => /NOT PROVEN|READY|per-requirement|UNPROVEN/.test(l)).slice(0, 4);
    for (const l of lines) console.log(`     ${l.trim().slice(0, 180)}`);
    check('8. every requirement bound to a sealed script earns READY (coverage is attainable)', () => {
      assert(re.status === 0 || re.status === 2, `setup must accept the binding: ${re.stdout}${re.stderr}`);
      assert(bound.status === 0, `expected READY once every requirement is bound to a sealed script, got exit ${bound.status}:\n${bound.out.slice(0, 700)}`);
      assert(/READY/.test(bound.out), 'the verdict word must be READY');
    });
  }
  fs.rmSync(tasked, { recursive: true, force: true });
}

console.log(`\n=== requirement coverage gate: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
