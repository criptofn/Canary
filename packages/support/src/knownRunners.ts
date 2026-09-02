/**
 * KNOWN_RUNNER_RELEASES — Canary's pin table for runner packages whose bytes
 * we trust enough to inject our lifecycle observer into (post-GLM panel AM-1).
 *
 * WHY A PIN TABLE AND NOT "just read the version": the injection trigger and
 * the expected runner version were both, before this, consumed from
 * FIXTURE/node_modules/<pkg>/package.json — a SUBJECT-CONTROLLED file. A
 * downstream repo can ship (or prepare-create) a mocha-API double whose
 * package.json says whatever npm would resolve, so every version-derived
 * check matched BY CONSTRUCTION and Canary's own observer certified zero real
 * tests. Binding trust to (name, version, canonical tree hash) that live in
 * THIS repo moves the decision to Canary-derived data: unpinned bytes ⇒ no
 * injection ⇒ observation ABSENT ⇒ strong labels structurally unreachable.
 *
 * TRUST POSTURE (docs/EXECUTION-AUTHORITY.md keeps the long form): this is TOFU by
 * code review, not signature verification — no cryptographic trust root
 * exists, and this file does not pretend otherwise. The hash proves the bytes
 * ARE THE BYTES WE REVIEWED; who those bytes came from is registry trust we
 * state honestly.
 *
 * Adding support for a new runner version = one entry AND its review
 * manifest: download the exact tarball from the pinned registry, verify it
 * against the registry's declared dist.integrity, generate a per-file
 * manifest (same walk rules as treeSha256) under
 * packages/support/test/fixtures/runner-manifests/, and pin the hash that
 * manifest recomputes to. known-runners-manifest.test.ts fails offline if
 * table and reviewed bytes diverge — a one-off "paste what the probe
 * printed" without a committed manifest is how a stale hash once shipped
 * (2f4a706 recorded 68a0a02c… for mocha@10.8.2, which matches no install;
 * the golden proof correctly degraded to INCONCLUSIVE, never a false PASS).
 * The live golden proof end-to-end-checks the pin against what the fixture
 * actually resolves.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface KnownRunnerRelease {
  /** Exact package version string the pin applies to. */
  version: string;
  /** Canonical content hash of the installed package directory (treeSha256). */
  treeSha256: string;
  /** Where the bytes came from; 'canary-double' exists ONLY for offline tests. */
  origin: 'npm' | 'canary-double';
  note: string;
}

export const KNOWN_RUNNER_RELEASES: Readonly<Record<string, readonly KnownRunnerRelease[]>> = {
  mocha: [
    {
      version: '10.8.2',
      treeSha256: '4b811f5a8bc5848bbef919adb49d8bfc10d6774e98215acd2e78713ae34cdb58',
      origin: 'npm',
      note: 'golden fixture (ctimmerm/axios-mock-adapter b88044…) runner; review manifest ' +
        'runner-manifests/mocha-10.8.2.npm.txt (official tarball, registry sha512 verified); ' +
        'golden-era tree and a clean npm install hash identically',
    },
    {
      version: '0.0.0-canary-double',
      // Canary-authored mocha-API double in apps/cli/test/fixtures/mocha-double
      // (offline e2e only — origin 'canary-double' exists ONLY so tests can
      // exercise the injection mechanism without a network install). A unit
      // test pins table==disk: editing the double without re-pinning fails.
      treeSha256: '12e47c3604c2e808a2112ff806cdfdcf68b1c80cb7f88fd11f8ba974440e7e9f',
      origin: 'canary-double',
      note: 'offline-test double; .gitattributes forces eol=lf so checkout bytes == hash bytes',
    },
  ],
};

/**
 * Canonical content hash of an installed package directory, per panel memo J:
 * every REGULAR file (forward-slash relative paths, sorted), digest =
 * sha256 over concat of `path + "\0" + sha256(fileBytes) + "\n"`. Excludes:
 * `<pkg>/node_modules/**`, `.package-lock.json` entries npm may inject.
 * Symlinks or unreadable entries THROW — callers treat a throw exactly like
 * a pin miss (no injection). mtimes/permissions are deliberately out: the
 * claim depends on CONTENT only. npm preserves tarball bytes, so real
 * installs are host-stable (the proof-host test asserts this end-to-end).
 */
export function treeSha256(root: string): string {
  const files: Array<[string, string]> = [];
  walkInto(root, '', files);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [rel, digest] of files) h.update(rel + '\0' + digest + '\n');
  return h.digest('hex');
}

