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
/** Is this path inside the workspace this tool was launched in? Used ONLY to decide whether the
 *  create-only workflow rule applies — never as a containment check. Containment is the OS boundary's
 *  job, and when this cannot tell, it answers false so the write proceeds to the boundary instead. */
function insideWorkspace(p) {
  try {
    if (typeof p !== 'string' || p === '') return false;
    const root = path.resolve(process.cwd());
    const target = path.resolve(p);
    return target === root || target.startsWith(root + path.sep);
  } catch { return false; }
}

function apply(op, index, createOnly) {
  switch (op?.op) {
    case 'list': return fs.readdirSync(op.path || '.', { withFileTypes: true }).map(e => ({ name: e.name, directory: e.isDirectory() }));
    case 'read': return fs.readFileSync(op.path, 'utf8');
    case 'write': {
      // v1.3 §25 — `write` is documented TO THE MODEL as "CREATE a file", and until now it overwrote
      // silently. MEASURED: the dominant term in the confined arm's cost was whole-file re-emission
      // (`src/api.js`, 979 B on disk, written NINE times) — the model using `write` to CHANGE files because
      // nothing stopped it, with every byte staying in the context for the rest of the run. So this is a
      // correctness fix first: the tool now does what its own contract says.
      //
      // SCOPED TWICE, deliberately, so this workflow rule can never take credit for a CONTAINMENT refusal:
      //   * `createOnly` is false for the bare one-operation form that trusted callers and the security
      //     probes use;
      //   * and it applies only to paths INSIDE the workspace. A write aimed outside it is a containment
      //     question, and if this guard refused it first, an attack battery could report "blocked" for the
      //     wrong reason and hide a real containment regression.
      if (createOnly && insideWorkspace(op.path) && fs.existsSync(op.path)) {
        throw new Error('write CREATES a file and this path already exists — use edit: set "find" to a snippet '
          + 'occurring exactly once, or to "" to replace the whole file');
      }
      fs.writeFileSync(op.path, op.text); return 'written';
    }
    // v1.3 §D — CHANGE an existing file by sending only the part that changes.
    //
    // WHY THIS EXISTS, measured: the model's own output is ~70% of the confined arm's token cost on a long
    // task, and the dominant term is that the previous tool set had no way to express a change — only
    // `write`, which re-emits the WHOLE file body inside the assistant message, where it is then re-read on
    // every later turn. Measured on the stateful fixture: `src/api.js` (979 B on disk) written NINE times.
    //
    // SAFETY: this grants NOTHING. `write` already accepted arbitrary content for the same path, so `edit`
    // can produce no byte `write` could not; the path handling, the containment and the OS token are
    // identical. It is the same mutation, expressed smaller.
    //
    // The anchor must occur EXACTLY ONCE. An ambiguous anchor is REFUSED rather than resolved by guessing —
    // a tool that silently edits the wrong occurrence is worse than one that makes the caller be specific,
    // and "the first match" is exactly the kind of quiet wrong-place mutation that is invisible in a diff.
    case 'edit': {
      if (typeof op.replace !== 'string') throw new Error('replace (a string) is required');
      if (typeof op.find !== 'string') throw new Error('find (a string) is required — use "" to replace the whole file');
      const text = fs.readFileSync(op.path, 'utf8');
      if (op.find === '') { fs.writeFileSync(op.path, op.replace); return 'edited'; }
      if (op.find === op.replace) throw new Error('find and replace are identical — nothing to do');
      const first = text.indexOf(op.find);
      if (first < 0) throw new Error('find does not occur in the file');
      if (text.indexOf(op.find, first + op.find.length) >= 0) throw new Error('find occurs more than once — extend it until it is unique');
      fs.writeFileSync(op.path, text.slice(0, first) + op.replace + text.slice(first + op.find.length));
      return 'edited';
    }
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
/**
 * v1.3 §23 — run the project's OWN declared check, for opt-in per-batch feedback.
 *
 * This is NOT verification and cannot become one: it runs the command the project already declares, in the
 * workspace the caller already controls, and returns its output. No verdict is minted, the trusted
 * completion gate is untouched, and the caller could have run exactly this itself (it did, ~36 times in the
 * recorded session — each time costing a model round trip, which is the expense this removes).
 *
 * The output is BOUNDED and keeps a HEAD and a TAIL, because the two shapes disagree: Node prints the cause
 * first and a version footer last, while test runners print their summary last. Keeping only one end would
 * reliably hide the useful half for one of them. An unbounded dump would re-create the context cost this
 * exists to remove.
 */
const CHECK_SEGMENT_CHARS = 220;
function runDeclaredCheck(argv) {
  let r;
  try { r = apply({ op: 'exec', argv }, 'check'); }
  catch (e) { return { ran: false, error: e.code || e.message }; }
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const truncated = text.length > CHECK_SEGMENT_CHARS * 2;
  const summary = truncated
    ? `${text.slice(0, CHECK_SEGMENT_CHARS)}\n... [${text.length - CHECK_SEGMENT_CHARS * 2} bytes omitted] ...\n${text.slice(-CHECK_SEGMENT_CHARS)}`
    : text;
  return { ran: true, status: r.status, truncated, summary,
    note: 'this project\'s own check output — not a Canary verdict, and not proof that the work is done' };
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
      try { outcomes.push({ index, op: request.operations[index]?.op ?? null, result: apply(request.operations[index], index, true) }); }
      catch (e) { stopped = `operation ${index} (${request.operations[index]?.op ?? 'unknown'}) failed: ${e.code || e.message}`; outcomes.push({ index, op: request.operations[index]?.op ?? null, error: e.code || e.message }); }
    }
    result = stopped ? { operations: outcomes, failed: stopped } : { operations: outcomes };
    // Only when the batch actually CHANGED something: a read-only call needs no check, and running one
    // would spend wall clock to answer a question nobody asked.
    if (request.check && Array.isArray(request.check.argv) && request.check.argv.length
        && request.check.argv.every(x => typeof x === 'string')
        && outcomes.some(o => !o.skipped && !o.error && (o.op === 'write' || o.op === 'edit'))) {
      result.check = runDeclaredCheck(request.check.argv);
    }
  } else {
    // Trusted callers and the security probes keep the exact one-operation contract and
    // report shape they were verified against: { result } or { error }.
    result = apply(request, 0, false);
  }
} catch (e) {
  failure = e.code || e.message;
}
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(failure ? { error: failure } : { result }));
