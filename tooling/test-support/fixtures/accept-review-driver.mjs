/** Test-only terminal adapter. Exercises the exported production command on
 * native Windows too; never shipped and never a production acceptance flag.
 * A real POSIX PTY is independently exercised by f3-acceptance-growth. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const [cli, action = 'none'] = process.argv.slice(2);
const candidate = path.join(process.cwd(), '.canary', 'candidates', 'c');
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
  return buffer.write('c\n');
};
syncBuiltinESMExports();
process.argv = [process.execPath, cli, 'accept', 'c'];
await import(pathToFileURL(cli));
