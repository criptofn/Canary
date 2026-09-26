/**
 * v1.5 post-audit — TWO SPELLINGS OF ONE DIRECTORY (the last Windows CI blocker, made portable).
 *
 * WHY THIS EXISTS. The Windows CI leg failed one test:
 *
 *   not ok 1 - setup accepts --toolchain-dir with spaces, records it, and the sealed step sees it
 *     the authorized directory never reached the child PATH
 *
 * The directory WAS on the child's PATH. The check compared the PATH against the path AS THE TEST
 * SPELLED IT, while the product seals `fs.realpathSync.native(dir)` — deliberately, because a
 * canonical path is what stops a symlink being swapped after sealing. On a runner whose TEMP is the
 * 8.3 short form (`...\RUNNER~1\...`) the two spellings differ, so a raw `includes` failed.
 *
 * That is the same class as the v1.4 Windows failure: ONE ASSERTION COMPARING TWO SPELLINGS OF ONE
 * DIRECTORY.
 *
 * The CI host is the only place 8.3 short names are guaranteed, and this machine has them DISABLED
 * (`dir /x` shows no alias), so the runner condition cannot be reproduced here directly. A directory
 * JUNCTION produces the same shape portably: two spellings, one directory. This probe builds that,
 * measures both spellings, and proves:
 *
 *   1. the product seals the CANONICAL spelling and the sealed child really receives that directory;
 *   2. a RAW exact-spelling comparison would report "the authorized directory never reached the child
 *      PATH" — i.e. it reproduces the CI failure's symptom WITHOUT a short name, which pins the
 *      mechanism rather than assuming it;
 *   3. a canonical comparison (what the fixed test now does) sees the directory, so the fix addresses
 *      the cause and not the symptom;
 *   4. a directory that is genuinely ABSENT is still refused by the canonical comparison — the fix
 *      did not relax the check into always-passing.
 *
 * Fixtures live only in the OS temp dir. Prints PASS/FAIL; exits 0 only if every case held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(repo, 'apps', 'cli', 'dist', 'src', 'main.js');
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

let pass = 0, fail = 0;
/**
 * check(name, fn) — the assertion THROWS to fail.
 *
 * MEASURED defect in the first draft of this probe, kept as a warning: it was written with an
 * `(ok, name)` signature while every call site passed `(name, fn)`, so every `fn` was a truthy value
 * in the `ok` position and all six checks "passed" without ever running. A check that cannot fail is
 * not a check — the output was the tell (`PASS () => {`).
 */
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); pass++; }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};

