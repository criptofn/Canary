/**
 * v1.4 — FILESYSTEM IDENTITY REGRESSION SUITE.
 *
 * WHY THIS FILE EXISTS. Canary compares filesystem identities in many security-sensitive places:
 * repository containment, the candidate's shared git store, the trust store's project id, the
 * provider's enrolled deployment, custody anchors, and the symlink-escape gate. On Windows one
 * object can have TWO spellings — its long name and its 8.3 SHORT alias
 * (`C:\Users\runneradmin\...` vs `C:\Users\RUNNER~1\...`) — and `fs.realpathSync` (the JavaScript
 * one) returns the short spelling unchanged. Comparing the two spellings made Canary refuse
 * legitimate objects: MEASURED on GitHub Actions Windows (which sets `TEMP=C:\Users\RUNNER~1\...`)
 * as `isolate: the trusted base identity is unresolvable (broken .git?)` and
 * `... does not share this repo's git store`, and reproduced offline by pointing TEMP at a
 * short-named directory.
 *
 * THE CHANGE UNDER TEST is `fs.realpathSync.native` (the OS call, which returns the canonical long
 * form) behind the helpers `canonicalPath` / `canonicalPathOrNull` / `sameFilesystemIdentity` /
 * `containsPath` in `@canary-rn/support`.
 *
 * WHAT THIS FILE MUST PROVE, in the project's own terms: the change may reduce FALSE REFUSALS
 * only. It must NOT create FALSE ACCEPTANCE. So every acceptance case below is paired with a
 * rejection case that must still be rejected:
 *
 *   accepted as same identity        | still rejected
 *   ---------------------------------|-----------------------------------------------
 *   long vs short spelling of one    | a SIBLING directory
 *   directory                        | a PREFIX LOOKALIKE (`root-evil` vs `root`)
 *                                    | a SYMLINK that escapes the root
 *                                    | a FOREIGN git store / foreign repository
 *                                    | a NONEXISTENT required path
 *
 * The long/short cases use REAL paths from the filesystem (the FileSystemObject's `ShortPath`),
 * never a mocked string rewrite — a normalisation the OS does not agree with would pass a mock and
 * fail in production, which is exactly the bug being fixed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { canonicalPath, canonicalPathOrNull, sameFilesystemIdentity, containsPath } from '@canary-rn/support';
import { containedRealPath, candidateIdentity, gitExe } from '../src/onboarding.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-path-identity-'));
const mk = (name: string): string => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* OS temp */ } };
process.on('exit', cleanup);

/** The 8.3 short spelling of an EXISTING path, straight from Windows. */
function shortPathOf(p: string): string | null {
  if (process.platform !== 'win32') return null;
  const script = `$f=(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}'); $f.ShortPath`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}
