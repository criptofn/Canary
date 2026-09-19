// v1.3 PHASE A — the everyday developer journey, OBSERVED rather than inferred.
//
// This probe answers one question with recorded output: what does a competent developer who has
// never heard of Canary actually experience, from `git init` to "my change is verified"?
//
// It measures the journey a NORMAL user takes — no `canary bind`, no provider, no confinement,
// no expert commands — and records:
//
//   A. what `canary setup --yes` does on a fresh repository (and whether it needs a human);
//   B. whether the ordinary path (`work` -> commit in candidate -> `finish`) can COMPLETE,
//      for three intents that differ only in their WORDING;
//   C. what a naive agent that edits the working tree directly gets told afterwards
//      (the realistic default: agents edit the repository, not a candidate);
//   D. what `canary agents` claims when `.claude/` exists but no hook was ever installed;
//   E. the user-facing vocabulary of the ordinary path, counted, so jargon is measured.
//
// Everything happens under the OS temp dir. Nothing in the repository is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-journey-'));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
/** An OBSERVED GAP that this slice does not close. Recorded, printed, and deliberately NOT asserted:
 *  a baseline that turned a known-open finding into a red would be lying about which invariants hold,
 *  and one that hid it would lose the finding. */
const openFindings = [];
const finding = (name, detail) => {
  openFindings.push({ name, detail });
  console.log(`OPEN  ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};

const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'local-trust') };
const run = (exe, args, cwd, expect = 0, input) => {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300000, ...(input === undefined ? {} : { input }) });
  if (expect !== null && r.status !== expect) {
    console.log(`  !! ${exe} ${args.join(' ')} -> exit ${r.status} (expected ${expect})`);
    console.log(`  stdout: ${(r.stdout ?? '').split('\n').slice(0, 6).join(' | ')}`);
    console.log(`  stderr: ${(r.stderr ?? '').split('\n').slice(0, 6).join(' | ')}`);
  }
  return r;
};
const canary = (args, cwd, expect = 0) => run(process.execPath, [cli, ...args], cwd, expect);
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;

/** A trivial but REAL Node project whose declared check is green on the starting bytes. */
function makeProject(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', private: true,
    scripts: { test: 'node greeting.test.cjs' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'greeting.cjs'), 'module.exports = (name) => `Hello, ${name}!`;\n');
  fs.writeFileSync(path.join(dir, 'greeting.test.cjs'),
    "const assert = require('node:assert/strict');\n" +
    "const greeting = require('./greeting.cjs');\n" +
    "assert.equal(greeting('Ada'), 'Hello, Ada!');\n" +
    "console.log('greeting OK');\n");
  run('git', ['init'], dir);
  run('git', ['config', 'user.name', 'Journey Fixture'], dir);
  run('git', ['config', 'user.email', 'fixture@localhost'], dir);
  run('git', ['add', '.'], dir);
  run('git', ['commit', '-m', 'starting bytes'], dir);
}

/** The delivered change. Correct in every variant — only the WORDING of the intent differs. */
const FIXED_SRC =
  'module.exports = (name) => {\n' +
  "  if (typeof name !== 'string' || name.trim() === '') throw new Error('name is required');\n" +
  '  return `Hello, ${name.trim()}!`;\n' +
  '};\n';
const FIXED_TEST =
  "const assert = require('node:assert/strict');\n" +
  "const greeting = require('./greeting.cjs');\n" +
  "assert.equal(greeting('Ada'), 'Hello, Ada!');\n" +
  "assert.throws(() => greeting(''), /name is required/);\n" +
  "console.log('greeting OK');\n";

/** Run the whole ordinary path for one fixture and report what happened at each step. */
function journey(label, intent, extraFlags) {
  const root = path.join(temp, label);
  makeProject(root, label);
  canary(['setup', '--yes'], root, 0);
  const w = canary(['work', 'task1', intent, ...extraFlags], root, null);
  const wText = out(w);
  const printed = [...wText.matchAll(/[A-Za-z]:\\[^\s"']+/g)].map((m) => m[0].replace(/[.,)]+$/, ''));
  const cand = printed.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) ?? null;
  let fStatus = null; let fText = '(candidate never opened — finish not attempted)';
  if (cand !== null) {
    fs.writeFileSync(path.join(cand, 'greeting.cjs'), FIXED_SRC);
    fs.writeFileSync(path.join(cand, 'greeting.test.cjs'), FIXED_TEST);
    run('git', ['add', '.'], cand);
    run('git', ['-c', 'user.name=Worker', '-c', 'user.email=worker@localhost', 'commit', '-m', 'reject empty names'], cand);
    const f = canary(['finish', 'task1'], root, null);
    fStatus = f.status; fText = out(f);
  }
  const rec = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(root, '.canary', 'candidates', 'task1.json'), 'utf8')); }
    catch { return null; }
  })();
  const promoted = run('git', ['log', '--oneline', '-1'], root, 0).stdout.trim();
  return { root, intent, w, wText, cand, fStatus, fText, frozenKinds: rec?.intent?.task?.kinds ?? null, promoted };
}

// ── the vocabulary a user must decode. Counted, not judged. ──
const JARGON = ['sealed', 'seal', 'binding', 'bind', 'candidate', 'promot', 'authority', 'root of trust',
  'receipt', 'digest', 'proof', 'obligation', 'duty', 'custody', 'HARDENED', 'INCONCLUSIVE',
  'NOT PROVEN', 'BLOCKED', 'UNSUPPORTED', 'worktree', 'ledger', 'envelope', 'isolat', 'advisory',
  'GATED', 'reseal', 'attestation', 'authoriz', 'unproven', 'frozen'];
const jargonHits = (text) => {
  const hits = {};
  for (const term of JARGON) {
    const n = (text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) ?? []).length;
    if (n > 0) hits[term] = n;
  }
  return hits;
};
const merge = (a, b) => { const m = { ...a }; for (const [k, v] of Object.entries(b)) m[k] = (m[k] ?? 0) + v; return m; };

try {
  // ─────────────────────────────────────────────────────────── A. setup on a fresh repo ──
  const naive = path.join(temp, 'naive');
  makeProject(naive, 'naive-project');
  const setup = canary(['setup', '--yes'], naive, null);
  const setupText = out(setup);
  console.log('\n===== A. canary setup --yes (fresh repo) =====');
  console.log(setupText.trimEnd());
  console.log('===== end setup =====\n');
  check('setup-on-a-fresh-node-repo-exits-0', setup.status === 0, { exit: setup.status });
  check('setup-names-the-checks-it-will-run', /✓ tests: npm run test/.test(setupText),
    (setupText.match(/^.*✓ tests.*$/m) ?? ['(none)'])[0].trim());
  const statusR = canary(['status'], naive, null);
  check('status-reports-CONNECTED', /CONNECTED/.test(out(statusR)) && !/NOT CONNECTED/.test(out(statusR)),
    out(statusR).split('\n').filter(Boolean)[0]?.slice(0, 120));

  // ─────────────────────────────── B. can the ordinary path COMPLETE? (wording only differs) ──
  const v1 = journey('v1-plain', 'Reject empty names in greeting()', []);
  const v2 = journey('v2-with-kind', 'Reject empty names in greeting()', ['--kind', 'bugfix']);
  const v3 = journey('v3-keyworded', 'fix greeting so it rejects empty names', []);
  // The benchmark's OWN bug-sum fixture states its task this way. Before v1.3 this inferred NOTHING,
  // so `work` froze an empty kind set and `finish` refused a correct fix — the corpus's most ordinary
  // task was a guaranteed dead end.
  const v4 = journey('v4-bugsum-wording', 'This small Node project has a test suite that is currently failing.', []);

  for (const [tag, j] of [['B1 no --kind, intent matches no keyword', v1],
    ['B2 no --kind, but --kind bugfix given', v2],
    ['B3 no --kind, intent contains "fix"', v3],
    ['B4 the benchmark bug-sum fixture\'s own task statement', v4]]) {
    console.log(`===== ${tag} =====`);
    console.log(`intent: ${j.intent}`);
    console.log(`work   -> exit ${j.w.status}   frozen kinds: ${JSON.stringify(j.frozenKinds)}   candidate: ${j.cand === null ? 'NOT opened' : 'opened'}`);
    console.log(`finish -> exit ${j.fStatus}   base HEAD: ${j.promoted}`);
    if (j.fStatus !== 0) console.log(j.fText.trimEnd().split('\n').slice(0, 7).join('\n'));
    console.log('');
  }

  check('B2-declaring-a-kind-makes-the-same-change-complete', v2.fStatus === 0,
    { work: v2.w.status, finish: v2.fStatus, frozenKinds: v2.frozenKinds });
  check('B3-the-same-change-also-completes-when-the-wording-happens-to-match-a-keyword', v3.fStatus === 0,
    { work: v3.w.status, finish: v3.fStatus, frozenKinds: v3.frozenKinds });
  check('B4-a-failing-suite-stated-in-plain-english-is-inferred-as-bugfix-and-completes', v4.fStatus === 0,
    { work: v4.w.status, finish: v4.fStatus, frozenKinds: v4.frozenKinds });

  // THE v1.3 INVARIANT this slice establishes: `work` may complete the task, or refuse it BEFORE
  // opening anything — but it may never open a candidate that nothing could ever judge. Measured at
  // v1.2: B1 exited 0, opened a candidate, printed a success-shaped `next: canary finish`, and the
  // correct fix that followed was refused with `task-authority UNPROVEN` after the whole session.
  const v1RefusedCleanly = v1.w.status === 2 && v1.cand === null && v1.fStatus === null;
  check('B1-the-ordinary-path-never-opens-a-candidate-that-cannot-complete',
    v1.fStatus === 0 || v1RefusedCleanly,
    { work: v1.w.status, finish: v1.fStatus, candidateOpened: v1.cand !== null });
  check('B1-a-refusal-names-the-one-thing-the-human-must-supply', !v1RefusedCleanly || /--kind|--requirement/.test(v1.wText),
    (v1.wText.match(/^next:.*$/m) ?? ['(no next: line)'])[0].trim().slice(0, 160));
  check('B1-a-refusal-spends-nothing-the-task-was-never-handed-over', !v1RefusedCleanly
    || (/NOT started/.test(v1.wText) && v1.frozenKinds === null),
    { saysNotStarted: /NOT started/.test(v1.wText), registered: v1.frozenKinds !== null });

  // ───────────────────────────────── C. the naive agent edits the BASE directly ──
  fs.writeFileSync(path.join(naive, 'greeting.cjs'), FIXED_SRC);
  fs.writeFileSync(path.join(naive, 'greeting.test.cjs'), FIXED_TEST);
  const naiveDoctor = canary(['doctor'], naive, null);
  const naiveText = out(naiveDoctor);
  console.log('===== C. canary doctor after the agent edited the BASE directly =====');
  console.log(naiveText.trimEnd());
  console.log('===== end doctor =====\n');
  const dirty = run('git', ['status', '--porcelain'], naive, 0).stdout.trim();
  check('the-naive-direct-edit-leaves-the-base-dirty', dirty.length > 0,
    `${dirty.split('\n').length} path(s) changed and uncommitted`);
  /**
   * MEASURED CORRECTION to an earlier version of this probe.
   *
   * That version recorded `doctor` answering READY here as an OPEN FINDING — "an agent that edits the
   * base directly is told READY while the candidate route can refuse", i.e. a false-acceptance hole on
   * the default path. The OBSERVATION was accurate; the INFERENCE was not, and section F is what
   * settles it. This fixture changed BOTH the source and the test, so the sealed plan genuinely
   * discriminates the change (the overlay runs the edited test against the base code and it fails) —
   * the READY is EARNED. Section F2 measures the case that would make the inference true — a
   * behaviour change no declared check can see — and there the gate BLOCKS with NOT PROVEN.
   *
   * What survives is narrower, and it is a product gap rather than a trust hole: the everyday path
   * does not isolate the change or promote exact verified bytes. For a user editing their own
   * repository that is largely not needed, which is why the correction matters — the honest remaining
   * item is the missing candidate LIFECYCLE, not an unbounded acceptance.
   */
  check('a-direct-edit-whose-checks-discriminate-earns-its-READY', /READY/.test(naiveText),
    (naiveText.match(/^.*(READY|NOT PROVEN|NEEDS ATTENTION|UNSUPPORTED).*$/m) ?? ['(none)'])[0].trim().slice(0, 120));
  finding('the-everyday-path-does-not-isolate-or-promote (no candidate, no frozen task authority)',
    'covered for false acceptance by the discrimination gate (F2); the missing piece is the invisible lifecycle, not a verdict');

  // ────────────────────── D. `canary agents` when `.claude/` exists but NO hook is installed ──
  const noHook = path.join(temp, 'claude-no-hook');
  makeProject(noHook, 'claude-no-hook');
  fs.mkdirSync(path.join(noHook, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(noHook, '.claude', 'skills', 'demo', 'SKILL.md'), '# a skill, not a hook\n');
  const hookFile = path.join(noHook, '.claude', 'settings.json');
  const agentsR = canary(['agents'], noHook, null);
  const agentsText = out(agentsR);
  console.log('===== D. canary agents with .claude/ present but NO hook installed =====');
  console.log(agentsText.trimEnd());
  console.log('===== end agents =====\n');
  const saysGated = /CONNECTED/.test(agentsText);
  check('agents-does-not-claim-gating-without-an-installed-hook', !(saysGated && !fs.existsSync(hookFile)),
    { saidConnected: saysGated, hookInstalled: fs.existsSync(hookFile), exit: agentsR.status,
      statusCommand: out(canary(['status'], noHook, null)).split('\n').filter(Boolean)[0]?.slice(0, 90) });

  // ──────────────────────────────────────────── E. the measured vocabulary load ──
  const vocab = merge(jargonHits(setupText + work0(v1)), jargonHits(v1.fText));
  function work0(j) { return j.wText; }
  console.log('===== E. user-facing vocabulary on the ordinary path =====');
  console.log(JSON.stringify(vocab, null, 2));
  console.log(`distinct internal terms: ${Object.keys(vocab).length}   occurrences: ${Object.values(vocab).reduce((a, b) => a + b, 0)}`);
  console.log('===== end vocabulary =====\n');

  // ─────────────── F. WHAT THE COMPLETION GATE ACTUALLY DECIDES ON THE EVERYDAY PATH ──
  // The everyday path is: the agent edits the working tree with its own tools, and the Stop hook runs
  // `canary checkpoint`. Nothing here is isolated and nothing is promoted, so the only question that
  // matters is what the gate DECIDES. Measured, not inferred: the hook is invoked exactly as the
  // harness invokes it — the CLI with the hook JSON on stdin.
  const hookVerdict = (root) => {
    const r = run(process.execPath, [cli, 'checkpoint'], root, 0, JSON.stringify({ stop_hook_active: false }));
    let env = null;
    try { env = JSON.parse((r.stdout ?? '').trim()); } catch { env = null; }
    return { env, raw: r.stdout ?? '' };
  };
  /** A wired fixture whose declared check is green on the starting bytes. */
  function hookFixture(label) {
    const root = path.join(temp, label);
    makeProject(root, label);
    canary(['setup', '--yes'], root, 0);
    run('git', ['add', '.'], root);
    run('git', ['-c', 'user.name=Op', '-c', 'user.email=op@localhost', 'commit', '-m', 'wiring'], root);
    return root;
  }
  const describeVerdict = (v) => v.env === null
    ? (v.raw.trim() === '' ? 'ALLOW (silence — the documented "nothing needed" signal)' : `unparseable stdout (${JSON.stringify(v.raw.slice(0, 80))})`)
    : (v.env.decision === 'block' ? `BLOCK: ${String(v.env.reason ?? '').split('\n')[0].slice(0, 150)}`
      : `allow${v.env.systemMessage ? ` + message: ${String(v.env.systemMessage).slice(0, 150)}` : ' (silence)'}`);
  /** The hook's contract: no JSON and no output at all means ALLOW. An absent envelope is not an
   *  absent decision, so both cases are read as "not blocked" — never as "unmeasured". */
  const allowed = (v) => v.env === null ? v.raw.trim() === '' : v.env.decision !== 'block';

  // F1 — a behaviour change WITH a check the plan can discriminate: the honest ending is "allowed".
  const f1 = hookFixture('f1-discriminated');
  fs.writeFileSync(path.join(f1, 'greeting.cjs'),
    'module.exports = (name) => `Hello, ${String(name).trim()}!`;\n');
  fs.writeFileSync(path.join(f1, 'greeting.test.cjs'),
    "const assert = require('node:assert/strict');\n" +
    "const greeting = require('./greeting.cjs');\n" +
    "assert.equal(greeting('Ada'), 'Hello, Ada!');\n" +
    "assert.equal(greeting('  Ada  '), 'Hello, Ada!');\n" +
    "console.log('greeting OK');\n");
  const v1h = hookVerdict(f1);

  // F2 — a behaviour change NO declared check can see (the suite is green on both sides).
  const f2 = hookFixture('f2-undiscriminated');
  fs.appendFileSync(path.join(f2, 'greeting.cjs'),
    'module.exports.farewell = (name) => `Bye, ${name}!`;\n');
  const v2h = hookVerdict(f2);

  // F3 — a docs-only change: no behaviour moved, so no comparison duty applies.
  const f3 = hookFixture('f3-docs-only');
  fs.writeFileSync(path.join(f3, 'NOTES.md'), '# notes\n\nNothing behavioural here.\n');
  const v3h = hookVerdict(f3);

  console.log('===== F. the completion gate on the everyday path (direct edits, no candidate) =====');
  console.log(`F1 behaviour change + a discriminating check  -> ${describeVerdict(v1h)}`);
  console.log(`F2 behaviour change NO declared check can see  -> ${describeVerdict(v2h)}`);
  console.log(`F3 docs-only change (no behaviour moved)      -> ${describeVerdict(v3h)}`);
  console.log('===== end completion gate =====\n');

  check('F1-a-change-the-sealed-checks-can-discriminate-is-allowed', allowed(v1h), describeVerdict(v1h));
  // THE INVARIANT THAT MATTERS: a green suite that cannot tell the change from the base is NOT
  // evidence about the change. MEASURED: the gate BLOCKS it. This is the everyday path — the one
  // every ordinary user is on — so it is the product's most important single behaviour.
  check('F2-a-green-suite-that-cannot-discriminate-the-change-is-NOT-accepted-as-done',
    v2h.env !== null && v2h.env.decision === 'block', describeVerdict(v2h));
  check('F3-a-docs-only-change-is-not-asked-for-behavioural-evidence', allowed(v3h), describeVerdict(v3h));

  // ─────────── G. THE AGENT'S TOOLS: `setup` wires the MCP server, and nothing else moves ──
  // The point of installing it is that the agent can ASK Canary whether it is done instead of
  // authoring its own verification campaign. The risk of installing it is that it becomes a second
  // file Canary writes into a user's repository, so every property the hook already has must hold:
  // merge (never overwrite a stranger's entry), refuse rather than clobber, survive re-setup,
  // be exactly removable, and NOT turn the verifier's own file into "the change".
  const foreign = path.join(temp, 'g-mcp');
  makeProject(foreign, 'g-mcp');
  fs.writeFileSync(path.join(foreign, '.mcp.json'), JSON.stringify({
    mcpServers: { someoneelse: { command: 'node', args: ['their-server.js'] } },
  }, null, 2) + '\n');
  run('git', ['add', '.'], foreign);
  run('git', ['-c', 'user.name=Op', '-c', 'user.email=op@localhost', 'commit', '-m', 'foreign mcp'], foreign);
  canary(['setup', '--yes'], foreign, 0);

  const mcpDoc = () => JSON.parse(fs.readFileSync(path.join(foreign, '.mcp.json'), 'utf8'));
  const g1 = mcpDoc();
  console.log('===== G. the MCP entry setup wrote =====');
  console.log(JSON.stringify(g1, null, 2));
  console.log('===== end mcp =====\n');

  check('G1-setup-registers-canary-as-an-mcp-server', !!g1.mcpServers?.canary?.args?.includes('mcp'),
    JSON.stringify(g1.mcpServers?.canary ?? null));
  check('G2-a-stranger-s-entry-is-preserved-byte-for-byte',
    JSON.stringify(g1.mcpServers?.someoneelse) === JSON.stringify({ command: 'node', args: ['their-server.js'] }),
    JSON.stringify(g1.mcpServers?.someoneelse ?? null));

  // THE REGRESSION THAT WOULD BREAK EVERY USER: setup's own file must not read as "the change".
  // If `.mcp.json` were counted, the sealed checks would be green on the base too and EVERY freshly
  // wired repository would report NOT PROVEN.
  const gStatus = canary(['status'], foreign, null);
  check('G3-writing-the-mcp-entry-does-not-make-the-repo-look-changed', /CONNECTED/.test(out(gStatus)) && !/NOT CONNECTED/.test(out(gStatus)),
    out(gStatus).split('\n').filter(Boolean)[0]?.slice(0, 140));
  const gHook = hookVerdict(foreign);
  check('G4-the-completion-gate-still-allows-a-wired-repo-with-no-change', allowed(gHook), describeVerdict(gHook));

  // Re-setup is idempotent, and a foreign entry under OUR key is refused rather than replaced.
  const before = fs.readFileSync(path.join(foreign, '.mcp.json'), 'utf8');
  canary(['setup', '--yes'], foreign, 0);
  check('G5-re-running-setup-is-byte-identical', fs.readFileSync(path.join(foreign, '.mcp.json'), 'utf8') === before,
    `${before.length} bytes before and after`);

  const squatter = path.join(temp, 'g-squatter');
  makeProject(squatter, 'g-squatter');
  fs.writeFileSync(path.join(squatter, '.mcp.json'), JSON.stringify({
    mcpServers: { canary: { command: 'node', args: ['not-ours.js'] } },
  }, null, 2) + '\n');
  const squat = canary(['setup', '--yes'], squatter, null);
  const squatDoc = JSON.parse(fs.readFileSync(path.join(squatter, '.mcp.json'), 'utf8'));
  check('G6-a-foreign-server-under-our-key-is-REFUSED-not-replaced',
    squat.status === 2 && /did not write/.test(out(squat))
    && JSON.stringify(squatDoc.mcpServers.canary) === JSON.stringify({ command: 'node', args: ['not-ours.js'] }),
    { exit: squat.status, entry: squatDoc.mcpServers.canary, unchanged: true });

  // The server must actually answer a real MCP handshake, or "wired" means nothing.
  const rpc = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v13-probe', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n');
  const srv = run(process.execPath, [cli, 'mcp'], foreign, null, rpc);
  const replies = (srv.stdout ?? '').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = replies.find((r) => r.id === 1);
  const list = replies.find((r) => r.id === 2);
  const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
  check('G7-the-mcp-server-answers-a-real-handshake-and-lists-its-tools',
    !!init?.result?.serverInfo && names.length === 6, { server: init?.result?.serverInfo?.name, tools: names });
  check('G8-the-accept-power-is-not-exposed-as-a-tool',
    !names.some((n) => /accept/i.test(n)), names.join(', '));

  // Exactly removable: uninstall takes Canary's entry and leaves the stranger's.
  const un = canary(['uninstall'], foreign, null);
  const afterDoc = fs.existsSync(path.join(foreign, '.mcp.json'))
    ? JSON.parse(fs.readFileSync(path.join(foreign, '.mcp.json'), 'utf8')) : {};
  check('G9-uninstall-removes-exactly-our-entry-and-keeps-the-stranger-s',
    un.status === 0 && afterDoc.mcpServers?.canary === undefined
    && JSON.stringify(afterDoc.mcpServers?.someoneelse) === JSON.stringify({ command: 'node', args: ['their-server.js'] }),
    { exit: un.status, remaining: Object.keys(afterDoc.mcpServers ?? {}) });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} v13 journey baseline — ${results.length - failed.length}/${results.length} observations held`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  if (openFindings.length > 0) {
    console.log(`${openFindings.length} recorded open finding(s) — NOT asserted, NOT a pass:`);
    for (const f of openFindings) console.log(`  OPEN: ${f.name}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
