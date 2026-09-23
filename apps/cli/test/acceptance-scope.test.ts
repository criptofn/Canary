/** Portable canonical authorization identity and strict record readers.
 * End-to-end attacks: architecture-closure.mjs and f3-acceptance-growth.mjs. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-')); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import {
  readTaskRecord, readAcceptance, writeAcceptance,
  obligationsFor, CONFIG_DIR, TASK_FILE, ACCEPTANCE_SUBDIR,
  type AcceptanceRecord, type Obligation,
  declaredTask, subjectDigest,
} from '../src/onboarding.js';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ascope-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function makeProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // findRepoRoot needs .git presence
  // v1.4 — declare the harness in the FIXTURE. `setup` correctly refuses (exit 2) when no
  // supported harness is detected, and detection reads `<root>/.claude` or `~/.claude`. This
  // fixture relied on the operator's home directory, so it passed locally and failed on CI.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts: { test: 'node x.js' } }, null, 2));
  return root;
}
const duty = (id: string, mode: Obligation['mode'] = 'non-objective', status: Obligation['status'] = 'unproven', note = 'n'): Obligation =>
  ({ id, mode, status, note });
const scope = (task: { requirementCount: number; requirementDigests: string[] } | null, obligations: Obligation[]): string =>
  subjectDigest({ candidate: 'c', candidateCommit: 'a'.repeat(40), candidateTree: 'b'.repeat(40),
    baseHead: 'c'.repeat(40), baseTree: 'd'.repeat(40), baseAuthorityIdentity: 'e'.repeat(64),
    frozenTask: declaredTask('ui', ['ui'], []),
    liveTask: { ...declaredTask('ui', ['ui'], []), ...(task ?? {}) },
    subjectiveDuties: obligations.filter(o => o.mode === 'non-objective').map(o => o.id) });

describe('subjectDigest — canonical authorization identity', () => {
  it('changes when a duty is ADDED to the acceptance-eligible set (A2/A3/A5 shape)', () => {
    const one = scope({ requirementCount: 0, requirementDigests: [] }, [duty('ui-proof')]);
    const two = scope({ requirementCount: 0, requirementDigests: [] }, [duty('ui-proof'), duty('per-requirement')]);
    assert.notEqual(one, two, 'growth must move the digest');
    const back = scope({ requirementCount: 0, requirementDigests: [] }, [duty('ui-proof')]);
    assert.equal(one, back, 'shrinking back to the signed set restores the digest (no grudge)');
  });

  it('changes when a duty is REPLACED (dependency duty instead of per-requirement)', () => {
    const a = scope({ requirementCount: 0, requirementDigests: [] }, [duty('ui-proof'), duty('per-requirement')]);
    const b = scope({ requirementCount: 0, requirementDigests: [] }, [duty('ui-proof'), duty('dependency-change')]);
    assert.notEqual(a, b);
  });

  it('canonicalizes ORDER — presentation noise never changes identity', () => {
    const t = { requirementCount: 2, requirementDigests: [sha256('A'), sha256('B')] };
    const x = scope(t, [duty('ui-proof'), duty('per-requirement'), duty('dependency-change')]);
    const y = scope(t, [duty('dependency-change'), duty('per-requirement'), duty('ui-proof')]);
    assert.equal(x, y, 'duty order is noise; the SET is identity');
    const t2 = { requirementCount: 2, requirementDigests: [sha256('B'), sha256('A')] };
    assert.equal(scope(t, [duty('ui-proof')]), scope(t2, [duty('ui-proof')]), 'requirement-digest order is noise');
  });

  it('ignores non-semantic obligation fields (status, note wording, timestamps, evidence paths)', () => {
    const a = scope({ requirementCount: 1, requirementDigests: [sha256('A')] }, [duty('ui-proof', 'non-objective', 'unproven', 'no proof at 2026-09-10T12:00:00Z, see /tmp/x/ev')]);
    const b = scope({ requirementCount: 1, requirementDigests: [sha256('A')] }, [duty('ui-proof', 'non-objective', 'met', 'accepted yesterday, see /other/path/y')]);
    assert.equal(a, b, 'WHAT was accepted is identity; WHEN/WHERE/how-it-reads is not');
  });

  it('excludes OBJECTIVE duties from acceptance scope entirely (A6 shape)', () => {
    const base = [duty('ui-proof')];
    const withObj = [duty('ui-proof'), duty('regression-evidence', 'objective'), duty('tests-green', 'objective')];
    assert.equal(scope({ requirementCount: 0, requirementDigests: [] }, base),
      scope({ requirementCount: 0, requirementDigests: [] }, withObj),
      'an objective duty entering scope must NOT stale a signed subjective set');
  });

  it('binds requirement IDENTITY, not the count — the exact GLM pair', () => {
    const ab = { requirementCount: 2, requirementDigests: [sha256('make dialog warmer'), sha256('improve icon spacing')] };
    const cd = { requirementCount: 2, requirementDigests: [sha256('change soundtrack'), sha256('make combat prettier')] };
    const ob = [duty('ui-proof'), duty('per-requirement')];
    assert.notEqual(scope(ab, ob), scope(cd, ob), 'two requirements != the same two requirements');
    // the 0 -> 2 headline shape: empty registration vs grown registration
    const zero = { requirementCount: 0, requirementDigests: [] as string[] };
    assert.notEqual(scope(zero, ob), scope(ab, ob));
  });

  it('a one-character criterion change moves the digest (semantic, not fuzzy)', () => {
    const a = { requirementCount: 1, requirementDigests: [sha256('make the dialog warmer')] };
    const b = { requirementCount: 1, requirementDigests: [sha256('make the dialog COOLER')] };
    assert.notEqual(scope(a, [duty('per-requirement')]), scope(b, [duty('per-requirement')]));
  });

  it('null task binds as the empty scope', () => {
    assert.equal(scope(null, []), scope({ requirementCount: 0, requirementDigests: [] }, []));
  });

  it('is deterministic across calls and object identity', () => {
    const t = { requirementCount: 1, requirementDigests: [sha256('A')] };
    assert.equal(scope(t, [duty('ui-proof')]), scope({ ...t }, [{ ...duty('ui-proof') }]));
  });
});

describe('task record — requirementDigests identity, prose never stored', () => {
  it('cmdTask stores per-requirement digests (and NOT the prose)', () => {
    const root = makeProject('store');
    const fx = path.join(REPO, 'tooling', 'test-support', 'fixtures');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'store', private: true,
      scripts: { test: `node "${path.join(fx, 'f-pass.js')}"`, build: `node "${path.join(fx, 'f-build.js')}"` },
    }, null, 2));
    const git = (...args: string[]): void => {
      const g = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`);
    };
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@canary.local');
    git('config', 'user.name', 'Canary Test');
    git('add', '-A');
    git('commit', '-m', 'init');
    const s = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(s.status, 0, `setup failed: ${s.stdout}${s.stderr}`);
    const r = spawnSync(process.execPath, [CLI, 'task', 'make the dialog warmer', '--kind', 'ui',
      '--requirement', 'make dialog warmer', '--requirement', 'improve icon spacing'],
      { cwd: root, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `task registration failed: ${r.stdout}${r.stderr}`);
    const rec = readTaskRecord(root);
    assert.ok(rec);
    assert.equal(rec.requirementCount, 2);
    assert.deepEqual(rec.requirementDigests, [sha256('make dialog warmer'), sha256('improve icon spacing')].sort());
    const raw = fs.readFileSync(path.join(root, CONFIG_DIR, TASK_FILE), 'utf8');
    assert.ok(!raw.includes('improve icon spacing'), 'requirement prose must NOT be persisted — digests only');
  });

  it('legacy records fail closed to missing authority', () => {
    const root = makeProject('legacy');
    fs.mkdirSync(path.join(root, CONFIG_DIR, 'task'), { recursive: true });
    fs.writeFileSync(path.join(root, CONFIG_DIR, TASK_FILE),
      JSON.stringify({ schema: 'canary-task/1', kinds: ['ui'], requirementCount: 2 }));
    const rec = readTaskRecord(root);
    assert.equal(rec, null, 'legacy identity cannot authorize current completion');
  });

  it('junk or oversized digest lists fail closed', () => {
    const root = makeProject('junk');
    fs.mkdirSync(path.join(root, CONFIG_DIR, 'task'), { recursive: true });
    const many = Array.from({ length: 70 }, (_, i) => sha256(`r${i}`));
    fs.writeFileSync(path.join(root, CONFIG_DIR, TASK_FILE),
      JSON.stringify({ schema: 'canary-task/1', kinds: ['ui'], requirementCount: 3,
        requirementDigests: [...many, 'zz', 'Z'.repeat(64).toLowerCase().replace(/0/g, '0'), 42, 'deadbeef'] }));
    const rec = readTaskRecord(root);
    assert.equal(rec, null, 'malformed or oversized identity is refused, never filtered into authority');
  });

  it('shared derivation: obligationsFor output and the scope digest agree on acceptance-eligible ids (multi task)', () => {
    // A ui+multi registration derives ui-proof as non-objective; the digest the acceptance binds
    // MUST cover exactly those duty ids.
    const ob = obligationsFor(['ui', 'multi'], { resolved: true, hasTestDiff: true, hasUiDiff: false, hasDependencyDiff: false, hasPerfDiff: false, deletedTestsAttributable: [], deletedTestsUnattributable: [] } as never, new Set<string>(), 2, 'isolation');
    const ids = ob.filter((x) => x.mode === 'non-objective').map((x) => x.id).sort();
    assert.ok(ids.includes('ui-proof'), `ui-proof must be acceptance-eligible: ${JSON.stringify(ob)}`);
    // v1.2: per-requirement is NOT acceptance-eligible any more. It carried mode 'non-objective'
    // while its own note demanded measurement, which let a TTY signature close an unmeasured
    // requirement. A ui registration still reaches acceptance through ui-proof, so the
    // acceptance-eligible set is non-empty and this derivation guard stays meaningful.
    assert.ok(!ids.includes('per-requirement'), 'an unmeasured requirement must not be closeable by signature');
    assert.ok(ids.length > 0, 'a ui registration must still have an acceptance path');
    assert.equal(scope({ requirementCount: 2, requirementDigests: [sha256('A'), sha256('B')] }, ob),
      scope({ requirementCount: 2, requirementDigests: [sha256('A'), sha256('B')] }, ob));
  });
});

describe('readAcceptance — v2 fail-closed shapes', () => {
  const valid = (name: string): AcceptanceRecord => {
    const subject = { candidate: name, candidateCommit: 'b'.repeat(40), candidateTree: 'c'.repeat(40),
      baseHead: 'a'.repeat(40), baseTree: 'd'.repeat(40), baseAuthorityIdentity: sha256('authority'),
      frozenTask: declaredTask('ui', ['ui'], []), liveTask: declaredTask('ui', ['ui'], []), subjectiveDuties: ['ui-proof'] };
    return { schema: 'canary-acceptance/3', at: new Date().toISOString(), candidate: name, subject, subjectDigest: subjectDigest(subject), acceptedBy: 'tty-human' };
  };
  const put = (root: string, rec: unknown): void => {
    const dir = path.join(root, CONFIG_DIR, ACCEPTANCE_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${(rec as AcceptanceRecord).candidate}.json`), JSON.stringify(rec));
  };

  it('a valid v2 record round-trips with every binding present', () => {
    const root = makeProject('acc-ok');
    assert.ok(writeAcceptance(root, valid('c')));
    const rec = readAcceptance(root, 'c');
    assert.ok(rec);
    assert.equal(rec.subjectDigest, subjectDigest(rec.subject));
  });

  it('a v1 record (no scope binding) fails CLOSED — it cannot authorize anything', () => {
    const root = makeProject('acc-v1');
    put(root, { schema: 'canary-acceptance/1', at: 'x', candidate: 'c', baseHead: 'a'.repeat(40),
      candidateHead: 'b'.repeat(40), intentDigest: sha256('i'), acceptedBy: 'tty-human' });
    assert.equal(readAcceptance(root, 'c'), null);
  });

  it('v2 shape with missing/garbage acceptanceScopeDigest is unreadable', () => {
    const root = makeProject('acc-noscope');
    put(root, { ...valid('c'), subjectDigest: undefined });
    assert.equal(readAcceptance(root, 'c'), null);
    put(root, { ...valid('c'), subjectDigest: 'not-hex' });
    assert.equal(readAcceptance(root, 'c'), null);
  });

  it('agent-authored acceptedBy carries zero weight', () => {
    const root = makeProject('acc-agent');
    put(root, { ...valid('c'), acceptedBy: 'agent' });
    assert.equal(readAcceptance(root, 'c'), null);
  });

  it('a record whose candidate field disagrees with the file is unreadable (no cross-candidate borrowing)', () => {
    const root = makeProject('acc-name');
    const dir = path.join(root, CONFIG_DIR, ACCEPTANCE_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ ...valid('other') }));
    assert.equal(readAcceptance(root, 'c'), null, 'record claims candidate "other" while read as "c"');
  });
});
