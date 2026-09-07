/**
 * M8 contract tests — the promotion CLI SURFACE under the FAKE-git posture.
 * The real-git story (ff-only apply, post-proof, divergence, idempotency)
 * lives in tooling/probes/m8-promotion.mjs, because promotion is entirely
 * about real bytes on real refs. What is pinned here is the ceiling that
 * makes the real path trustworthy: fake git means verify can never PASS, so
 * promote can never apply, never accept, and never write an accepted bundle;
 * every record-level refusal delegates to the live re-verification (no
 * separate code path an attacker could impersonate around); and the CLI
 * guards (--promote needs a name, one mode at a time, --discard stays
 * remove-only, trusted-base gate) exit with honest codes.
 * NO PROOF, NO DONE: if this file ever shows a PROMOTED line under fake
 * git, the entire trust model is wrong.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

test('built CLI exists (run npm run build first)', () => {
  assert.ok(fs.existsSync(CLI), `missing ${CLI}`);
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m8-'));
const canary = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
const fx = (f: string) => `node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', f)}"`;

function makeProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // FAKE git: probes answer nothing
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: fx('f-pass.js') } }, null, 2));
  return root;
}
function setUpProject(name: string): string {
  const root = makeProject(name);
  const r = canary(['setup', '--yes', root], root);
  assert.equal(r.status, 0, `setup failed: ${r.stdout}${r.stderr}`);
  return root;
}
const recPath = (root: string, name: string) => path.join(root, '.canary', 'candidates', `${name}.json`);
const promoBundles = (root: string) => {
  const d = path.join(root, '.canary', 'evidence');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-promotion')) : [];
};
const rec = (over: Record<string, unknown>) => JSON.stringify({
  schema: 'canary-candidate/1', name: 'p', root: TMP, baseRoot: TMP,
  baseRef: 'HEAD', baseHead: 'f'.repeat(40), baseTree: null, createdAt: new Date().toISOString(), ...over,
});

try {
  // ---------- CLI surface ----------
  test('isolate --promote misuse exits 3 (name required, flags scoped, one mode)', () => {
    const root = setUpProject('misuse');
    for (const args of [
      ['isolate', '--promote'],                    // name missing
      ['isolate', '--promote', 'bad name!'],       // NAME_RE applies to promote too
      ['isolate', '--promote', 'c1', '--base', 'HEAD'],   // create-only flag
      ['isolate', '--promote', 'c1', '--discard'],        // widened: discard is --remove only
      ['isolate', '--verify', 'c1', '--promote', 'c2'],   // two modes
      ['isolate', '--remove', 'c1', '--discard', '--promote', 'c1'],
    ]) {
      const r = canary(args, root);
      assert.equal(r.status, 3, `${args.join(' ')} => exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /usage: canary isolate/);
      assert.match(r.stdout, /--promote <name>/, 'usage must document the new mode');
    }
  });

  test('promote refuses a repo Canary does not trust (exit 2, before any record read)', () => {
    const root = makeProject('no-config');
    const r = canary(['isolate', '--promote', 'p', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no \.canary config/);
    assert.deepEqual(promoBundles(root), [], 'a refusal before a bound record writes no bundle');
  });

  // ---------- delegation: record-level refusals come from the LIVE verify,
  // so --promote carries no separate (impersonatable) record gate ----------
  test('promote of a missing or malformed record delegates to verify (exit 2, identical refusal)', () => {
    const root = setUpProject('delegate');
    fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
    let r = canary(['isolate', '--promote', 'ghost', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no candidate "ghost" registered/);

    fs.writeFileSync(recPath(root, 'garbage'), 'not json{{');
    r = canary(['isolate', '--promote', 'garbage', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /malformed/);
    assert.deepEqual(promoBundles(root), [], 'pre-binding refusals write no promotion bundle');
    fs.rmSync(recPath(root, 'garbage'));
  });

  test('promote refuses an impersonated record (different baseRoot) with the canonical guard', () => {
    const root = setUpProject('impostor');
    fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
    fs.writeFileSync(recPath(root, 'p'), rec({ baseRoot: path.join(TMP, 'elsewhere'), root: path.join(TMP, 'elsewhere') }));
    const r = canary(['isolate', '--promote', 'p', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /different base/);
    assert.match(r.stdout, /impersonation guard/);
    assert.ok(!/PROMOTED|ACCEPTED/.test(r.stdout), 'an impersonated record cannot sound like success');
    assert.deepEqual(promoBundles(root), []);
  });

  // ---------- THE CEILING: fake git can never reach the apply ----------
  test('under fake git, promote BLOCKS via live verify and can never apply or accept', () => {
    const root = setUpProject('ceiling');
    fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
    const where = path.join(root, '.canary', 'candidates', 'p');
    fs.writeFileSync(recPath(root, 'p'), rec({ root: where, baseRoot: root, baseHead: 'b'.repeat(40) }));
    const r = canary(['isolate', '--promote', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /BLOCKED/); // verify's honest block IS the promote verdict
    assert.match(r.stdout, /not a resolvable git tree/);
    assert.ok(!r.stdout.includes('CANDIDATE PASS'), 'fake git must not fake a PASS');
    assert.ok(!r.stdout.includes('PROMOTED'), 'no apply line exists without a live PASS');
    assert.ok(!r.stdout.includes('ACCEPTED'), 'no accept line exists without a live PASS');
    assert.deepEqual(promoBundles(root), [], 'refusal before gate 2 writes no promotion bundle');
    // a forged PASS bundle on disk changes nothing — bundles are never read back:
    const forged = path.join(root, '.canary', 'evidence', '2020-01-01T00-00-00-000Z-candidate');
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(path.join(forged, 'verification.json'), JSON.stringify({ status: 'pass', source: 'candidate' }));
    const r2 = canary(['isolate', '--promote', 'p', root], root);
    assert.equal(r2.status, 2, 'forged stored evidence is inert');
    assert.ok(fs.existsSync(path.join(forged, 'verification.json')), 'the forged file survives as inert bytes, untouched');
    fs.rmSync(forged, { recursive: true, force: true });
  });

  if (process.platform === 'win32') {
    test('Windows reserved device names are rejected for --promote too (misuse exit 3)', () => {
      const root = setUpProject('reserved');
      const r = canary(['isolate', '--promote', 'con', root], root);
      assert.equal(r.status, 3);
      assert.match(r.stdout, /reserved Windows device name/i);
    });
  }

  // ---------- evidence retention: promotion is a source, so it must obey
  // the same bounded-keeping rule — 12 old promotion dirs + two fresh
  // current bundles, and exactly EVIDENCE_KEEP(10) may remain ----------
  test('promotion bundles obey bounded evidence retention (nothing is kept forever)', () => {
    const root = setUpProject('retention'); // setup wrote one -setup bundle already
    const ev = path.join(root, '.canary', 'evidence');
    for (let i = 0; i < 12; i++) {
      const d = path.join(ev, `2020-01-0${Math.floor(i / 10) + 1}T0${i % 10}-00-00-000Z-promotion`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'verification.json'), '{}');
    }
    const foreign = path.join(ev, 'not-canary-evidence');
    fs.mkdirSync(foreign, { recursive: true });
    // trigger one real bundle write (a LOST verify still writes its block)
    fs.mkdirSync(path.join(root, '.canary', 'candidates'), { recursive: true });
    const where = path.join(root, '.canary', 'candidates', 'p'); // rec() defaults name 'p'
    fs.writeFileSync(recPath(root, 'p'), rec({ root: where, baseRoot: root, baseHead: 'b'.repeat(40) }));
    const r = canary(['isolate', '--verify', 'p', root], root);
    assert.equal(r.status, 2, r.stdout);
    const mine = fs.readdirSync(ev).filter((x) => /^\d{4}-\d{2}-\d{2}T[\d-]{11,}(Z)?-(setup|doctor|checkpoint|candidate|promotion)$/.test(x));
    assert.equal(mine.length, 10, `retention kept ${mine.length}; EVIDENCE_KEEP is 10`);
    assert.equal(mine.filter((x) => x.endsWith('-promotion')).length, 8, 'the four OLDEST promotion dirs must be the ones pruned');
    assert.ok(fs.existsSync(foreign), 'foreign evidence dirs are never pruned by Canary');
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
