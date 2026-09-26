#!/usr/bin/env node
/**
 * v1.5 evidence release, audit finding R1 — ONE ATTEMPT IS ONE IMMUTABLE DIRECTORY.
 *
 * THE DEFECT THIS PROBE PINS (measured, 2026-09-24, `runs/R1-refactron-pytest-ids/`):
 * `tooling/probes/v15-realworld-run-task.mjs` used to open its output directory with
 * `fs.mkdirSync(outDir, { recursive: true })` and then write each artifact to a FIXED
 * file name inside it with `fs.writeFileSync`. A second attempt at the same task
 * therefore truncated the first attempt's raw stream, parsed stream, ledger, record,
 * diff and git state, while the files the second attempt never wrote — the first
 * attempt's `hook-input.json` and `checkpoint-manual.*` — stayed in place. One directory
 * ended up holding two attempts' bytes, one of them incomplete, and the second attempt
 * read the first attempt's leftover checkpoint as its own `checkpointBefore`.
 *
 * WHAT THIS PROBE PROVES (all of it about the REAL probe, spawned as a child process —
 * not a re-implementation of it):
 *   1. one attempt = one directory holding its own start metadata, raw stream, parsed
 *      record, checkpoint events, manual checkpoint, final result, timestamps, starting
 *      repo identity and hash manifest;
 *   2. re-running the same task into the same run root is REFUSED and changes nothing —
 *      no artifact is truncated, no leftover is inherited;
 *   3. `--new-attempt` opens a SECOND directory instead of refusing, and the first
 *      attempt's bytes stay byte-identical: the two attempts never mix;
 *   4. each attempt is separately recoverable from its own directory (identity, timeline
 *      and SHA256SUMS all verify per attempt);
 *   5. a run root that already holds pre-layout ("flat") evidence is never written into
 *      and never read from; a new attempt there must be named explicitly.
 *
 * The agent under test is a STUB harness (a few NDJSON lines), so this measures the
 * provenance layer and nothing about any model. The probe under test records the exact
 * command it spawned, and every artifact this probe checks says the run was a stub.
 *
 * USAGE
 *   node tooling/probes/v15-attempt-provenance.mjs            # run the regression
 *   node tooling/probes/v15-attempt-provenance.mjs --keep     # keep the temp fixtures
 *   node tooling/probes/v15-attempt-provenance.mjs --audit <run dir>   # attribute a real
 *                                                          # bundle's artifacts to attempts
 *
 * EXIT: 0 only when every check passed. Fixtures live under the OS temp dir only.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PROBE = path.join(REPO, 'tooling', 'probes', 'v15-realworld-run-task.mjs');
const NODE = process.execPath;
const KEEP = process.argv.includes('--keep');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const EXPECTED_ATTEMPT_FILES = [
  'SHA256SUMS', 'agent.diff', 'agent.stderr.raw.txt', 'agent.stderr.txt',
  'agent.stream.jsonl', 'agent.stream.raw.txt', 'attempt-result.json', 'attempt.json',
  'checkpoint-events.json', 'checkpoint-manual.stderr.txt', 'checkpoint-manual.stdout.txt',
  'git-after.json', 'git-before.json', 'hook-input.json', 'ledger.json', 'record.json',
].sort();
const FLAT_EVIDENCE = [
  'record.json', 'ledger.json', 'agent.stream.raw.txt', 'agent.stream.jsonl',
  'agent.stderr.raw.txt', 'agent.stderr.txt', 'git-before.json', 'git-after.json',
  'agent.diff', 'hook-input.json', 'checkpoint-manual.stdout.txt', 'checkpoint-manual.stderr.txt',
];

/** A directory digest: every file's name, size, mtime and content hash, sorted. */
function digestDir(dir) {
  const rows = [];
  const walk = (d, prefix) => {
    for (const name of list(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { rows.push(`${prefix}${name}/`); walk(p, `${prefix}${name}/`); continue; }
      rows.push(`${prefix}${name} ${st.size} ${Math.round(st.mtimeMs)} ${sha256(fs.readFileSync(p))}`);
    }
  };
  walk(dir, '');
  return sha256(rows.join('\n'));
}

function verifySums(attemptDir) {
  const manifest = readText(path.join(attemptDir, 'SHA256SUMS'));
  if (manifest === null) return { ok: false, why: 'no SHA256SUMS' };
  const covered = new Set();
  for (const line of manifest.split('\n').filter((l) => l.trim())) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
    if (!m) return { ok: false, why: `unparseable line: ${line}` };
    const [, want, name] = m;
    if (path.basename(name) !== name) return { ok: false, why: `manifest names a path outside the attempt: ${name}` };
    const bytes = fs.readFileSync(path.join(attemptDir, name));
    if (sha256(bytes) !== want) return { ok: false, why: `${name} does not match its recorded hash` };
    covered.add(name);
  }
  const present = list(attemptDir).filter((n) => n !== 'SHA256SUMS');
  const missing = present.filter((n) => !covered.has(n));
  if (missing.length) return { ok: false, why: `not covered by the manifest: ${missing.join(', ')}` };
  return { ok: true, covered: covered.size };
}

