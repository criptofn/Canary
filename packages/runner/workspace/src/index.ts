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
  code: 'lifecycle-hook-present' | 'config-file-injection-risk' | 'manifest-unreadable' | 'manifest-invalid';
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
  let text: string;
  try {
    text = fs.readFileSync(path.join(fixtureDir, 'package.json'), 'utf8');
  } catch {
    return {
      ok: false,
      violations: [{ code: 'manifest-unreadable', detail: 'no readable package.json at fixture root' }],
      package: { name: '?', version: '?' },
      declaredDependency: null,
    };
  }
  const result = auditPackageManifestText(text, dependency);
  const foundRc = findRcFiles(fixtureDir);
  const violations = [
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
    if (e.isFile() && (RISKY_RC_FILES as readonly string[]).includes(e.name)) {
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
