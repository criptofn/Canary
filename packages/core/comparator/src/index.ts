/**
 * Comparator — the proof behind the claim "everything was equal except the
 * dependency". Tree drift is computed from resolved install graphs; the
 * experiment is only trustworthy when drift is confined to the studied
 * dependency's own subtree.
 */

export type DepTree = Record<string, string>; // "pkg" | "parent/child" -> version

export interface TreeDrift {
  confined: boolean;
  changed: Array<{ pkg: string; from: string; to: string }>;
  /** Changed keys NOT explained by the dependency subtree. */
  other: string[];
}

export function diffTrees(before: DepTree, after: DepTree, dependency: string): TreeDrift {
  const changed: TreeDrift['changed'] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    const b = before[k];
    const a = after[k];
    if (b !== a) changed.push({ pkg: k, from: b ?? 'absent', to: a ?? 'absent' });
  }
  const other = changed
    .filter((c) => !inDependencySubtree(c.pkg, dependency))
    .map((c) => c.pkg);
  return { confined: other.length === 0, changed, other };
}

/**
 * Health of a single-arm dependency-tree OBSERVATION (audit B6). A
 * confinement proof is only as trustworthy as the trees it compares; a
 * vacuous/empty observation previously made `diffTrees({},{})` report
 * `confined: true`, silently "proving" comparability from no data.
 *
 *   INVALID    — nothing usable: no parsed tree (parse failure / no root
 *                dependencies object) or a completely empty tree.
 *   INCOMPLETE — a real tree, but the studied dependency is ABSENT from it,
 *                so we are not observing the thing the swap actually changed
 *                (a confinement claim would be unanchored).
 *   VALID      — a non-empty parsed tree that contains the studied dependency.
 *
 * npm's `problems` array (version-invalidity) is passed in ONLY for the
 * caller's transparency and deliberately does NOT change the status: `npm ls`
 * exits non-zero for known, expected version-invalidity while still yielding a
 * complete, comparable tree (the Axios fixture's documented case). The audit
 * explicitly requires a principled rule over "exitCode/problems must be
 * clean", so the presence of the studied dependency in a parsed non-empty tree
 * is the signal.
 */
export type TreeStatus = 'VALID' | 'INCOMPLETE' | 'INVALID';

export function dependencyInTree(deps: DepTree, dependency: string): boolean {
  const esc = escapePkgKey(dependency);
  return Object.keys(deps).some((k) => k === esc || k.endsWith('/' + esc));
}

export function classifyTreeObservation(o: {
  parsed: boolean;
  hasRootDeps: boolean;
  deps: DepTree;
  dependencyPresent: boolean;
}): TreeStatus {
  if (!o.parsed || !o.hasRootDeps || Object.keys(o.deps).length === 0) return 'INVALID';
  if (!o.dependencyPresent) return 'INCOMPLETE';
  return 'VALID';
}

/**
 * True if `key` names the dependency itself, a top-level-nested copy at any
 * depth, or a copy nested under the dependency's own subtree.
 *
 * CONTRACT (red-team F4): keys must be treeHash-ESCAPED — the '/' inside a
 * scoped package name is encoded as '%2F', so a raw '/' only ever means
 * parent/child nesting. Without escaping, '@types/axios' would masquerade
 * as a nested axios copy and bypass the confinement proof.
 *
 * Audit F10: the `dependency` ARGUMENT is the raw spec name (e.g.
 * '@scope/pkg'), but keys are escaped — comparing raw-vs-escaped meant a
 * scoped dependency's OWN subtree never matched, so every scoped-drift report
 * was falsely "not confined". escapePkgKey is idempotent (a '%2F' has no
 * '/' left to re-escape), so this also tolerates an already-escaped argument.
 */
export function inDependencySubtree(key: string, dependency: string): boolean {
  const dep = escapePkgKey(dependency);
  return key === dep || key.startsWith(dep + '/') || key.endsWith('/' + dep);
}

/** Escape one npm package name for use inside DepTree paths. */
export function escapePkgKey(name: string): string {
  return name.replaceAll('/', '%2F');
}

/**
 * Canonical, SUITE-QUALIFIED failing-test identity (audit B1).
 *
 * The old parser captured ONLY the leaf test title, so two failures in
 * different suites sharing a leaf title (the real Axios run has
 * `passThrough tests (requires Node) > handles baseURL correctly` AND
 * `onNoMatch=passthrough option tests (requires Node) > handles baseURL
 * correctly`) collapsed to ONE identity. A candidate round failing Suite A's
 * copy and another failing Suite B's copy then looked "deterministic" — a
 * false CONFIRMED_REGRESSION. The canonical identity keeps the full describe
 * path so distinct failures stay distinct.
 *
 * Format (deterministic, no volatile path/timestamp data):
 *   - mocha: "Suite path > ... > test name" — the `N)` line is the first
 *     title segment, continuation lines up to (and excluding) the trailing
 *     ':' are further segments.
 *   - ava:   "suite › test" normalised to "suite > test".
 * Identical identities within a run are deduplicated (deterministic);
 * DIFFERENT identities are never collapsed. Best-effort auxiliary evidence —
 * the classifier consumes these only for profile comparison (audit F2).
 */
export function extractFailingTestNames(log: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    const t = id.trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  };

  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\d+\)\s+(.+?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const segments: string[] = [m[1]!.trim()];
    let foundColon = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!.trim();
      if (l === '') continue;
      // an error/stack line before any ':' means this `N)` block carries no
      // parseable title tail — abandon (avoids fabricating a suite-only id).
      if (/^(?:Error|AssertionError|TypeError|RangeError|ReferenceError|expected\b|\w+Error\b|\bat\s|√|✓|✗|×|—|-)/.test(l)) break;
      if (/:\s*$/.test(l)) { segments.push(l.replace(/:\s*$/, '').trim()); foundColon = true; break; }
      segments.push(l);
    }
    if (foundColon) add(segments.filter(Boolean).join(' > '));
  }

  // ava-style failing lines: "✖ suite › nested › test"
  const ava = /^\s*[✖×]\s+(.+?)\s*$/gm;
  let a: RegExpExecArray | null;
  while ((a = ava.exec(log)) !== null) add(a[1]!.replace(/\s*›\s*/g, ' > ').trim());

  return out;
}

/** Counts of pass/fail lines in a test-runner summary (mocha/ava formats). */
export interface SummaryCounts {
  passing?: number | undefined;
  failing?: number | undefined;
  pending?: number | undefined;
}

export function parseSummaryCounts(log: string): SummaryCounts {
  const g = (re: RegExp): number | undefined => {
    const m = re.exec(log);
    return m ? Number(m[1]) : undefined;
  };
  return {
    passing: g(/^\s*(\d+)\s+(?:tests?\s+)?(?:passing|passed)\b/m),
    failing: g(/^\s*(\d+)\s+(?:tests?\s+)?(?:failing|failed)\b/m),
    pending: g(/^\s*(\d+)\s+(?:tests?\s+)?pending\b/m),
  };
}

/** True iff two normalized streams are identical — the determinism check. */
export function streamsStable(hashes: readonly string[]): boolean {
  return hashes.length > 0 && hashes.every((h) => h === hashes[0]);
}
