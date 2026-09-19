const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const out = process.argv[2];
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const commands = [['--version'], ['rev-parse', '--show-toplevel'], ['status', '--porcelain'], ['diff'], ['diff', '--cached'],
  ['add', '--', 'implementation.txt'], ['-c', 'core.longpaths=true', 'status', '--porcelain']];
const results = [];
for (const [index, argv] of commands.entries()) {
  const stdout = path.join(process.cwd(), `capture-${index}.out`), stderr = path.join(process.cwd(), `capture-${index}.err`);
  const a = fs.openSync(stdout, 'w'), b = fs.openSync(stderr, 'w');
  let result;
  try { result = spawnSync(git, argv, { cwd: process.cwd(), windowsHide: true, timeout: 10000,
    stdio: ['ignore', a, b], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' } }); }
  finally { fs.closeSync(a); fs.closeSync(b); }
  results.push({ argv, status: result.status, error: result.error?.message,
    stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') });
  fs.unlinkSync(stdout); fs.unlinkSync(stderr);
}
fs.writeFileSync(out, JSON.stringify(results));
