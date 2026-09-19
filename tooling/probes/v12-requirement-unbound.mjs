#!/usr/bin/env node
/**
 * REQUIREMENT UNBOUND — the early handoff gate (v1.2, Mission 2).
 *
 * WHAT THIS PROVES, and why it is worth a probe rather than a claim:
 *
 * v1.1 discovered an unbound requirement at the END of a worker's session (Stop hook / `finish`),
 * after the model had spent its budget on a duty no check could measure. MEASURED at 1.5-1.85M
 * tokens over 41-53 turns, and reproduced by v1.2's own pilot at +133% tokens. The repair is to
 * answer the question BEFORE the worker is handed anything.
 *
 * The cases, in order, each asserted on a real repository through the real CLI:
 *
 *   A. a declared requirement with NO binding                 -> `work` REFUSES, exit 2, no candidate
 *   B. the same repository after binding + re-sealing         -> `work` PROCEEDS, candidate opens
 *   C. a registration carrying a subjective marker            -> `work` PROCEEDS (acceptance is real)
 *   D. the sealed plan still runs and `doctor` still judges   -> the gate changed no verdict
 *
 * Case A is the important one and is asserted on the OUTCOME (no candidate directory created),
 * not only on the exit code: a refusal that still opened a candidate would be no refusal at all.
 *
 * Usage: node tooling/probes/v12-requirement-unbound.mjs
 * Exit:  0 when every case holds, 1 otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCaptured } from '../benchmark/capture.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FIXTURES = path.join(REPO, 'tooling', 'benchmark', 'fixtures');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** A real repository, wired by the real setup, ready for `canary work`. */
function makeProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `canary-unbound-${label}-`));
  const project = path.join(root, 'project');
  copyDir(path.join(FIXTURES, 'cli-exit-codes', 'project'), project);
  const git = (...args) => runCaptured('git', ['-C', project, ...args], { timeout: 60_000 });
  git('init', '-b', 'main');
  git('config', 'user.email', 'probe@canary.local');
  git('config', 'user.name', 'Canary Probe');
  git('add', '-A');
  git('commit', '-m', 'initial state');
  const setup = runCaptured(process.execPath, [CLI, 'setup', '--yes', project], { cwd: project, timeout: 300_000 });
  if (setup.status !== 0 && !/NEEDS ATTENTION/.test(setup.stdout)) {
    console.log(`  (setup exited ${String(setup.status)}: ${setup.stdout.slice(-200)})`);
  }
  return { root, project, git, setup };
}

const cli = (project, args, timeout = 300_000) => runCaptured(process.execPath, [CLI, ...args], { cwd: project, timeout });
const candidateExists = (project, name) => fs.existsSync(path.join(project, '.canary', 'candidates', `${name}.json`));

const REQ = 'the CLI must exit 2 when the config is invalid';

