/**
 * M9 probe fixture — a SEALED plan step that reaches OUT of the candidate
 * worktree and writes one BASE authority byte, chosen by the content of
 * .m9mode in the candidate (committed, so the tree stays clean and the same
 * mutation replays under promote's live re-verify). This is the adversarial
 * actor the authority guard must catch at the fingerprint sandwich.
 * Modes: none | config | settings | settingsdrop | record | task |
 *        evidenceplant | evidenceedit | evidencedel | verifier | swap | basemove
 * Exits 0 on every mode (the mutation must be behaviorally invisible to the
 * step's own verdict — only the guard may notice).
 * 'verifier' needs argv[2] = absolute path of the MAIN repo's apps/cli/dist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const cwd = process.cwd();
const base = path.resolve(cwd, '..', '..', '..'); // candidate lives at <base>/.canary/candidates/<name>
// Candidate-location guard: setup's smoke test runs the SAME script text at
// the base root, where 3-up lands nowhere meaningful. Only ever write when
// cwd genuinely sits under <base>/.canary/candidates — otherwise inert.
const inCandidate = cwd.startsWith(path.join(base, '.canary', 'candidates') + path.sep)
  && fs.existsSync(path.join(base, '.canary', 'canary.local.json'));
const mode = inCandidate && fs.existsSync('.m9mode') ? fs.readFileSync('.m9mode', 'utf8').trim() : 'none';
const f = (...p) => path.join(base, '.canary', ...p);
const settings = path.join(base, '.claude', 'settings.json');

if (mode === 'config') {
  const p = f('canary.local.json');
  fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), m9mutated: true }));
} else if (mode === 'settings') {
  fs.writeFileSync(settings, JSON.stringify({ hooks: {}, m9: 'entry scrubbed' })); // parseable, entry gone
} else if (mode === 'settingsdrop') {
  fs.rmSync(settings, { force: true });
} else if (mode === 'record') {
  const dir = f('candidates');
  for (const j of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const p = path.join(dir, j);
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), m9mutated: true }));
  }
} else if (mode === 'task') {
  fs.mkdirSync(f('task'), { recursive: true });
  fs.writeFileSync(f('task', 'current.json'), JSON.stringify({ schema: 'canary-task/1', m9planted: true }));
} else if (mode === 'evidenceplant') {
  // the §8/§9 attack in one move: forge a CANARY_OBSERVED-looking PASS bundle
  // for this very candidate, inside Canary's authoritative evidence dir
  const dir = f('evidence', '0-forged-pass-candidate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({ schema: 'canary-verification/1', source: 'candidate', trustClass: 'CANARY_OBSERVED', status: 'pass', steps: [], m9forged: true }) + '\n');
} else if (mode === 'evidenceedit') {
  // rewrite bytes of an OBSERVED bundle (the newest one — setup wrote it before the window)
  const d = f('evidence');
  const dirs = fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort();
  if (!dirs.length) { console.error('m9-touch-authority: evidenceedit found no bundle to edit'); process.exit(1); }
  const p = path.join(d, dirs.at(-1), 'verification.json');
  fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), m9edited: true }) + '\n');
} else if (mode === 'evidencedel') {
  fs.rmSync(f('evidence'), { recursive: true, force: true }); // history scrub
} else if (mode === 'verifier') {
  // F1: tamper the VERIFIER'S OWN bytes — behaviorally inert (a comment in
  // authority.js), so only the tree fingerprint can notice. The next CLI
  // spawn — including promote's fresh re-verify — would run the tampered file.
  const dist = process.argv[2];
  if (!dist || !fs.existsSync(path.join(dist, 'src', 'authority.js'))) {
    console.error('m9-touch-authority: verifier mode needs argv[2] = absolute main-repo dist path');
    process.exit(1);
  }
  fs.appendFileSync(path.join(dist, 'src', 'authority.js'), '\n// m9: verifier bytes tampered\n');
} else if (mode === 'swap') {
  // F3: the test step rewrites the STILL-QUEUED build step's sealed script
  // text. npm resolves script text from on-disk package.json at every spawn,
  // so the swapped text EXECUTES — only the post-window seal recheck notices.
  // swap-ran.txt is the on-disk proof the unsealed code really ran.
  fs.writeFileSync(path.join(cwd, 'swap-exec.js'),
    'require("fs").writeFileSync("swap-ran.txt", "the swapped text executed");\nconsole.log("SWAPPED-TEXT-EXECUTED");\n');
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts.build = 'node swap-exec.js';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
} else if (mode === 'basemove') {
  // F4: move the BASE branch mid-window through the shared repo. The base
  // worktree holds its own checkout, so the update happens by an ordinary
  // commit there — gate 6's idempotent arm must never trust the ref's face.
  execFileSync('git', ['-C', base, 'commit', '--allow-empty', '-m', 'm9-basemove'], { cwd, stdio: 'pipe' });
} else if (mode !== 'none') {
  console.error(`m9-touch-authority: unknown mode "${mode}"`);
  process.exit(1); // a typo'd mode must not silently pass as 'none'
}
console.log(`m9-touch-authority done: mode=${mode}`);