function walkInto(dir: string, rel: string, out: Array<[string, string]>): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!rel && (e.name === '.package-lock.json')) continue;
    const full = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (r === 'node_modules') continue; // npm-injected nested tree: not the runner's bytes
      walkInto(full, r, out);
    } else if (e.isSymbolicLink()) {
      throw new Error('symlink in package tree: ' + r);
    } else if (e.isFile()) {
      out.push([r, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    } else {
      throw new Error('non-regular file in package tree: ' + r);
    }
  }
}

/** A runner package Canary LOCATED and HASHED (pin status not yet checked). */
export interface LocatedRunnerPackage {
  dir: string;
  name: string;
  /** package.json version as READ (subject-side string — used only to probe
   *  the pin table; it may not anchor any claim unless a pin confirms it). */
  version: string;
  treeSha256: string;
}

/**
 * Find the owning package directory of a resolved `$bin:` script (nearest
 * ancestor package.json, within 4 levels), require name == expectedName, and
 * hash the directory. Null (never throws) on ANY doubt. Deliberately does NOT
 * consult the pin table: callers need the observed hash even when the pin
 * MISSES (the bundle records `observedRunnerTreeSha256` on the ABSENT path —
 * "what bytes were there" is Canary-derived regardless of trust).
 */
export function locateRunnerPackage(binAbsPath: string, expectedName: string): LocatedRunnerPackage | null {
  try {
    let dir = path.dirname(path.resolve(binAbsPath));
    const top = path.parse(dir).root;
    let pkg: { name?: unknown; version?: unknown } | undefined;
    for (let depth = 0; depth < 4 && dir !== top; depth++) {
      const pjPath = path.join(dir, 'package.json');
      if (fs.existsSync(pjPath)) {
        pkg = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
        break;
      }
      dir = path.dirname(dir);
    }
    if (!pkg || pkg.name !== expectedName || typeof pkg.version !== 'string') return null;
    return { dir: path.resolve(dir), name: expectedName, version: pkg.version, treeSha256: treeSha256(dir) };
  } catch {
    return null; // fail-closed: any anomaly == not injectable
  }
}

/** Look up a located package in the pin table: BOTH version and hash must
 *  match one entry (AM-1 — a version string alone never earns trust).
 *
 *  post-GLM F5 — ORIGIN IS AN EXECUTION-AUTHORITY BOUNDARY, not metadata.
 *  The 'canary-double' pin's bytes are PUBLIC in this repo and its
 *  observation seams are exactly what an attacker knows best, so a
 *  (version, treeSha256) match alone let an untrusted spec stage those
 *  bytes at the canonical anchor in its own prepare step and earn observer
 *  injection through a runner it fully controls. Selecting a canary-double
 *  pin therefore requires the explicit ctx.allowCanaryDoubleOrigin grant —
 *  the in-process test-authority channel (ExecutorDeps/PipelineDeps, the
 *  same channel as fetch/extract), which the production CLI never passes.
 *  npm-origin pins are selectable in BOTH postures; the golden proof path
 *  is unaffected. A refused double records the same absentKind
 *  'runner-identity-unpinned': "pinned but not an execution authority" is
 *  the same natural-argv path, and observedRunnerTreeSha256 is still
 *  recorded (bytes-observed is trust-independent). */
export function findRunnerPin(
  located: LocatedRunnerPackage,
  ctx: { allowCanaryDoubleOrigin?: boolean } = {},
): KnownRunnerRelease | null {
  const pin = (KNOWN_RUNNER_RELEASES[located.name] ?? []).find(
    (p) => p.version === located.version && p.treeSha256 === located.treeSha256
      && (p.origin !== 'canary-double' || ctx.allowCanaryDoubleOrigin === true),
  );
  return pin ?? null;
}

export interface PinnedRunner {
  dir: string;
  name: string;
  version: string;
  treeSha256: string;
  origin: 'npm' | 'canary-double';
}

/**
 * Given the absolute path of a bin script resolved for a supported-runner
 * `$bin:` token: locate + hash the package and match it against the pin
 * table. Returns null (never throws) for ANY doubt — wrong/missing name,
 * unreadable tree, unpinned version, hash miss. The returned `version` is
 * the ONLY authoritative expected runner version Canary may trust: the
 * subject's package.json string was used solely to LOCATE this entry.
 */
export function hashPinnedRunner(binAbsPath: string, expectedName: string): PinnedRunner | null {
  const located = locateRunnerPackage(binAbsPath, expectedName);
  if (!located) return null;
  const pin = findRunnerPin(located);
  if (!pin) return null;
  return { dir: located.dir, name: located.name, version: pin.version, treeSha256: located.treeSha256, origin: pin.origin };
}
