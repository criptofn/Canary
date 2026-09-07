// One-off audit probe (F-1/F-2 mutation check): temporarily revert each fix in the
// BUILT dist (gitignored artifact), run the matching test subset, and require it to
// FAIL. Restores the original bytes in all cases. exit 0 only when every mutation
// was caught AND restore verified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TARGET = path.resolve('apps/cli/dist/src/onboarding.js');
const TEST = path.resolve('apps/cli/dist/test/onboarding.test.js');
const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mut-')), 'onboarding.orig.js');
fs.copyFileSync(TARGET, backup);
const original = fs.readFileSync(backup, 'utf8');

const MUTATIONS = [
  {
    name: 'A revert-F1 (corrupt config goes silent again)',
    pattern: 'S7|F-1',
    apply: (s) => s.replace(
      "return emit({ systemMessage: 'Canary could not verify this task because its local config (.canary/canary.local.json) is unreadable — nothing was verified; this completion is UNVERIFIED, not a pass. Run: canary setup' });",
      'return 0;'),
  },
  {
    name: 'B revert-F2 (writeFileAtomic becomes plain writeFileSync)',
    pattern: 'atomic',
    apply: (s) => s.replace(
      'function writeFileAtomic(p, data) {\n    assertPlainTarget(p);',
      "function writeFileAtomic(p, data) {\n    assertPlainTarget(p); fs.writeFileSync(p, data, 'utf8'); return;"),
  },
  {
    name: 'C drop-temp-cleanup (failed rename leaves residue)',
    pattern: 'atomic',
    apply: (s) => s.replace('fs.rmSync(tmp, { force: true });', 'void tmp;'),
  },
];

let allCaught = true;
try {
  for (const m of MUTATIONS) {
    const mutated = m.apply(original);
    if (mutated === original) { console.log(`FAIL ${m.name}: target string not found (stale dist?)`); allCaught = false; continue; }
    fs.writeFileSync(TARGET, mutated, 'utf8');
    const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${m.pattern}`, TEST],
      { encoding: 'utf8', timeout: 300_000 });
    const caught = r.status !== 0;
    console.log(`${caught ? 'PASS' : 'FAIL'} ${m.name}: tests exit ${r.status}${caught ? ' (mutation caught)' : ' (MUTATION SURVIVED — tests do not pin the fix)'}`);
    if (!caught) {
      allCaught = false;
      console.log(r.stdout.split(/\r?\n/).filter((l) => /not ok|✖/.test(l)).slice(0, 8).join('\n'));
    }
  }
} finally {
  fs.copyFileSync(backup, TARGET);
  console.log(fs.readFileSync(TARGET, 'utf8') === original ? 'PASS restore-verified' : 'FAIL restore-mismatch');
}
process.exit(allCaught ? 0 : 1);
