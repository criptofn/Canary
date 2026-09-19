// Untrusted implementation executor: this file runs ONLY inside the AppContainer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { request, runtime } = JSON.parse(fs.readFileSync(path.join(__dirname, 'request.json'), 'utf8'));
process.env.PATH = `${runtime};${path.join(process.env.SystemRoot, 'System32')}`;
process.env.ComSpec = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
process.env.NODE_OPTIONS = '--preserve-symlinks-main --preserve-symlinks';
let result;
try {
  switch (request.op) {
    case 'list': result = fs.readdirSync(request.path || '.', { withFileTypes: true }).map(e => ({ name: e.name, directory: e.isDirectory() })); break;
    case 'read': result = fs.readFileSync(request.path, 'utf8'); break;
    case 'write': fs.writeFileSync(request.path, request.text); result = 'written'; break;
    case 'exec': {
      if (!Array.isArray(request.argv) || !request.argv.length || !request.argv.every(x => typeof x === 'string')) throw new Error('argv required');
      const out = fs.openSync(path.join(__dirname, 'stdout'), 'wx'), err = fs.openSync(path.join(__dirname, 'stderr'), 'wx');
      try {
        const r = spawnSync(request.argv[0], request.argv.slice(1), {
          cwd: process.cwd(), windowsHide: true, timeout: 90000, shell: false,
          stdio: ['ignore', out, err], env: process.env,
        });
        result = { status: r.status, error: r.error?.message,
          stdout: fs.readFileSync(path.join(__dirname, 'stdout'), 'utf8'), stderr: fs.readFileSync(path.join(__dirname, 'stderr'), 'utf8') };
      } finally { fs.closeSync(out); fs.closeSync(err); }
      break;
    }
    default: throw new Error('unknown implementation operation');
  }
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ result }));
} catch (e) {
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ error: e.code || e.message }));
}
