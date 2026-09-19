// Untrusted implementation executor: this file runs ONLY inside the AppContainer.
//
// The model-facing contract carries a LIST of operations in ONE call, so a session costs
// fewer model round trips for exactly the same authority: the same four primitives, the
// same paths, the same boundary, one confined process per call. There is no separate
// one-operation form offered to the worker (see provider/worker-tools.ts); the bare form
// below exists only for trusted callers and the security probes, which never run as the
// model.
//
// Failure semantics, deliberately conservative:
//   * an operation that returns a non-zero EXIT STATUS is a RESULT (that is what tools
//     do), and the batch continues;
//   * an operation that raises (a refused path, a missing file, a malformed request) STOPS
//     the batch. The report names the index and the operation, and the remainder is
//     marked skipped rather than silently attempted — continuation after a refusal is not
//     assumed safe.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { request, runtime } = JSON.parse(fs.readFileSync(path.join(__dirname, 'request.json'), 'utf8'));
process.env.PATH = `${runtime};${path.join(process.env.SystemRoot, 'System32')}`;
process.env.ComSpec = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
process.env.NODE_OPTIONS = '--preserve-symlinks-main --preserve-symlinks';

const MAX_OPERATIONS = 64;

/** One primitive. Throws on refusal; the caller decides whether that ends the call. */
function apply(op, index) {
  switch (op?.op) {
    case 'list': return fs.readdirSync(op.path || '.', { withFileTypes: true }).map(e => ({ name: e.name, directory: e.isDirectory() }));
    case 'read': return fs.readFileSync(op.path, 'utf8');
    case 'write': fs.writeFileSync(op.path, op.text); return 'written';
    case 'exec': {
      if (!Array.isArray(op.argv) || !op.argv.length || !op.argv.every(x => typeof x === 'string')) throw new Error('argv required');
      // A unique pair of files per operation: two execs in one call must not collide.
      const outPath = path.join(__dirname, `stdout-${index}`), errPath = path.join(__dirname, `stderr-${index}`);
      const out = fs.openSync(outPath, 'wx'), err = fs.openSync(errPath, 'wx');
      try {
        const r = spawnSync(op.argv[0], op.argv.slice(1), {
          cwd: process.cwd(), windowsHide: true, timeout: 90000, shell: false,
          stdio: ['ignore', out, err], env: process.env,
        });
        return { status: r.status, error: r.error?.message,
          stdout: fs.readFileSync(outPath, 'utf8'), stderr: fs.readFileSync(errPath, 'utf8') };
      } finally { fs.closeSync(out); fs.closeSync(err); }
    }
    default: throw new Error('unknown implementation operation');
  }
}
let result, failure;
try {
  if (Array.isArray(request.operations)) {
    if (!request.operations.length) throw new Error('at least one operation is required');
    if (request.operations.length > MAX_OPERATIONS) throw new Error(`at most ${MAX_OPERATIONS} operations per call`);
    const outcomes = [];
    let stopped = null;
    for (let index = 0; index < request.operations.length; index++) {
      if (stopped) { outcomes.push({ index, op: request.operations[index]?.op ?? null, skipped: true, because: stopped }); continue; }
      try { outcomes.push({ index, op: request.operations[index]?.op ?? null, result: apply(request.operations[index], index) }); }
      catch (e) { stopped = `operation ${index} (${request.operations[index]?.op ?? 'unknown'}) failed: ${e.code || e.message}`; outcomes.push({ index, op: request.operations[index]?.op ?? null, error: e.code || e.message }); }
    }
    result = stopped ? { operations: outcomes, failed: stopped } : { operations: outcomes };
  } else {
    // Trusted callers and the security probes keep the exact one-operation contract and
    // report shape they were verified against: { result } or { error }.
    result = apply(request, 0);
  }
} catch (e) {
  failure = e.code || e.message;
}
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(failure ? { error: failure } : { result }));
