'use strict';
/**
 * THE HIDDEN ORACLE for the version-bump task: thoroughness, measured rather than
 * assumed — but measured FAIRLY.
 *
 * WHY THIS WAS REWRITTEN: its first version forbade the string `1.2.3` anywhere in the
 * repository, which penalised the CORRECT behaviour — a changelog is supposed to keep
 * its historical release entries. MEASURED: a real trial that had updated every place
 * the CURRENT version is claimed was scored as broken because it left `## [1.2.3]` in
 * the changelog (and `.canary/evidence` contains whatever it contains). A benchmark
 * that marks right answers wrong is worse than no benchmark, so the rule is now
 * "the old version must not be claimed as current", which is the actual requirement.
 *
 * Usage: node check.cjs <projectDir>
 */
const fs = require('node:fs');
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const read = (rel) => { try { return fs.readFileSync(path.join(projectDir, rel), 'utf8'); } catch { return null; } };
const need = (rel, re, what) => {
  const text = read(rel);
  if (text === null) throw new Error(`${rel} is missing`);
  if (!re.test(text)) throw new Error(`${what} (${rel} does not contain ${re})`);
};

check('package.json declares 2.0.0', () => need('package.json', /"version"\s*:\s*"2\.0\.0"/, 'package.json version not bumped'));
check('src/version.js reports 2.0.0', () => need('src/version.js', /2\.0\.0/, 'src/version.js not bumped'));
check('README states 2.0.0', () => need('README.md', /2\.0\.0/, 'README not updated'));
check('CHANGELOG has a 2.0.0 entry', () => need('CHANGELOG.md', /2\.0\.0/, 'CHANGELOG has no 2.0.0 entry'));

check('the old version is not claimed as CURRENT anywhere', () => {
  /**
   * The requirement is that nothing still presents 1.2.3 as the version of the project.
   *
   * MEASURED (`bench-final`, version-bump guarded trials 1-3): this check used to flag ANY non-changelog
   * file CONTAINING `1.2.3`, so three trials that had updated README, CHANGELOG, package.json AND
   * src/version.js were scored broken because the TEST FILE THEY ADDED mentions the old version (a test
   * asserting the version changed is not a claim that the project IS 1.2.3). So:
   *   - a TEST file is never a version claim;
   *   - the changelog's history is legitimate (its own check requires a 2.0.0 entry);
   *   - everywhere else, the occurrence must be CLAIM-SHAPED (current / latest / version: / version=)
   *     to count, which is what the stale "Current version: **1.2.3**" line is.
   */
  const stale = [];
  const CLAIM = /current|latest|version\s*[:=]/i;
  const isTestFile = (r) => /(^|[\\/])tests?([\\/]|$)/i.test(r) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(r);
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.canary') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, r); continue; }
      if (isTestFile(r) || r === 'CHANGELOG.md') continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (!text.includes('1.2.3')) continue;
      const stray = text.split(/\r?\n/).filter((l) => l.includes('1.2.3') && CLAIM.test(l));
      if (stray.length > 0) stale.push(`${r} (lines: ${stray.map((s) => s.trim().slice(0, 40)).join(' / ')})`);
    }
  };
  walk(projectDir, '');
  if (stale.length > 0) throw new Error(`still presents the old version as current in: ${stale.join(', ')}`);
});

check('the reported version really is 2.0.0 at runtime', () => {
  const mod = require(path.join(projectDir, 'src', 'version.js'));
  if (mod.VERSION !== '2.0.0') throw new Error(`VERSION is ${String(mod.VERSION)}`);
});

check('the version consistency test still exists and the two sources agree', () => {
  const t = read('tests/version.test.js');
  if (t === null) throw new Error('tests/version.test.js is gone');
  const pkg = JSON.parse(read('package.json'));
  const mod = require(path.join(projectDir, 'src', 'version.js'));
  if (mod.VERSION !== pkg.version) throw new Error('the two version sources disagree');
});

let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