// ──────────────────────────────────────────────────────────────── audit mode ──
/**
 * Attributes the artifacts of a REAL (pre-layout, flat) run directory to attempts, using
 * only what is on disk: the recorded attempt's own window (`startedAt`…`finishedAt` in
 * `ledger.json`/`record.json`) and each artifact's mtime. An artifact that PREDATES the
 * recorded attempt cannot belong to it — that is the R1 signature, and it is reported as
 * MIXED rather than quietly attributed.
 */
function audit(dir) {
  const abs = path.resolve(dir);
  console.log(`AUDIT ${abs}`);
  const rec = readJson(path.join(abs, 'record.json')) ?? readJson(path.join(abs, 'ledger.json'));
  if (rec === null) { console.log('AUDIT: no record.json/ledger.json — nothing to attribute against'); process.exit(1); }
  const start = Date.parse(rec.startedAt);
  const end = Date.parse(rec.finishedAt ?? new Date().toISOString());
  console.log(`RECORDED ATTEMPT: label=${rec.label} arm=${rec.arm} wallSeconds=${rec.wallSeconds} window=${new Date(start).toISOString()}..${new Date(end).toISOString()}`);
  console.log(`RECORDED FLAGS: hookFiredDuringRun=${rec.hookFiredDuringRun} checkpointDrivenManually=${rec.checkpointDrivenManually} timedOut=${rec.timedOut} sawResultEvent=${rec.sawResultEvent}`);
  const TOL = 2000;
  let mixed = 0;
  for (const name of list(abs)) {
    const st = fs.statSync(path.join(abs, name));
    if (st.isDirectory()) { console.log(`  DIR   ${name}`); continue; }
    const t = st.mtimeMs;
    if (t < start - TOL) {
      mixed++;
      console.log(`  OTHER ${name}  mtime=${new Date(t).toISOString()}  → predates the recorded attempt by ${Math.round((start - t) / 1000)}s: it belongs to an EARLIER attempt`);
    } else {
      console.log(`  THIS  ${name}  mtime=${new Date(t).toISOString()}`);
    }
  }
  const before = (() => { try { return JSON.parse(rec.checkpointBefore); } catch { return null; } })();
  if (before?.at) {
    const bt = Date.parse(before.at);
    const inWindow = bt >= start - TOL && bt <= end + TOL;
    console.log(`checkpointBefore.at=${before.at} → ${inWindow ? 'inside' : 'OUTSIDE'} the recorded attempt's window${inWindow ? '' : ' (inherited from another attempt)'}`);
    if (!inWindow) mixed++;
  }
  console.log(mixed ? `AUDIT RESULT: MIXED — ${mixed} artifact(s)/state belong to a different attempt than record.json describes` : 'AUDIT RESULT: SINGLE — every artifact is inside the recorded attempt');
  process.exit(0);
}
const auditAt = process.argv.indexOf('--audit');
if (auditAt !== -1) {
  if (!process.argv[auditAt + 1]) { console.error('usage: --audit <run dir>'); process.exit(2); }
  audit(process.argv[auditAt + 1]);
}

// ────────────────────────────────────────────────────────────── regression ──
let failures = 0;
let passed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const run = (args, opts = {}) => spawnSync(NODE, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 600_000, cwd: opts.cwd ?? REPO, input: opts.input });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-v15-attempt-prov-'));
console.log(`TEMP: ${temp}\n`);
const fixtureRepo = path.join(temp, 'fixture-repo');
const stub = path.join(temp, 'stub-harness.mjs');
const taskFile = path.join(temp, 'task.md');
const runRoot = path.join(temp, 'run');
const legacyRoot = path.join(temp, 'run-legacy');
let probeCmd = null;

