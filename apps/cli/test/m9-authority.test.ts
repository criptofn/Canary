/**
 * M9 contract tests — the authority guard's CONTAINMENT PRE-GATE and its
 * gate ordering under the fake-git posture. The in-window fingerprint
 * sandwich needs real execution (fake git never reaches it), so it is proven
 * by tooling/probes/m9-authority.mjs on real git. What lives here is what
 * fake git CAN reach: a harness hook entry that setup promised must still be
 * present BEFORE anything runs — its absence is the mandate-verdict (exit 2, the
 * three mandated lines, a blocked bundle carrying authorityEvent) — and the
 * gate-order pins: ghost/malformed/impostor record refusals still precede the
 * pre-gate, and an intact harness keeps the pre-gate silent (a LOST-style
 * block with NO §9 line: the guard must not shout about authority when the
 * candidate itself is unresolvable). Plus the §9.5 quarantine posture: the
 * marker refusal out-ranks every gate and judges nothing, a human setup
 * re-seal is the only clearing act, and the pre-gate stays grudgeless.
 * NO PROOF, NO DONE.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one
import { snapshotTree, treeDrift } from '../src/authority.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m9-'));
const canary = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
const fx = (f: string) => `node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', f)}"`;

function setUpProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // FAKE git
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: fx('f-pass.js') } }, null, 2));
  const r = canary(['setup', '--yes', root], root);
  assert.equal(r.status, 0, `setup failed: ${r.stdout}${r.stderr}`);
  return root;
}
const recPath = (root: string, name: string) => path.join(root, '.canary', 'candidates', `${name}.json`);
const settingsOf = (root: string) => path.join(root, '.claude', 'settings.json');
function registerLost(root: string): string {
  // a valid-shape record whose root cannot resolve under fake git: verify
  // sails past every pre-execution gate up to (but not including) identity.
  fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
  const where = path.join(root, '.canary', 'candidates', 'p');
  fs.writeFileSync(recPath(root, 'p'), JSON.stringify({
    schema: 'canary-candidate/1', name: 'p', root: where, baseRoot: root,
    baseRef: 'HEAD', baseHead: 'b'.repeat(40), baseTree: null, createdAt: new Date().toISOString(),
  }));
  return where;
}
const mandateRe = /CANARY BLOCKED COMPLETION — Verification authority was modified by the candidate\./;
const candBundles = (root: string) => {
  const d = path.join(root, '.canary', 'evidence');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => x.endsWith('-candidate')).sort()
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')) as Record<string, unknown>);
};

try {
  test('intact harness entry keeps the pre-gate SILENT: LOST-style block, zero §9 lines', () => {
    const root = setUpProject('silent');
    registerLost(root);
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /not a resolvable git tree/, 'the ordinary identity block decides');
    assert.ok(!mandateRe.test(r.stdout), 'no mandate-verdict when the harness bytes are intact');
    assert.ok(!/modified by the candidate/.test(r.stdout), 'no §9 wording leak');
    const b = candBundles(root).at(-1)!;
    assert.equal(b.status, 'blocked', 'the LOST block is still evidenced');
    assert.equal(b.authorityEvent, undefined, 'a non-authority block carries no authorityEvent');
  });

  test('harness entry deleted outside the window → §9 before execution (containment pre-gate)', () => {
    const root = setUpProject('dropped');
    registerLost(root);
    fs.rmSync(settingsOf(root));
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, mandateRe, 'mandated first line');
    assert.match(r.stdout, /Do not allow candidate-modified Canary to judge its own mutation\./, 'mandated third line');
    assert.match(r.stdout, /before execution/, 'the pre-gate names when');
    assert.match(r.stdout, /unreadable/, 'deleted settings reads as unreadable, never as absent-and-fine');
    const b = candBundles(root).at(-1)!;
    assert.equal(b.status, 'blocked', 'the mandate-verdict is evidenced as blocked');
    assert.deepEqual(b.steps, [], 'a before-execution block runs zero steps');
    const ev = b.authorityEvent as { when: string; changes: Array<{ file: string; before: string; after: string }> };
    assert.equal(ev.when, 'before execution');
    assert.equal(ev.changes.length, 1, 'exactly the settings file is named');
    const ch = ev.changes[0]!;
    assert.equal(ch.file, settingsOf(root), 'the change names the settings path');
    assert.equal(ch.before, 'hook entry promised by setup', 'the promise is recorded as the prior state');
    assert.equal(ch.after, 'unreadable', 'missing bytes are honest about being missing');
    assert.equal(b.source, 'candidate', 'the bundle stays a candidate-source bundle');
    assert.equal(b.trustClass, 'CANARY_OBSERVED', 'M3 class preserved by the M9 path');
  });

  test('harness entry scrubbed (valid JSON, entry gone) → §9 with after "entry missing"', () => {
    const root = setUpProject('scrubbed');
    registerLost(root);
    fs.writeFileSync(settingsOf(root), '{"hooks": {}}\n');
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, mandateRe);
    assert.match(r.stdout, /entry missing/);
    assert.ok(!/unreadable/.test(r.stdout), 'a parseable file must not lie about being unreadable');
  });

  test('gate order: record refusals (ghost / malformed / impostor) precede the pre-gate even with settings deleted', () => {
    const root = setUpProject('order');
    fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
    fs.rmSync(settingsOf(root));
    let r = canary(['isolate', '--verify', 'ghost', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no candidate "ghost" registered/, 'the registry gate answers first');
    assert.ok(!mandateRe.test(r.stdout), 'an unregistered name gets no authority verdict');

    fs.writeFileSync(recPath(root, 'garbage'), 'not json{{');
    r = canary(['isolate', '--verify', 'garbage', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /malformed/);
    assert.ok(!mandateRe.test(r.stdout), 'a garbage record is not an authority event');

    fs.writeFileSync(recPath(root, 'p'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'p', root: path.join(TMP, 'elsewhere'),
      baseRoot: path.join(TMP, 'elsewhere'), baseRef: 'HEAD', baseHead: 'f'.repeat(40),
      baseTree: null, createdAt: new Date().toISOString(),
    }));
    r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /different base/, 'the impersonation guard still answers before any §9');
    assert.ok(!mandateRe.test(r.stdout), 'a record pointed at another base is refused, not attributed');
  });

  test('evidence tree is in the fingerprint set: plant / edit / wipe all drift, untouched tree stays quiet', () => {
    // unit level for the §9 evidence-storage edge: the real-CLI paths over a
    // planted forged PASS bundle are proven by the m9-authority probe; here
    // we pin the tree-snapshot semantics the mandate depends on.
    const ev = path.join(TMP, 'evidence-tree');
    fs.mkdirSync(path.join(ev, 'b1'), { recursive: true });
    fs.writeFileSync(path.join(ev, 'b1', 'verification.json'), '{"status":"pass","trustClass":"CANARY_OBSERVED"}');
    const pre = snapshotTree(ev);
    assert.equal(treeDrift(pre, ev).length, 0, 'untouched tree: zero drift');
    // plant: a forged bundle dir appears
    fs.mkdirSync(path.join(ev, 'forged'), { recursive: true });
    fs.writeFileSync(path.join(ev, 'forged', 'verification.json'), '{"status":"pass"}');
    let d = treeDrift(pre, ev);
    assert.equal(d.length, 1, 'plant: exactly one new file');
    assert.equal(d[0]!.file, 'forged/verification.json');
    assert.equal(d[0]!.before, 'ABSENT');
    assert.match(d[0]!.after, /^sha256:/);
    fs.rmSync(path.join(ev, 'forged'), { recursive: true, force: true });
    // edit: bytes change in place
    fs.writeFileSync(path.join(ev, 'b1', 'verification.json'), '{"status":"pass","trustClass":"CANARY_OBSERVED","m9":"tampered"}');
    d = treeDrift(pre, ev);
    assert.equal(d.length, 1, 'edit: exactly one changed file');
    assert.match(d[0]!.before, /^sha256:/);
    assert.match(d[0]!.after, /^sha256:/);
    assert.notEqual(d[0]!.before, d[0]!.after, 'edit changes the state token');
    fs.writeFileSync(path.join(ev, 'b1', 'verification.json'), '{"status":"pass","trustClass":"CANARY_OBSERVED"}');
    // wipe: whole dir gone — every file reports ABSENT, fail-closed
    fs.rmSync(ev, { recursive: true, force: true });
    d = treeDrift(pre, ev);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.after, 'ABSENT', 'a vanished evidence dir is drift, never silence');
  });

  test('§9.5 quarantine refusal out-ranks EVERY gate — even record refusals — and writes no bundle', () => {
    const root = setUpProject('refuse');
    const q = path.join(root, '.canary', 'authority-quarantine.json');
    fs.writeFileSync(q, JSON.stringify({ schema: 'canary-authority-quarantine/1', at: '2026-09-08T00:00:00.000Z', when: 'during execution', changes: [{ file: 'x', before: 'a', after: 'b' }] }));
    // an UNREGISTERED name would ordinarily hit the registry gate first; the
    // marker proves the refusal is at the absolute top: verify refuses to
    // judge at all, so it writes no bundle (the marker is the evidence).
    const r = canary(['isolate', '--verify', 'ghost', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /CANARY QUARANTINED/, 'the quarantine refusal answers');
    assert.ok(!/no candidate "ghost" registered/.test(r.stdout), 'the refusal precedes even the registry gate');
    assert.ok(!mandateRe.test(r.stdout), 'a refusal is not a fresh mandate — nothing was judged');
    assert.equal(candBundles(root).length, 0, 'refusal-before-judging writes zero bundles');
    // an unreadable marker still refuses — fail-closed: garbage bytes stand as a marker
    fs.writeFileSync(q, 'not json{{');
    const r2 = canary(['isolate', '--verify', 'ghost', root], root);
    assert.equal(r2.status, 2, r2.stdout);
    assert.match(r2.stdout, /fail-closed/, 'a marker Canary cannot parse still quarantines');
    assert.equal(candBundles(root).length, 0, 'still zero bundles — nothing was judged');
  });

  test('a human re-seal (setup) is the clearing act — the marker vanishes with the deliberate restore', () => {
    const root = setUpProject('clears');
    const q = path.join(root, '.canary', 'authority-quarantine.json');
    fs.writeFileSync(q, JSON.stringify({ schema: 'canary-authority-quarantine/1', at: '2026-09-08T00:00:00.000Z', when: 'after execution', changes: [] }));
    assert.match(canary(['isolate', '--verify', 'ghost', root], root).stdout, /CANARY QUARANTINED/);
    const s = canary(['setup', '--yes', root], root);
    assert.equal(s.status, 0, `setup failed: ${s.stdout}${s.stderr}`);
    assert.ok(!fs.existsSync(q), 'writeConfig landing IS the clearing act');
    const r = canary(['isolate', '--verify', 'ghost', root], root);
    assert.match(r.stdout, /no candidate "ghost" registered/, 'verify judges again — back to ordinary gates');
    assert.ok(!/QUARANTIN/.test(r.stdout), 'no stale quarantine memory after a human re-seal');
  });

  test('the containment pre-gate stays grudgeless: a before-execution mandate stamps NO marker, and restoring bytes recovers cleanly', () => {
    const root = setUpProject('grudgeless');
    registerLost(root);
    const settings = settingsOf(root);
    const bytes = fs.readFileSync(settings); // the setup-promised bytes we will restore
    fs.rmSync(settings);
    const r1 = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r1.status, 2, r1.stdout);
    assert.match(r1.stdout, mandateRe);
    assert.ok(!fs.existsSync(path.join(root, '.canary', 'authority-quarantine.json')),
      'pre-gate mandates do not quarantine — the restore path is writing the promised bytes back, not a re-seal ritual');
    fs.writeFileSync(settings, bytes);
    const r2 = canary(['isolate', '--verify', 'p', root], root);
    assert.ok(!/QUARANTIN/.test(r2.stdout), 'honest recovery after a grudgeless block stays unquarantined');
    assert.match(r2.stdout, /not a resolvable git tree/, 'verify sails to the ordinary identity block');
  });

  test('a config that promised nothing runs no containment gate (hand-written touched: [])', () => {
    const root = setUpProject('unpromised');
    registerLost(root);
    const cfgP = path.join(root, '.canary', 'canary.local.json');
    const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
    cfg.touched = []; // claims no harness promise — nothing was promised, nothing is checked
    fs.writeFileSync(cfgP, JSON.stringify(cfg));
    fs.rmSync(settingsOf(root));
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.ok(!mandateRe.test(r.stdout), 'no promise ⇒ no §9 — the settings bytes stay fingerprinted in-window regardless');
    assert.match(r.stdout, /not a resolvable git tree/, 'verify proceeds to the honest identity block');
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
