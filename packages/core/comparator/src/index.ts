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
 * Extract failing test names from mocha-style output:
 *   "  N) Suite\n      test name:\n" plus spec lines "  ✗ name".
 * Ava-style "✖ name" lines too. Best-effort auxiliary evidence —
 * classification never depends on it.
 */
export function extractFailingTestNames(log: string): string[] {
  const names = new Set<string>();
  // mocha failure listing: `  1) Suite`, then indented `     test name:`
  const mochaBody = /^\s+\d+\)\s+.+\n\s+(.+?):/gm;
  let m: RegExpExecArray | null;
  while ((m = mochaBody.exec(log)) !== null) names.add(m[1]!.trim());
  // ava
  const ava = /^\s*✖\s+(?:\w+\s*›\s*)?(.+?)\s*$/gm;
  while ((m = ava.exec(log)) !== null) names.add(m[1]!.trim());
  return [...names];
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
