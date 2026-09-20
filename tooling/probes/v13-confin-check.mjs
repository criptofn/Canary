// v1.3 §23 — DOES THE PER-BATCH CHECK BEHAVE, AND DOES IT STAY OUT OF THE VERDICT'S WAY?
//
// The confined worker is launched once and never told a verdict, so it re-ran its own checks ~36 times and
// wrote a 58,587 B rig — every byte of it re-read on each of ~20 later turns. Returning the project's own
// check result after a batch removes the need to ASK, and the measured cost is ~45 ms against 90 s of
// transport headroom. This probe verifies the two things that decide whether that is safe to ship:
//
//   * it RUNS when it should — after a batch that changed files, bounded, with the exit status;
//   * it stays OUT of the way when it should — not on a read-only batch, not without a declared check, and
//     never presenting itself as a verdict while doing so.
//
// It drives `production-tool.cjs` directly, the way the trusted caller does: copy the tool into a scratch
// directory, write the `request.json` it reads from its own `__dirname`, run it with the project as cwd, and
// read `result.json`. That exercises the real program without the AppContainer round trip, which is the
// right trade for a behavioural check — the confinement itself is measured by the boundary probes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const toolSrc = path.join(repo, 'tools/windows-boundary/production-tool.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-confin-check-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Drive the real tool once, exactly as the trusted caller does. */
function drive(cwd, request, tag) {
  const call = fs.mkdtempSync(path.join(temp, `call-${tag}-`));
  fs.copyFileSync(toolSrc, path.join(call, 'tool.cjs'));
  fs.writeFileSync(path.join(call, 'request.json'),
    JSON.stringify({ request, runtime: path.dirname(process.execPath) }));
  const r = spawnSync(process.execPath, [path.join(call, 'tool.cjs')], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  const outPath = path.join(call, 'result.json');
  const doc = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc, result: doc?.result ?? null };
}

