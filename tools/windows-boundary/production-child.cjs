// Runs INSIDE confinement. Only the native parent exit/token record is authority.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const system = path.join(process.env.SystemRoot, 'System32');
const stdoutFile = path.join(__dirname, 'stdout.txt'), stderrFile = path.join(__dirname, 'stderr.txt');
const stdoutFd = fs.openSync(stdoutFile, 'wx'), stderrFd = fs.openSync(stderrFile, 'wx');
const r = spawnSync(request.argv[0], request.argv.slice(1), {
  cwd: process.cwd(), shell: false, windowsHide: true, encoding: 'utf8',
  timeout: request.timeoutMs, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', stdoutFd, stderrFd],
  env: { ...process.env, PATH: `${request.nodeDirectory};${system}`,
    NODE_OPTIONS: '--preserve-symlinks-main --preserve-symlinks',
    ComSpec: path.join(system, 'cmd.exe'), npm_config_cache: path.join(__dirname, 'npm-cache') },
});
fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
fs.writeFileSync(path.join(__dirname, 'output.json'), JSON.stringify({ stdout: fs.readFileSync(stdoutFile, 'utf8'), stderr: fs.readFileSync(stderrFile, 'utf8'), error: r.error?.message }));
process.exit(r.error || r.status === null ? 125 : r.status);