// ---------------------------------------------------------------- A: unbound REFUSES
{
  console.log('--- A: a declared requirement with no sealed binding');
  const { root, project } = makeProject('a');
  try {
    const work = cli(project, ['work', 'c1', 'fix the CLI exit codes', '--requirement', REQ]);
    check('A: `canary work` refuses with exit 2', work.status === 2, `exit ${String(work.status)}`);
    check('A: the refusal names REQUIREMENT UNBOUND', /REQUIREMENT UNBOUND/.test(work.stdout), work.stdout.split('\n').filter((l) => /UNBOUND/.test(l))[0] ?? '(not found)');
    check('A: it says worker execution was not started', /NOT started|never started/i.test(work.stdout));
    // The outcome, not just the exit code: a refusal that still opened a candidate is no refusal.
    check('A: NO candidate was opened', !candidateExists(project, 'c1'), 'no registry record');
    check('A: it prints the digest to bind', /[0-9a-f]{64}/.test(work.stdout), 'a digest was offered');
    // The plan's SCRIPT name is what gets bound (the fixture seals `test`, kind `tests`), so the
    // assertion is on that name — "tests" is the KIND and would pass for the wrong reason.
    check('A: it prints a plan script that could measure it', /available to bind:\s*test\b/.test(work.stdout),
      (work.stdout.split('\n').find((l) => /available to bind/.test(l)) ?? '(not found)').trim());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- B: bound PROCEEDS
{
  console.log('--- B: the same repository after binding + re-sealing');
  const { root, project, git } = makeProject('b');
  try {
    // Read the digest the refusal offered, bind it, re-seal, then ask again.
    const refusal = cli(project, ['work', 'c2', 'fix the CLI exit codes', '--requirement', REQ]);
    const digest = (refusal.stdout.match(/unbound: ([0-9a-f]{64})/) ?? [])[1];
    check('B: the refusal printed a bindable digest', typeof digest === 'string' && digest.length === 64, String(digest));

    if (typeof digest === 'string') {
      const pkgPath = path.join(project, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.canary = { proofs: { [digest]: 'test' } };
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      git('add', '-A');
      git('commit', '-m', 'bind the requirement');
      const reseal = cli(project, ['setup', '--yes'], 300_000);
      check('B: re-sealing succeeds', reseal.status === 0 || /READY/.test(reseal.stdout), `exit ${String(reseal.status)}`);

      const work = cli(project, ['work', 'c2', 'fix the CLI exit codes', '--requirement', REQ]);
      check('B: `canary work` now PROCEEDS', !/REQUIREMENT UNBOUND/.test(work.stdout), work.stdout.split('\n').filter((l) => /UNBOUND|CONNECTED/.test(l))[0] ?? '(neither)');
      check('B: the candidate IS opened', candidateExists(project, 'c2'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- C: subjective PROCEEDS
{
  console.log('--- C: a registration that is explicitly subjective');
  const { root, project } = makeProject('c');
  try {
    // The requirement wording matters and is the point of this case: the subjective marker is a
    // documented heuristic over the intent AND the requirements, so a requirement phrased in
    // aesthetic terms is recognized and gets the human-acceptance path, while one phrased as a
    // mechanical outcome does not. Both halves are asserted, because a gate that never fires is
    // as wrong as one that always does.
    const work = cli(project, ['work', 'c3', 'make the dialog prettier', '--kind', 'ui', '--requirement', 'the dialog should look nicer']);
    check('C: a subjective registration is NOT blocked', !/REQUIREMENT UNBOUND/.test(work.stdout),
      (work.stdout.split('\n').find((l) => /UNBOUND|CONNECTED/.test(l)) ?? '(neither)').trim());
    check('C: the candidate opens, so a human acceptance path exists', candidateExists(project, 'c3'));

    // The contrast case, on the same fixture: a mechanical requirement in the same shape IS blocked.
    const mechanical = cli(project, ['work', 'c4', 'make the validator correct', '--kind', 'bugfix', '--requirement', 'the CLI must exit 2 when the config is invalid']);
    check('C: a MECHANICAL unbound requirement in the same shape IS blocked', /REQUIREMENT UNBOUND/.test(mechanical.stdout),
      `exit ${String(mechanical.status)}`);
    check('C: and that refusal opened no candidate either', !candidateExists(project, 'c4'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- D: doctor still judges
{
  console.log('--- D: the sealed plan and the completion gate are unchanged');
  const { root, project } = makeProject('d');
  try {
    cli(project, ['task', 'fix the CLI exit codes', '--requirement', REQ]);
    const doctor = cli(project, ['doctor']);
    check('D: `doctor` still refuses an unbound requirement', doctor.status !== 0, `exit ${String(doctor.status)}`);
    check('D: and says NOT PROVEN', /NOT PROVEN/.test(doctor.stdout), doctor.stdout.split('\n').find((l) => /NOT PROVEN/.test(l)) ?? '(not found)');
    // The classification fix: the duty must no longer be offered as acceptance-eligible.
    const bundleLine = doctor.stdout.split('\n').find((l) => /per-requirement/.test(l)) ?? '';
    check('D: the per-requirement duty is OBJECTIVE, not acceptance-eligible', !/non-objective/.test(bundleLine), bundleLine.slice(0, 160));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- E: --reseal is ONE operator act
{
  console.log('--- E: `canary bind --reseal` collapses bind -> commit -> setup into one act');
  const { root, project, git } = makeProject('e');
  try {
    const headBefore = git('rev-parse', 'HEAD').stdout.trim();
    const bind = cli(project, ['bind', 'test', '--requirement', REQ, '--reseal']);
    check('E: `bind --reseal` exits 0', bind.status === 0, `exit ${String(bind.status)}`);
    const cfg = JSON.parse(fs.readFileSync(path.join(project, '.canary', 'canary.local.json'), 'utf8'));
    const sealedToTest = Object.entries(cfg.planAuthority?.proofBindings ?? {}).filter(([, s]) => s === 'test');
    check('E: the SEALED authority carries the binding (no second command was needed)',
      sealedToTest.length === 1, JSON.stringify(cfg.planAuthority?.proofBindings ?? {}));
    const headAfter = git('rev-parse', 'HEAD').stdout.trim();
    check('E: HEAD advanced — the command committed the declaration', headAfter !== headBefore,
      `${headBefore.slice(0, 7)} -> ${headAfter.slice(0, 7)}`);
    const changedFiles = git('show', '--name-only', '--pretty=format:', 'HEAD').stdout.trim().split('\n').filter(Boolean);
    check('E: the commit contains the DECLARATION FILE ONLY',
      changedFiles.length === 1 && changedFiles[0] === 'package.json', changedFiles.join(', '));
    check('E: the commit message says what it is', /bind requirement\(s\) to test/.test(git('log', '-1', '--pretty=%s').stdout.trim()),
      git('log', '-1', '--pretty=%s').stdout.trim());
    const status = git('status', '--porcelain').stdout.trim().split('\n').filter(Boolean)
      .map((l) => l.slice(3).trim());
    // The declaration must no longer be dirty, and nothing else may have been touched. Canary's own
    // surface may legitimately remain untracked: `setup` writes `.claude/settings.json` and, since
    // v1.3, `.mcp.json`.
    //
    // The owned set is DERIVED from the config the product wrote (`touched[]` is exactly the list
    // `setup` records, excludes from its baseline, and `uninstall` prunes) rather than spelled here.
    // A hard-coded list is what made this probe fail the moment Canary's managed surface grew — and a
    // probe that has to be edited whenever the product changes is a probe that will eventually be
    // edited in the wrong direction. This cannot weaken the property that matters: that `--reseal`
    // sweeps no unrelated work into the commit is asserted separately, on the commit's own contents.
    const owned = ['.canary'];
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(project, '.canary', 'canary.local.json'), 'utf8'));
      for (const t of cfg.touched ?? []) {
        owned.push(path.relative(project, t.path).split(path.sep).join('/'));
      }
    } catch { /* no config: only the self-ignored store is Canary's */ }
    const canaryOwned = (p) => owned.some((o) => p === o || p.startsWith(`${o}/`) || (p.endsWith('/') && o.startsWith(p)));
    check('E: the declaration is committed and nothing else was touched',
      status.every(canaryOwned), status.join(', ') || '(clean)');
    // The outcome that matters: the requirement is no longer unbound, so the worker is handed the duty.
    const work = cli(project, ['work', 'e1', 'fix the CLI exit codes', '--requirement', REQ]);
    check('E: `canary work` then PROCEEDS', !/REQUIREMENT UNBOUND/.test(work.stdout),
      work.stdout.split('\n').filter((l) => /UNBOUND|CONNECTED/.test(l))[0] ?? '(neither)');
    check('E: and the candidate IS opened', candidateExists(project, 'e1'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- F: --reseal refuses a dirty tree
{
  console.log('--- F: `--reseal` refuses to seal a base that is not what the operator reviewed');
  const { root, project, git } = makeProject('f');
  try {
    fs.writeFileSync(path.join(project, 'UNRELATED.txt'), 'work in progress\n');
    git('add', 'UNRELATED.txt'); // staged, and nothing to do with the binding
    const bind = cli(project, ['bind', 'test', '--requirement', REQ, '--reseal']);
    check('F: it refuses with exit 2', bind.status === 2, `exit ${String(bind.status)}`);
    check('F: the refusal names the OTHER path', /UNRELATED\.txt/.test(bind.stdout),
      bind.stdout.split('\n').find((l) => /REFUSED/.test(l)) ?? '(no refusal line)');
    const cfg = JSON.parse(fs.readFileSync(path.join(project, '.canary', 'canary.local.json'), 'utf8'));
    const bindings = cfg.planAuthority?.proofBindings ?? {};
    check('F: NOTHING was sealed', !Object.values(bindings).includes('test'), JSON.stringify(bindings));
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    check('F: the declaration IS written, so the operator loses no work',
      Object.values(pkg.canary?.proofs ?? {}).includes('test'), JSON.stringify(pkg.canary?.proofs ?? {}));
    check('F: and the refusal says how to finish', /canary setup/.test(bind.stdout));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- G: --json keeps ONE envelope
{
  console.log('--- G: `--reseal --json` keeps the one-envelope contract');
  const { root, project } = makeProject('g');
  try {
    const bind = cli(project, ['bind', 'test', '--requirement', REQ, '--reseal', '--json']);
    check('G: it exits 0', bind.status === 0, `exit ${String(bind.status)}`);
    const lines = bind.stdout.split('\n').filter((l) => l.trim() !== '');
    check('G: stdout carries exactly ONE JSON line (two commands, one envelope)', lines.length === 1, `${lines.length} non-empty line(s): ${lines.slice(0, 3).join(' | ').slice(0, 200)}`);
    let env = null;
    try { env = JSON.parse(lines[0] ?? ''); } catch { env = null; }
    check('G: that line is the setup envelope and says READY', env !== null && env.status === 'READY', String(lines[0] ?? '(nothing)').slice(0, 140));
    check('G: the human prose went to stderr, never stdout', /bound 1 requirement/.test(bind.stderr), (bind.stderr.split('\n')[0] ?? '(no stderr)').slice(0, 140));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('');
console.log(failures === 0
  ? 'REQUIREMENT UNBOUND gate: every case holds'
  : `REQUIREMENT UNBOUND gate: ${failures} case(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
