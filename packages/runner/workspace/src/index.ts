/**
 * Workspace lifecycle — the enforcement point of docs/SECURITY.md.
 *
 * `auditFixtureDir` is a GATE: it runs before any external code executes
 * and refuses repositories that could escape the sanitized environment
 * (install-time lifecycle hooks; project-level npmrc/yarnrc which npm/yarn
 * would honor over our --userconfig isolation).
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AuditViolation {
  code:
    | 'lifecycle-hook-present' | 'config-file-injection-risk'
    | 'manifest-unreadable' | 'manifest-invalid'
    // Post-GLM panel AM-2: the audit runs on the FRESHLY CHECKED-OUT tree
    // (pipeline step [2], before install/prepare), so a node_modules present
    // at audit time was SHIPPED by the subject. Refused, not scanned — see
    // auditFixtureDir.
    | 'node-modules-shipped';
  detail: string;
}

export interface AuditResult {
  ok: boolean;
  violations: AuditViolation[];
  package: { name: string; version: string };
  declaredDependency: string | null;
}

const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
const RISKY_RC_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml'] as const;
// Audit F7: on case-insensitive filesystems (Windows default, macOS default)
// npm/yarn load `.NPMRC` / `.YarnRc` exactly like the lowercase names — the
// gate must match case-INSENSITIVELY everywhere (fail-closed even on Linux,
// where the uppercase file simply does nothing: rejecting is safe, missing
// one is not).
const RISKY_RC_FILES_LOWER = new Set<string>(RISKY_RC_FILES.map((f) => f.toLowerCase()));
const RC_SCAN_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

export function auditPackageManifestText(text: string, dependency: string): AuditResult {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      violations: [{ code: 'manifest-invalid', detail: 'package.json is not valid JSON' }],
      package: { name: '?', version: '?' },
      declaredDependency: null,
    };
  }
  const violations: AuditViolation[] = [];
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  for (const hook of LIFECYCLE_HOOKS) {
    if (typeof scripts[hook] === 'string' && (scripts[hook] as string).length > 0) {
      violations.push({ code: 'lifecycle-hook-present', detail: `${hook}: ${scripts[hook]}` });
    }
  }
  const deps = {
    ...((pkg.dependencies ?? {}) as Record<string, string>),
    ...((pkg.devDependencies ?? {}) as Record<string, string>),
  };
  return {
    ok: violations.length === 0,
    violations,
    package: { name: String(pkg.name ?? '?'), version: String(pkg.version ?? '?') },
    declaredDependency: typeof deps[dependency] === 'string' ? deps[dependency] : null,
  };
}

export function auditFixtureDir(fixtureDir: string, dependency: string): AuditResult {
  // AM-2 (post-GLM panel): the acquisition chain produces a FRESH checkout at
  // this point — install and prepare run only after this gate. A node_modules
  // directory here therefore arrived WITH the subject's source: pre-planted
  // runner bytes the audit tier exists to quarantine. Refusing it keeps the
  // invariant "every node_modules byte in the workspace was created post-audit
  // by Canary's own pipeline", which is what lets per-round expansion re-hash
  // the runner tree and mean it. Honest scope note: belt-and-braces ONLY — a
  // prepare script can still CREATE a double at runtime, and AM-1 (pinned
  // bytes gate injection, packages/support/src/knownRunners.ts) is what
  // actually closes that. Callers treat this code as InfraAbort, not MISUSE.
  const shippedNm: AuditViolation[] = fs.existsSync(path.join(fixtureDir, 'node_modules'))
    ? [{ code: 'node-modules-shipped', detail: 'fixture ships node_modules/ at audit time (runner bytes must arrive via Canary\'s install, never the repo tree)' }]
    : [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8');
  } catch {
    return {
      ok: false,
      violations: [...shippedNm, { code: 'manifest-unreadable', detail: 'no readable package.json at fixture root' }],
      package: { name: '?', version: '?' },
      declaredDependency: null,
    };
  }
  const result = auditPackageManifestText(text, dependency);
  const foundRc = findRcFiles(fixtureDir);
  const violations = [
    ...shippedNm,
    ...result.violations,
    ...foundRc.map((f) => ({
      code: 'config-file-injection-risk' as const,
      detail: `fixture ships ${f} (npm/yarn project-config injection vector)`,
    })),
  ];
  return { ...result, ok: violations.length === 0, violations };
}

/** Recursive scan (red-team F10): rc files anywhere in the pinned source,
 *  not just the root — future --prefix/cwd options must not bypass the gate. */
export function findRcFiles(dir: string, maxDepth = 6, rel = ''): string[] {
  const hits: string[] = [];
  if (maxDepth < 0) return hits;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const e of entries) {
    if (e.isFile() && RISKY_RC_FILES_LOWER.has(e.name.toLowerCase())) {
      hits.push(path.posix.join(rel, e.name).replace(/\\/g, '/'));
    } else if (e.isDirectory() && !RC_SCAN_SKIP.has(e.name) && !e.name.startsWith('.')) {
      hits.push(...findRcFiles(path.join(dir, e.name), maxDepth, rel ? `${rel}/${e.name}` : e.name));
    }
  }
  return hits;
}

/** Deterministic name of the directory codeload tarballs extract to. */
export function expectedExtractedDir(repo: string, sha: string): string {
  const proj = repo.split('/')[1] ?? repo;
  return `${proj}-${sha}`;
}
