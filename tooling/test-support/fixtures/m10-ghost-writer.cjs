// M10 probe fixture (S10) — a sealed plan step that WRITES a test file into
// the working tree it runs in, then exits green. This is the laundering
// shape: the step mints its own regression evidence mid-window.
//
// Deliberate confinement: it only writes when its CWD is a candidate
// worktree (the immediate parent directory is named 'candidates' —
// <root>/.canary/candidates/<name>). During setup's smoke the same step
// runs in the base repo root and must leave no residue, so the base stays
// clean and the scenario's premise ("every deletion in the candidate is
// the candidate's") holds untouched.
//
// The FIX this fixture pins: obligation signals are collected BEFORE the
// execution window, so this write can never count as evidence for the
// verdict whose run performed it.
const fs = require('node:fs');
const path = require('node:path');

const cwd = path.resolve(process.cwd());
const inCandidate = path.basename(path.dirname(cwd)) === 'candidates' && fs.existsSync(path.join(cwd, 'tests'));
if (inCandidate) {
  fs.writeFileSync(path.join(cwd, 'tests', 'ghost.test.js'), '// ghost — written by the plan step itself\n');
}
console.log('ghost-writer ok');
process.exit(0);