try {
  // ── fixture: a tiny, real, sealed project plus a stub harness ────────────────
  fs.mkdirSync(path.join(fixtureRepo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRepo, '.claude', 'settings.json'), `${JSON.stringify({
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fixture-user-stop-hook' }] }] },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(fixtureRepo, 'package.json'), `${JSON.stringify({
    name: 'v15-attempt-provenance-fixture', version: '1.0.0', private: true,
    scripts: { test: 'node --test greeting.test.cjs' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(fixtureRepo, 'greeting.cjs'), 'module.exports = (name) => `Hello, ${name}!`;\n');
  fs.writeFileSync(path.join(fixtureRepo, 'greeting.test.cjs'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const greeting = require('./greeting.cjs');",
    '',
    "test('greeting greets by name', () => { assert.equal(greeting('Ada'), 'Hello, Ada!'); });",
    '',
  ].join('\n'));
  for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Op', '-c', 'user.email=op@localhost', 'commit', '-q', '-m', 'fixture']]) {
    const g = spawnSync('git', ['-C', fixtureRepo, ...a], { encoding: 'utf8' });
    if (g.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${g.stderr}`);
  }
  fs.writeFileSync(taskFile, 'Stub task for the provenance regression: change nothing and finish.\n');
  /**
   * The stub harness. It is NOT an agent: it emits the NDJSON shape the probe parses and
   * exits 0. Every artifact the probe produces for a stub run records the exact command,
   * and the probe prints a WARNING, so a stub run cannot be mistaken for real evidence.
   */
  fs.writeFileSync(stub, [
    '#!/usr/bin/env node',
    '// STUB HARNESS (tooling/probes/v15-attempt-provenance.mjs). Not a model, not an agent.',
    'const events = [',
    "  { type: 'system', subtype: 'init', session_id: 'stub-harness-session' },",
    "  { type: 'assistant', message: { model: 'stub-harness', role: 'assistant', content: [{ type: 'text', text: 'stub harness: no work performed' }] } },",
    "  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } },",
    '];',
    "for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');",
    'process.exit(0);',
    '',
  ].join('\n'));

  const setup = run([path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js'), 'setup', '--yes'], { cwd: fixtureRepo });
  check('fixture: the sealed plan is set up (setup --yes ends READY)', () => {
    assert(setup.status === 0 && /READY/.test(setup.stdout), `exit ${setup.status}\n${setup.stdout}${setup.stderr}`);
  });
  check('fixture: the fixture repository has NO ancestor git repository of its own making (its own .git is the root)', () => {
    const top = spawnSync('git', ['-C', fixtureRepo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    eq(path.resolve((top.stdout ?? '').trim()).toLowerCase(), path.resolve(fixtureRepo).toLowerCase(), 'selected root');
  });
  /**
   * The gate must have something to refuse. A checkpoint on a project whose sealed checks
   * PASS prints an empty line — that is the hook contract's "allow", not a refusal — so the
   * fixture is broken AFTER `setup` sealed the passing plan. Every attempt below therefore
   * ends with a real decision on stdout, which is also the shape of the R1 attempt that was
   * manually driven (a failing sealed check, not the agent's fault).
   */
  fs.writeFileSync(path.join(fixtureRepo, 'greeting.cjs'), 'module.exports = (name) => `hello, ${name}!`;\n');

  const probeArgs = (outRoot, extra = []) => [
    PROBE, '--repo', fixtureRepo, '--task-file', taskFile, '--label', 'T1-stub-task', '--out', outRoot,
    '--timeout-min', '2', '--agent-cmd', NODE, '--agent-arg', '--', '--agent-arg', stub, ...extra,
  ];
  probeCmd = (outRoot, extra = []) => run(probeArgs(outRoot, extra));

  // ── 1. the first attempt ─────────────────────────────────────────────────────
  const r1 = probeCmd(runRoot);
  console.log(r1.stdout.trimEnd());
  const a1 = path.join(runRoot, 'attempt-1');
  let a1Digest = null;

  check('run 1: the probe completed (RUN COMPLETE, exit 0)', () => {
    assert(r1.status === 0, `exit ${r1.status}\n${r1.stdout}${r1.stderr}`);
    assert(/RUN COMPLETE/.test(r1.stdout), 'no RUN COMPLETE line');
  });
  check('run 1: the run root holds the attempt as a DIRECTORY and no artifact of its own', () => {
    eq(JSON.stringify(list(runRoot)), JSON.stringify(['attempt-1']), 'run root entries');
  });
  check('run 1: attempt-1 holds the complete per-attempt artifact set', () => {
    eq(JSON.stringify(list(a1)), JSON.stringify(EXPECTED_ATTEMPT_FILES), 'attempt-1 entries');
  });
  check('run 1: start metadata records the attempt identity, the command and the starting repo identity', () => {
    const meta = readJson(path.join(a1, 'attempt.json'));
    assert(meta !== null, 'no attempt.json');
    eq(meta.attemptId, 'attempt-1', 'attempt.json attemptId');
    eq(meta.taskId, 'T1-stub-task', 'attempt.json taskId');
    assert(meta.agentCommand.startsWith(NODE), `agentCommand does not name the stub: ${meta.agentCommand}`);
    assert(/^[0-9a-f]{40}$/.test(meta.startingRepoIdentity?.head ?? ''), `no starting HEAD: ${JSON.stringify(meta.startingRepoIdentity)}`);
    assert(Date.parse(meta.startedAt) <= Date.parse(readJson(path.join(a1, 'ledger.json')).startedAt), 'attempt.json was not written at the start');
    eq(meta.startingRepoIdentity.head, readJson(path.join(a1, 'git-before.json')).head, 'starting HEAD vs git-before.json');
  });
  check('run 1: every artifact of the attempt names the SAME identity', () => {
    for (const f of ['ledger.json', 'record.json', 'attempt-result.json']) {
      const doc = readJson(path.join(a1, f));
      eq(doc?.attemptId, 'attempt-1', `${f} attemptId`);
      eq(path.resolve(doc?.attemptDir ?? ''), path.resolve(a1), `${f} attemptDir`);
    }
  });
  check('run 1: the checkpoint events and the manual checkpoint belong to THIS attempt', () => {
    const events = readJson(path.join(a1, 'checkpoint-events.json'));
    const rec = readJson(path.join(a1, 'record.json'));
    assert(events !== null, 'no checkpoint-events.json');
    eq(events.checkpointDrivenManually, true, 'checkpoint-events.checkpointDrivenManually');
    eq(rec.checkpointDrivenManually, true, 'record.checkpointDrivenManually');
    eq(events.before.raw, rec.checkpointBefore, 'checkpoint-events.before.raw vs record.checkpointBefore');
    const hookInput = readJson(path.join(a1, 'hook-input.json'));
    assert(path.resolve(hookInput.transcript_path).startsWith(path.resolve(a1)), `hook transcript_path is not inside the attempt: ${hookInput.transcript_path}`);
  });
  check('run 1: SHA256SUMS covers every artifact of the attempt and verifies', () => {
    const v = verifySums(a1);
    assert(v.ok, v.why);
    assert(v.covered === EXPECTED_ATTEMPT_FILES.length - 1, `manifest covers ${v.covered} of ${EXPECTED_ATTEMPT_FILES.length - 1} artifacts`);
  });
  a1Digest = digestDir(a1);
  const a1Files = list(a1);

  // ── 2. the same command again must REFUSE and change nothing ────────────────
  const r2 = probeCmd(runRoot);
  console.log(r2.stdout.trimEnd());
  check('run 2 (same run root): REFUSED — non-zero exit, says REFUSED, names the next action', () => {
    assert(r2.status !== 0, `exit ${r2.status} — the probe wrote into an occupied attempt directory`);
    assert(/REFUSED/.test(r2.stdout), `no REFUSED line:\n${r2.stdout}`);
    assert(/--new-attempt/.test(r2.stdout), 'the refusal does not name the next action');
  });
  check('run 2 (same run root): attempt-1 is byte-identical after the refusal (no truncation, no leftover inherited)', () => {
    eq(digestDir(a1), a1Digest, 'attempt-1 digest');
    eq(JSON.stringify(list(runRoot)), JSON.stringify(['attempt-1']), 'run root entries');
  });

  // ── 3. --new-attempt opens a SECOND directory instead of refusing ───────────
  const r3 = probeCmd(runRoot, ['--new-attempt']);
  console.log(r3.stdout.trimEnd());
  const a2 = path.join(runRoot, 'attempt-2');
  check('run 3 (--new-attempt): a SECOND attempt directory is opened and completes', () => {
    assert(r3.status === 0, `exit ${r3.status}\n${r3.stdout}${r3.stderr}`);
    eq(JSON.stringify(list(runRoot)), JSON.stringify(['attempt-1', 'attempt-2']), 'run root entries');
    eq(JSON.stringify(list(a2)), JSON.stringify(EXPECTED_ATTEMPT_FILES), 'attempt-2 entries');
  });
  check('run 3: the first attempt is byte-identical after the second attempt ran (the two attempts do NOT mix)', () => {
    eq(digestDir(a1), a1Digest, 'attempt-1 digest');
    eq(JSON.stringify(list(a1)), JSON.stringify(a1Files), 'attempt-1 file list');
  });
  check('run 3: each attempt is separately recoverable from its own directory', () => {
    const m2 = readJson(path.join(a2, 'attempt.json'));
    eq(m2.attemptId, 'attempt-2', 'attempt-2 identity');
    eq(readJson(path.join(a2, 'record.json')).attemptId, 'attempt-2', 'attempt-2 record identity');
    const v2 = verifySums(a2);
    assert(v2.ok, `attempt-2 manifest: ${v2.why}`);
    assert(readJson(path.join(a2, 'attempt-result.json')).attemptId === 'attempt-2', 'attempt-2 result identity');
    assert(Date.parse(readJson(path.join(a2, 'attempt.json')).startedAt) >= Date.parse(readJson(path.join(a1, 'attempt-result.json')).finishedAt) - 2000,
      'attempt-2 does not start after attempt-1 finished');
  });
  check('run 3: attempt-2 owns its own manual checkpoint — it never inherits attempt-1\'s files', () => {
    const hookInput2 = readJson(path.join(a2, 'hook-input.json'));
    assert(path.resolve(hookInput2.transcript_path).startsWith(path.resolve(a2)), `attempt-2 transcript_path points outside its attempt: ${hookInput2.transcript_path}`);
    // attempt-1's manual checkpoint is written by attempt-1's own run: same bytes are
    // possible (the stub is deterministic), but the FILE must be attempt-2's own inode.
    const s1 = fs.statSync(path.join(a1, 'checkpoint-manual.stdout.txt'));
    const s2 = fs.statSync(path.join(a2, 'checkpoint-manual.stdout.txt'));
    assert(s2.mtimeMs >= s1.mtimeMs, 'attempt-2\'s manual checkpoint predates attempt-1\'s (it was inherited, not written)');
  });

  // ── 4. pre-layout (flat) evidence is never written into and never read ──────
  fs.mkdirSync(legacyRoot, { recursive: true });
  for (const name of list(a1)) {
    if (name === 'SHA256SUMS' || name === 'attempt.json' || name === 'attempt-result.json') continue;
    fs.copyFileSync(path.join(a1, name), path.join(legacyRoot, name));
  }
  /**
   * The leftover file that caused the R1 confusion was the FIRST attempt's manual
   * checkpoint. It is stamped with a sentinel here: if the next attempt ever inherited or
   * read it, the sentinel would appear inside the new attempt's directory.
   */
  const SENTINEL = 'LEGACY-ATTEMPT-SENTINEL-DO-NOT-INHERIT';
  fs.writeFileSync(path.join(legacyRoot, 'checkpoint-manual.stdout.txt'), `{"decision":"block","reason":"${SENTINEL}"}\n`);
  const legacyDigest = digestDir(legacyRoot);
  const legacyEntries = list(legacyRoot);
  const legacyHashes = Object.fromEntries(legacyEntries.map((n) => [n, sha256(fs.readFileSync(path.join(legacyRoot, n)))]));
  const r4 = probeCmd(legacyRoot);
  console.log(r4.stdout.trimEnd());
  check('run 4 (run root holding pre-layout evidence): REFUSED, and the flat evidence is untouched', () => {
    assert(r4.status !== 0, `exit ${r4.status} — the probe wrote beside un-attributed evidence`);
    assert(/REFUSED/.test(r4.stdout), `no REFUSED line:\n${r4.stdout}`);
    assert(/pre-layout|un-attributed/.test(r4.stdout), `the refusal does not say what it found:\n${r4.stdout}`);
    eq(digestDir(legacyRoot), legacyDigest, 'flat evidence digest');
  });
  const r5 = probeCmd(legacyRoot, ['--new-attempt', '--attempt', 'attempt-2']);
  check('run 5 (--new-attempt --attempt <id>): a named new attempt is allowed beside flat evidence and does not touch it', () => {
    assert(r5.status === 0, `exit ${r5.status}\n${r5.stdout}${r5.stderr}`);
    assert(/NOTE: run root .* holds un-attributed evidence/.test(r5.stdout), 'the run did not report the untouched flat evidence');
    eq(JSON.stringify(list(legacyRoot).filter((n) => n !== 'attempt-2')), JSON.stringify(legacyEntries), 'legacy entries after the new attempt');
    assert(digestDir(path.join(legacyRoot, 'attempt-2')).length === 64, 'attempt-2 digest missing');
    eq(JSON.stringify(list(path.join(legacyRoot, 'attempt-2'))), JSON.stringify(EXPECTED_ATTEMPT_FILES), 'attempt-2 entries');
  });
  check('run 5: the flat evidence of the run root is byte-identical after the new attempt ran', () => {
    for (const name of legacyEntries) {
      const st = fs.statSync(path.join(legacyRoot, name));
      assert(st.isFile(), `unexpected directory in the legacy root: ${name}`);
      eq(sha256(fs.readFileSync(path.join(legacyRoot, name))), legacyHashes[name], `${name} hash`);
    }
  });
  check('run 5: the new attempt never READ the un-attributed evidence beside it', () => {
    const inside = list(path.join(legacyRoot, 'attempt-2'));
    const carrying = inside.filter((n) => {
      const bytes = fs.readFileSync(path.join(legacyRoot, 'attempt-2', n));
      return bytes.includes(SENTINEL);
    });
    eq(JSON.stringify(carrying), '[]', 'files inside the new attempt carrying the legacy sentinel');
    eq(sha256(fs.readFileSync(path.join(legacyRoot, 'checkpoint-manual.stdout.txt'))), legacyHashes['checkpoint-manual.stdout.txt'], 'legacy sentinel file hash');
  });

  // ── 5. requested identities that must be refused ────────────────────────────
  const r6 = probeCmd(runRoot, ['--attempt', 'attempt-1']);
  check('run 6 (explicit occupied attempt id): REFUSED', () => {
    assert(r6.status !== 0 && /REFUSED/.test(r6.stdout), `exit ${r6.status}\n${r6.stdout}`);
    eq(digestDir(a1), a1Digest, 'attempt-1 digest');
  });
  const r7 = probeCmd(runRoot, ['--attempt', '../escape']);
  check('run 7 (unsafe attempt id): REFUSED and nothing is created outside the run root', () => {
    assert(r7.status !== 0 && /REFUSED/.test(r7.stdout), `exit ${r7.status}\n${r7.stdout}`);
    assert(!fs.existsSync(path.join(temp, 'escape')), 'a path escaped the run root');
    eq(JSON.stringify(list(runRoot)), JSON.stringify(['attempt-1', 'attempt-2']), 'run root entries');
  });
  const r8 = probeCmd(path.join(temp, 'fresh'), ['--new-attempt', '--attempt', 'attempt-1']);
  check('run 8 (a fresh run root, first attempt named explicitly): completes as attempt-1', () => {
    assert(r8.status === 0, `exit ${r8.status}\n${r8.stdout}${r8.stderr}`);
    eq(JSON.stringify(list(path.join(temp, 'fresh'))), JSON.stringify(['attempt-1']), 'fresh run root entries');
  });
} catch (e) {
  // A crash in the regression's own harness is a FAILURE, never a silent pass.
  failures++;
  console.log(`FAIL regression harness\n     ${String(e?.stack ?? e).split('\n').join('\n     ')}`);
} finally {
  if (KEEP) console.log(`\nKEPT: ${temp}`);
  else fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