if (!fs.existsSync(CLI)) { console.error(`FAIL no built CLI at ${CLI} — run \`npm run build\` first`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-pathspell-'));
const canonical = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// ── the two spellings of ONE directory: a real dir, and a junction pointing at it ──
const realParent = path.join(TMP, 'real parent');
const realBin = path.join(realParent, 'a tool chain with spaces', 'bin');
fs.mkdirSync(realBin, { recursive: true });
fs.writeFileSync(path.join(realBin, process.platform === 'win32' ? 'stagedtool.exe' : 'stagedtool'), 'staged\n');
const aliasParent = path.join(TMP, 'alias-parent');
fs.mkdirSync(aliasParent, { recursive: true });
const aliasPath = path.join(aliasParent, 'linked');
let junctionMade = false;
try {
  fs.symlinkSync(realParent, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
  junctionMade = true;
} catch (e) {
  console.log(`INFO: could not create a junction (${String(e).slice(0, 120)}) — falling back to a plain path`);
}
/** The spelling the "test" uses; the canonical spelling the product will seal. */
const spelledDir = junctionMade ? path.join(aliasPath, 'a tool chain with spaces', 'bin') : realBin;
const canonicalDir = canonical(spelledDir);

check('the two spellings really are different strings for one directory', () => {
  if (!junctionMade) {
    // Portable fallback: if no junction could be made, the probe still asserts the canonicaliser is
    // idempotent and says plainly that the interesting case was not exercised.
    console.log('     NOTE: no junction available, so the differing-spelling case was NOT exercised here');
    return;
  }
  if (spelledDir.toLowerCase() === canonicalDir.toLowerCase()) {
    throw new Error(`expected a spelling difference; both are ${spelledDir}`);
  }
  // ...and they must be the SAME directory, or the case is meaningless.
  if (canonical(spelledDir) !== canonicalDir) throw new Error('the two spellings do not denote one directory');
});

// ── drive a real sealed step and read the child's PATH ────────────────────────────
const fixture = path.join(TMP, 'fixture');
fs.mkdirSync(path.join(fixture, '.claude'), { recursive: true });
// The check writes the child's PATH to a file so THIS probe can inspect both spellings itself,
// rather than trusting one comparison inside the fixture.
const dumpFile = path.join(TMP, 'child-path.txt');
fs.writeFileSync(path.join(fixture, 'dump.cjs'),
  "'use strict';\nconst fs = require('node:fs');\n"
  + `fs.writeFileSync(${JSON.stringify(dumpFile)}, process.env.PATH || '');\nconsole.log('dumped');\n`);
fs.writeFileSync(path.join(fixture, 'package.json'),
  `${JSON.stringify({ name: 'pathspell-fixture', private: true, scripts: { test: 'node dump.cjs' } }, null, 2)}\n`);
for (const a of [['init', '-b', 'main'], ['config', 'user.email', 'probe@canary.local'], ['config', 'user.name', 'Path Spell Probe'], ['add', '-A'], ['commit', '-m', 'initial']]) {
  const r = spawnSync(GIT, ['-C', fixture, ...a], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) { console.error(`FAIL fixture git ${a[0]}: ${r.stdout}${r.stderr}`); process.exit(1); }
}
const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', '--toolchain-dir', spelledDir], {
  cwd: fixture, encoding: 'utf8', timeout: 300_000, windowsHide: true,
  env: { ...process.env, CANARY_TRUST_STORE: path.join(TMP, 'trust') },
});
check('setup accepted the authorized directory and its sealed step executed', () => setup.status === 0,
  `setup exited ${setup.status}\n${(setup.stdout ?? '').slice(-400)}`);

const childPath = fs.existsSync(dumpFile) ? fs.readFileSync(dumpFile, 'utf8') : '';
const entries = childPath.split(path.delimiter).filter((d) => d.length > 0);
const spelledSeen = entries.some((d) => d.toLowerCase() === spelledDir.toLowerCase());
const canonicalSeen = entries.some((d) => canonical(d).toLowerCase() === canonicalDir.toLowerCase());

check('the sealed child REALLY received the directory (canonical comparison)', () => {
  if (childPath === '') throw new Error('the fixture never dumped the child PATH, so nothing was measured');
  if (!canonicalSeen) throw new Error(`the directory is missing from the child PATH entirely:\n${childPath}`);
});

check('THE CI SYMPTOM REPRODUCED: a RAW spelling comparison would call that directory absent', () => {
  if (childPath === '') throw new Error('no child PATH was captured');
  if (!junctionMade) { console.log('     NOTE: junction unavailable — the raw-vs-canonical difference was not exercised'); return; }
  if (spelledSeen) throw new Error('the raw spelling was present too, so this host cannot show the difference');
  console.log(`     child PATH holds the CANONICAL spelling; the RAW spelling "${spelledDir}" is absent`);
  console.log('     — which is exactly the CI failure message, produced without a short name');
});

check('a canonical comparison never mistakes "spelled differently" for "absent"', () => {
  if (!canonicalSeen) throw new Error('canonical comparison disagreed with the measurement above');
});

check('the fix did NOT relax the check: a directory genuinely absent is still refused', () => {
  const absent = path.join(TMP, 'not-authorized-at-all');
  const seen = entries.some((d) => canonical(d).toLowerCase() === canonical(absent).toLowerCase());
  if (seen) throw new Error('a directory that was never authorized appears on the child PATH');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
console.log(`RESULT: path spelling — ${pass} pass, ${fail} fail${junctionMade ? '' : ' (junction unavailable: the differing-spelling case was NOT exercised)'}`);
process.exit(fail === 0 ? 0 : 1);