try {
  const project = path.join(temp, 'project');
  fs.mkdirSync(project, { recursive: true });
  // data.txt deliberately does NOT exist yet: `write` now CREATES (and refuses to overwrite), so the first
  // case has to be a real creation, which is also what the model's own contract says it is for.
  // A check the project "declares": it passes or fails on the content of data.txt, and it prints a marker.
  fs.writeFileSync(path.join(project, 'check.cjs'), [
    "const fs = require('node:fs');",
    "const v = fs.readFileSync('data.txt', 'utf8').trim();",
    "console.log('checked:', v);",
    "if (v !== 'two') { console.error('expected two, got', v); process.exit(1); }",
    '',
  ].join('\n'));

  const nodeExe = process.execPath;
  const checkArgv = [nodeExe, 'check.cjs'];

  // ── A: a batch that CHANGES a file, with a declared check ──
  const a = drive(project, { operations: [{ op: 'write', path: 'data.txt', text: 'two\n' }], check: { argv: checkArgv } }, 'a');
  check('A1-a-mutating-batch-returns-the-declared-check-result', () => {
    assert(a.result, `no result at all (exit ${a.status}): ${a.stderr.slice(0, 200)}`);
    const c = a.result.check;
    assert(c, `the batch changed a file but no check was returned: ${JSON.stringify(a.result).slice(0, 200)}`);
    assert(c.ran === true, `check.ran was ${JSON.stringify(c.ran)}: ${JSON.stringify(c)}`);
    assert(c.status === 0, `the project check now passes but status was ${JSON.stringify(c.status)}: ${JSON.stringify(c)}`);
    assert(String(c.summary).includes('checked: two'), `the check output was not returned: ${JSON.stringify(c.summary)}`);
  });

  check('A2-the-check-result-says-out-loud-that-it-is-not-a-verdict', () => {
    const c = a.result?.check ?? {};
    assert(typeof c.note === 'string' && /not a Canary verdict/i.test(c.note),
      'the check result carries no note saying it is not a verdict. It is the worker\'s own project output, '
      + 'and a worker that mistook it for proof would be trusting the wrong thing');
  });

  // ── B: the check now FAILS, so the status must follow the bytes ──
  const b = drive(project, { operations: [{ op: 'edit', path: 'data.txt', find: 'two', replace: 'three' }], check: { argv: checkArgv } }, 'b');
  check('B1-a-failing-check-reports-its-failure-and-does-not-block-the-batch', () => {
    const c = b.result?.check;
    assert(c?.ran === true, `no check ran: ${JSON.stringify(b.result).slice(0, 200)}`);
    assert(c.status === 1, `expected exit 1 from the failing check, got ${JSON.stringify(c.status)}`);
    assert(String(c.summary).includes('expected two'), `the failure text was not returned: ${JSON.stringify(c.summary)}`);
    // The batch itself still succeeded: this is feedback, not a gate.
    assert(Array.isArray(b.result.operations) && b.result.operations[0]?.result === 'edited',
      `the batch did not apply: ${JSON.stringify(b.result.operations)}`);
  });

  // ── C: a READ-ONLY batch must not spend the check ──
  const c = drive(project, { operations: [{ op: 'read', path: 'data.txt' }], check: { argv: checkArgv } }, 'c');
  check('C1-a-read-only-batch-runs-NO-check', () => {
    assert(c.result && Array.isArray(c.result.operations), 'the read batch produced no operations result');
    assert(c.result.check === undefined,
      'a read-only batch ran the project check anyway, spending wall clock to answer a question nobody '
      + `asked: ${JSON.stringify(c.result.check)}`);
  });

  // ── D: no declared check → the result shape is exactly what it was before this feature ──
  const d = drive(project, { operations: [{ op: 'write', path: 'four.txt', text: 'four\n' }] }, 'd');
  check('D1-without-a-check-the-result-is-UNCHANGED (the trusted shape is additive)', () => {
    assert(d.result && d.result.check === undefined, `a check appeared with none declared: ${JSON.stringify(d.result.check)}`);
    assert(Object.keys(d.result).length === 1 && Array.isArray(d.result.operations),
      `the trusted result shape changed: ${Object.keys(d.result).join(',')}`);
  });

  // ── E: a malformed check never crashes the call ──
  const e = drive(project, { operations: [{ op: 'write', path: 'five.txt', text: 'five\n' }], check: { argv: 'not-an-array' } }, 'e');
  check('E1-a-malformed-check-is-ignored-not-fatal', () => {
    assert(e.result && e.result.check === undefined, `a malformed check produced a result: ${JSON.stringify(e.result?.check)}`);
    assert(e.result.operations[0]?.result === 'written', 'the batch did not apply when the check was malformed');
  });

  // ── F: an unbounded dump must not come back ──
  const noisy = path.join(temp, 'noisy');
  fs.mkdirSync(noisy, { recursive: true });
  fs.writeFileSync(path.join(noisy, 'data.txt'), 'one\n');
  fs.writeFileSync(path.join(noisy, 'noisy.cjs'), "console.log('H'.repeat(4000)); process.exit(0);\n");
  const f = drive(noisy, { operations: [{ op: 'write', path: 'fresh.txt', text: 'x\n' }], check: { argv: [nodeExe, 'noisy.cjs'] } }, 'f');
  check('F1-a-noisy-check-is-BOUNDED (an unbounded dump would re-create the cost this removes)', () => {
    const c = f.result?.check;
    assert(c?.ran === true, `no check ran: ${JSON.stringify(f.result).slice(0, 200)}`);
    assert(c.truncated === true, 'a 4000-byte check output was not marked truncated');
    assert(String(c.summary).length < 700,
      `the summary came back at ${String(c.summary).length} chars; it must stay bounded`);
    console.log(`INFO   noisy check: ${String(c.summary).length} chars returned, truncated=${c.truncated}`);
  });

  // ── G: `write` now does what its own contract says (v1.3 §25) ──
  // The description the model reads has always said "write (CREATE a file)", and the tool overwrote
  // silently. MEASURED: whole-file re-emission was the dominant cost term (`src/api.js`, 979 B on disk,
  // written NINE times) — the model changing files with the verb that was not for changing them.
  const g1 = drive(project, { operations: [{ op: 'write', path: 'data.txt', text: 'clobber\n' }] }, 'g1');
  check('G1-write-to-an-EXISTING-path-is-refused-and-names-the-verb-that-works', () => {
    const first = g1.result?.operations?.[0];
    assert(first?.error, `write overwrote an existing file instead of refusing: ${JSON.stringify(first)}`);
    assert(/edit/i.test(String(first.error)),
      `the refusal does not name \`edit\`, so a caller is told no without being told what to do instead: ${first.error}`);
    assert(fs.readFileSync(path.join(project, 'data.txt'), 'utf8').trim() !== 'clobber',
      'the file was changed even though the operation reported an error');
  });

  const g2 = drive(project, { operations: [{ op: 'edit', path: 'data.txt', find: '', replace: 'seven\n' }] }, 'g2');
  check('G2-no-capability-was-lost-the-whole-file-form-of-edit-still-works', () => {
    assert(g2.result?.operations?.[0]?.result === 'edited', `edit with find:"" failed: ${JSON.stringify(g2.result?.operations?.[0])}`);
    assert(fs.readFileSync(path.join(project, 'data.txt'), 'utf8').trim() === 'seven',
      'the whole-file replacement did not take effect, so the refusal above removed a capability');
  });

  const g3 = drive(project, { op: 'write', path: 'data.txt', text: 'trusted\n' }, 'g3');
  check('G3-the-TRUSTED-one-operation-form-is-UNCHANGED (the security probes keep their meaning)', () => {
    // If this guard also applied to the bare form, a containment attack that targets an existing path would
    // be refused HERE first — and an attack battery could then report "blocked" for the wrong reason, hiding
    // a containment regression. The model-facing path is the one that gets the contract.
    assert(g3.result === 'written', `the bare trusted form was refused: ${JSON.stringify(g3.doc)}`);
    assert(fs.readFileSync(path.join(project, 'data.txt'), 'utf8').trim() === 'trusted',
      'the bare trusted form did not overwrite, so this guard leaked into the security-probe path');
  });

  const outside = path.join(temp, 'outside-workspace.txt');
  fs.writeFileSync(outside, 'original\n');
  const g4 = drive(project, { operations: [{ op: 'write', path: outside, text: 'clobbered\n' }] }, 'g4');
  check('G4-the-guard-does-NOT-fire-outside-the-workspace (containment keeps its meaning)', () => {
    // An attack on a path outside the workspace must be refused by the OS BOUNDARY, not by a workflow rule.
    // If this guard fired first, an attack battery would report "blocked" for the wrong reason and could
    // hide a containment regression. Here the tool runs unconfined, so the write simply succeeds — which is
    // precisely the proof that this guard stayed out of the containment question.
    const first = g4.result?.operations?.[0];
    assert(first?.result === 'written',
      `the create-only guard refused a path OUTSIDE the workspace (${JSON.stringify(first?.error ?? first)}). `
      + 'Containment is the boundary\'s job; this guard must not be able to take credit for it');
    console.log('INFO   outside-workspace write was left to the boundary, as designed');
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 confined check feedback — runs when it should, stays out of the way otherwise`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.log(`FAIL v1.3 confined check feedback — ${String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
