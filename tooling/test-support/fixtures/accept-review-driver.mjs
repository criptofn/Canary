/** Test-only terminal adapter. Exercises the exported production command on
 * native Windows too; never shipped and never a production acceptance flag.
 * A real POSIX PTY is independently exercised by f3-acceptance-growth.
 *
 * argv: <cli> [action] [typedText] [candidateName]
 *   action       none | dirty | head | task   (architecture-closure.mjs uses these)
 *   typedText    what the human "types" at the prompt (default the candidate name)
 *   candidateName  the candidate to accept (default 'c')
 * `tooling/test-support/terminal.mjs` drives this when, and only when, the host
 * offers no drivable real pty — and the caller then reports that as an explicit
 * host-bound SKIP, never as a pass. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const [cli, action = 'none', typedIn = 'c', candidateName = 'c'] = process.argv.slice(2);
const candidate = path.join(process.cwd(), '.canary', 'candidates', candidateName);
const originalRead = fs.readSync;
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
fs.readSync = function(fd, buffer, ...args) {
  if (fd !== 0) return originalRead.call(fs, fd, buffer, ...args);
  if (action === 'dirty') fs.appendFileSync(path.join(candidate, 'screen.html'), 'changed during prompt');
  if (action === 'head') {
    fs.appendFileSync(path.join(candidate, 'screen.html'), 'new commit during prompt');
    for (const argv of [['add','screen.html'],['commit','-m','race fixture']]) {
      const r = spawnSync('git', ['-C',candidate,...argv], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw Error(r.stderr);
    }
  }
  if (action === 'task') {
    const p = path.join(process.cwd(), '.canary/task/current.json');
    const t = JSON.parse(fs.readFileSync(p,'utf8')); t.taskDigest = 'f'.repeat(64); fs.writeFileSync(p,JSON.stringify(t));
  }
  return buffer.write(typedIn.endsWith('\n') ? typedIn : `${typedIn}\n`);
};
syncBuiltinESMExports();
process.argv = [process.execPath, cli, 'accept', candidateName];
await import(pathToFileURL(cli));