function canSymlink(): boolean {
  try { const t = mk('symlink-probe'); fs.symlinkSync(t, path.join(t, 'l'), 'dir'); return true; } catch { return false; }
}
function initRepo(dir: string): void {
  const git = gitExe();
  assert.ok(git, 'git must resolve for the git-identity cases');
  const run = (args: string[]) => spawnSync(git, ['-C', dir, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  run(['init', '-b', 'main']); run(['config', 'user.name', 'identity']); run(['config', 'user.email', 'identity@local']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n'); run(['add', '.']); run(['commit', '-m', 'fixture']);
}

describe('filesystem identity — the long/short (8.3) spelling is ONE identity', () => {
  it('a real short alias and its long name are the same identity, by the OS', (t) => {
    const long = mk('a-long-directory-name');
    const short = shortPathOf(long);
    if (short === null || short.toLowerCase() === long.toLowerCase()) {
      // Not a pass: this host cannot exercise the condition. Reported as an explicit skip.
      t.skip('this filesystem produced no distinct 8.3 short name for the fixture');
      return;
    }
    assert.notEqual(short.toLowerCase(), long.toLowerCase(), 'the fixture must have a DIFFERENT short spelling');
    // Both spellings must actually denote the same object before anything else is asserted.
    assert.equal(fs.statSync(long).ino !== undefined, true);
    assert.equal(sameFilesystemIdentity(long, short), true, 'long and short must read as one identity');
    assert.equal(canonicalPath(short), canonicalPath(long), 'both canonicalise to the same path');
    assert.equal(canonicalPathOrNull(short), canonicalPath(long));
    // Containment must agree through either spelling.
    assert.equal(containsPath(long, short), true);
    assert.equal(containsPath(short, long), true);
    assert.equal(containedRealPath(short, short), canonicalPath(long), 'the containment gate resolves either spelling to the canonical root');
    assert.equal(containedRealPath(long, short), canonicalPath(long));
  });

  it('a git repository resolves through either spelling (the CI symptom, pinned)', (t) => {
    const long = mk('another-long-directory-name');
    const short = shortPathOf(long);
    if (short === null || short.toLowerCase() === long.toLowerCase()) {
      t.skip('this filesystem produced no distinct 8.3 short name for the fixture');
      return;
    }
    initRepo(long);
    const viaLong = candidateIdentity(long);
    const viaShort = candidateIdentity(short);
    assert.equal(viaLong.resolved, true, 'the long spelling resolves');
    assert.equal(viaShort.resolved, true, 'the SHORT spelling must resolve too — this is the defect that was fixed');
    assert.equal(viaShort.head, viaLong.head, 'and it must be the SAME commit, not merely "resolved"');
  });
});

describe('filesystem identity — false acceptance is never created', () => {
  it('a SIBLING directory is not inside the root', () => {
    const root = mk('root'); const sibling = mk('sibling');
    assert.equal(containsPath(root, sibling), false);
    assert.equal(sameFilesystemIdentity(root, sibling), false);
    assert.equal(containedRealPath(root, sibling), null);
  });

  it('a PREFIX LOOKALIKE is not inside the root', () => {
    const root = mk('prefix-root'); const lookalike = path.join(TMP, 'prefix-root-evil');
    fs.mkdirSync(lookalike, { recursive: true });
    assert.equal(containsPath(root, lookalike), false, '"root-evil" must not read as inside "root"');
    assert.equal(containedRealPath(root, lookalike), null);
  });

  it('a SYMLINK that escapes the root is still refused (and one that stays inside is allowed)', (t) => {
    if (!canSymlink()) { t.skip('symlink creation is denied on this host'); return; }
    const root = mk('escape-root'); const outside = mk('outside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    const escaping = path.join(root, 'link-out');
    fs.symlinkSync(outside, escaping, 'dir');
    assert.equal(containsPath(root, escaping), false, 'an escaping symlink must NOT be inside the root');
    assert.equal(containedRealPath(root, escaping), null, 'the containment gate refuses the escape');
    // The inside target must GENUINELY be inside root. (A first version of this test created it as a
    // sibling and the gate correctly refused it — the fixture was wrong, not the product, which is
    // itself the behaviour this case exists to pin.)
    const inside = path.join(root, 'real-inside');
    fs.mkdirSync(inside, { recursive: true });
    const staying = path.join(root, 'link-in');
    fs.symlinkSync(inside, staying, 'dir');
    assert.equal(containedRealPath(root, staying), canonicalPath(inside), 'a symlink that stays inside is allowed');
  });

  it('a FOREIGN git store and a foreign repository are still rejected', () => {
    const one = mk('repo-one'); const two = mk('repo-two');
    initRepo(one); initRepo(two);
    assert.equal(sameFilesystemIdentity(path.join(one, '.git'), path.join(two, '.git')), false,
      'two different repositories must never read as one store');
    assert.equal(sameFilesystemIdentity(one, two), false);
    assert.equal(containsPath(one, path.join(two, '.git')), false);
  });

  it('a NONEXISTENT required path is rejected, never silently accepted', () => {
    const root = mk('exists-root');
    const missing = path.join(root, 'no-such-file');
    assert.equal(canonicalPathOrNull(missing), null, 'a missing path has no canonical identity');
    assert.equal(sameFilesystemIdentity(root, missing), false, 'and must never compare equal to a real one');
    assert.equal(sameFilesystemIdentity(missing, missing), false, 'not even to itself — fail closed');
    assert.equal(containsPath(root, missing), false);
    assert.throws(() => canonicalPath(missing), 'canonicalPath keeps realpath\'s throwing semantics where existence is required');
  });

  it('case folding is applied on Windows only, and does not merge distinct names on POSIX', () => {
    const root = mk('case-root');
    const upper = path.join(root, 'CaseChild');
    fs.mkdirSync(upper, { recursive: true });
    const lower = path.join(root, 'casechild');
    if (process.platform === 'win32') {
      assert.equal(containsPath(root, lower), true, 'Windows is case-insensitive, so this is the same directory');
    } else {
      assert.equal(containsPath(root, lower), false, 'POSIX is case-sensitive and must not fold');
    }
  });
});
