// Diagnostic for S8's red leg: what letters does THIS git actually print for
// assume-unchanged / skip-worktree in `ls-files -v`, and does `status
// --porcelain` really hide the edit? Empirical, not from memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-lsf-'));
const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
function must(r, what) { if (r.status !== 0) { console.log(`FAIL setup ${what}: ${r.stderr}`); process.exit(1); } return r.stdout; }
fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'tests', 'b.test.js'), 'original\n');
fs.writeFileSync(path.join(tmp, 'src.js'), 'x\n');
must(git('init', '-b', 'main'), 'init');
must(git('config', 'user.email', 'p@p.local'), 'cfg');
must(git('config', 'user.name', 'P'), 'cfg2');
must(git('add', '-A'), 'add');
must(git('commit', '-m', 'i'), 'commit');
fs.writeFileSync(path.join(tmp, 'tests', 'b.test.js'), 'hollowed\n');
must(git('update-index', '--assume-unchanged', 'tests/b.test.js'), 'assume-unchanged');
const statusHidden = must(git('status', '--porcelain'), 'status1');
const lsOut = must(git('ls-files', '-v'), 'ls-files -v');
console.log('status after assume-unchanged edit:', JSON.stringify(statusHidden));
console.log('ls-files -v raw:', JSON.stringify(lsOut));
for (const line of lsOut.split(/\r?\n/)) console.log('  line:', JSON.stringify(line));
const re = /^(?:[a-z]|S) /m;
console.log('fold regex matches:', re.test(lsOut));
// also skip-worktree on the other file
fs.writeFileSync(path.join(tmp, 'src.js'), 'hollowed too\n');
must(git('update-index', '--skip-worktree', 'src.js'), 'skip-worktree');
const ls2 = must(git('ls-files', '-v'), 'ls-files -v 2');
const st2 = must(git('status', '--porcelain'), 'status2');
console.log('status after skip-worktree:', JSON.stringify(st2));
console.log('fold regex matches (both flags):', re.test(ls2));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(re.test(lsOut) && re.test(ls2) && statusHidden.trim() === '' ? 'PASS letters confirmed' : 'FAIL diagnosis — letters/status differ from the fold');
process.exit(re.test(lsOut) && re.test(ls2) && statusHidden.trim() === '' ? 0 : 1);
