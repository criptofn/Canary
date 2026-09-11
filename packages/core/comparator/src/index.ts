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
 *   INCOMPLETE — a real tree, but something about the OBSERVATION is partial:
 *                the studied dependency is ABSENT (a confinement claim would
 *                be unanchored), or `anomalies` records nodes the flatten
 *                could not fully observe (missing/unreadable version fields,
 *                non-object subtrees, disk-vs-json disagreements from the
 *                independent on-disk sweep — round-3 blocker 6: these used to
 *                be silent 'x' sentinels or invisible omissions while the
 *                verdict still classified VALID).
 *   VALID      — a non-empty parsed tree containing the studied dependency,
 *                with NO observation anomalies.
 *
 * npm's `problems` array (version-invalidity) is passed in ONLY for the
 * caller's transparency and deliberately does NOT change the status: `npm ls`
 * exits non-zero for known, expected version-invalidity while still yielding a
 * complete, comparable tree (the Axios fixture's documented case). The audit
 * explicitly requires a principled rule over "exitCode/problems must be
 * clean", so the presence of the studied dependency in a parsed non-empty tree
 * is the signal — and a COMPLETE one: partial observations must never support
 * trusted verdicts (round-3 blocker 6).
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
  /** Round-3 blocker 6: every partial-observation finding from the flatten
   *  and the independent disk sweep. Any non-empty list caps the status at
   *  INCOMPLETE — a tree with holes is not a tree confinement can be proven
   *  over. Deterministic order expected (callers sort). */
  anomalies?: readonly string[];
}): TreeStatus {
  if (!o.parsed || !o.hasRootDeps || Object.keys(o.deps).length === 0) return 'INVALID';
  if (o.anomalies && o.anomalies.length > 0) return 'INCOMPLETE';
  if (!o.dependencyPresent) return 'INCOMPLETE';
  return 'VALID';
}

/**
 * True if `key` lies anywhere inside the dependency's SUBTREE: the name of
 * the dependency appears as ONE FULL PATH SEGMENT of the key. This covers
 * the dependency itself ('axios'), a nested copy at any depth
 * ('bundlesize/axios'), the dependency's own children ('axios/proxy-from-env')
 * AND descendants of nested copies ('bundlesize/axios/proxy-from-env') —
 * round-3 blocker 6: the old prefix/suffix tests missed exactly that last
 * family, so drift deeper under a nested copy was falsely reported as
 * OUTSIDE the subtree (false INCONCLUSIVE), while partial descendants could
 * not be recognized at all.
 *
 * CONTRACT (red-team F4): keys must be treeHash-ESCAPED — the '/' inside a
 * scoped package name is encoded as '%2F', so a raw '/' only ever means
 * parent/child nesting. Without escaping, '@types/axios' would masquerade
 * as a nested axios copy and bypass the confinement proof. The segment test
 * is SAFE precisely because of escaping: '@types%2Faxios' is one segment
 * that never equals 'axios'.
 *
 * Audit F10: the `dependency` ARGUMENT is the raw spec name (e.g.
 * '@scope/pkg'), but keys are escaped — comparing raw-vs-escaped meant a
 * scoped dependency's OWN subtree never matched, so every scoped-drift report
 * was falsely "not confined". escapePkgKey is idempotent (a '%2F' has no
 * '/' left to re-escape), so this also tolerates an already-escaped argument.
 */
export function inDependencySubtree(key: string, dependency: string): boolean {
  const dep = escapePkgKey(dependency);
  return key.split('/').includes(dep);
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
 *     ':' are further segments. ROOT-LEVEL failures (mocha prints the whole
 *     title ON the numbered line, colon included: `1) some test:`) get their
 *     identity directly from that line (round-3 blocker 1: these used to
 *     parse to NOTHING, collapsing distinct root failures to equal empty
 *     identity sets and enabling false CONFIRMED_REGRESSION).
 *   - ava:   "suite › test" normalised to "suite > test".
 * Identical identities within a run are deduplicated (deterministic);
 * DIFFERENT identities are never collapsed. Best-effort auxiliary evidence —
 * the classifier consumes these only for profile comparison (audit F2), and
 * the classifier REFUSES trustful labels unless parsed identities fully
 * account for the reported failing count (identityCoverage).
 */
const ERROR_BREAK = /^(?:Error|AssertionError|TypeError|RangeError|ReferenceError|expected\b|\w+Error\b|\bat\s|√|✓|✗|×|—|-)/;
const NEXT_BLOCK = /^\s*\d+\)\s/;
const SUMMARY_LINE = /^\s*\d+\s+(?:tests?\s+)?(?:passing|failing|pending|passed|failed)\b/;
/** Defensive bound on describe-path nesting scanned for one identity. */
const MAX_TITLE_SEGMENTS = 24;

/**
 * CANONICAL runner-output view — the ONE normalization every text-derived fact
 * must see (post-GLM F3). The executor's matchers already stripped ANSI/CSI
 * before matching while these parsers normalized only line endings, so the
 * same bytes gave different representations at different decision points:
 * hasRunnerSummary said "summary" while parseSummaryCounts saw no counts —
 * an exit-code-swallowing wrapper could ANSI-wrap just its failing line and
 * walk rule 1's masked-failure clause right past us (false PASS), and a
 * genuine FORCE_COLOR run lost every count to the same blindness (false
 * infra). CSI parameters ([0-9;]*) can never contain \n, so stripping before
 * splitting is per-line-equivalent. Artifacts stay byte-exact; only DERIVED
 * facts see this view, and prove.ts re-derives through these same functions
 * (parity). The executor's view() is this function — one definition.
 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
export function runnerView(out: string): string {
  return out.replace(ANSI_RE, '').replace(/\r\n?/g, '\n');
}

export function extractFailingTestNames(log: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    const t = id.trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  };

  // post-sol secondary + post-GLM F3: canonical runnerView at entry (line
  // endings AND ANSI) — neither a lone-CR stream nor color escapes may
  // defeat the line parser.
  const norm = runnerView(log);
  const lines = norm.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\d+\)\s+(.+?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const first = m[1]!.trim();
    // Root-level failure: the ENTIRE title sits on the numbered line and
    // ends with ':'. Emit it directly; do not scan continuations.
    if (/:\s*$/.test(first)) { add(first.replace(/:\s*$/, '').trim()); continue; }
    const segments: string[] = [first];
    let foundColon = false;
    for (let j = i + 1; j < lines.length && segments.length <= MAX_TITLE_SEGMENTS; j++) {
      const l = lines[j]!.trim();
      if (l === '') continue;
      // The block ended without a title tail: next failure block, the
      // summary line, or an error/stack line. Abandon this `N)` — never
      // swallow the NEXT block's lines as if they were our continuation
      // (round-3 blocker 1, mixed root+nested corruption).
      if (NEXT_BLOCK.test(l) || SUMMARY_LINE.test(l) || ERROR_BREAK.test(l)) break;
      if (/:\s*$/.test(l)) { segments.push(l.replace(/:\s*$/, '').trim()); foundColon = true; break; }
      segments.push(l);
    }
    if (foundColon) add(segments.filter(Boolean).join(' > '));
  }

  // ava-style failing lines: "✖ suite › nested › test"
  const ava = /^\s*[✖×]\s+(.+?)\s*$/gm;
  let a: RegExpExecArray | null;
  while ((a = ava.exec(norm)) !== null) add(a[1]!.replace(/\s*›\s*/g, ' > ').trim());

  return out;
}

/** Counts of pass/fail lines in a test-runner summary (mocha/ava formats). */
export interface SummaryCounts {
  passing?: number | undefined;
  failing?: number | undefined;
  pending?: number | undefined;
}

export function parseSummaryCounts(log: string): SummaryCounts {
  // post-sol secondary + post-GLM F3: canonical runnerView at entry — line
  // endings AND ANSI are normalized exactly like the executor matchers, so
  // no byte can make hasRunnerSummary and these counts disagree.
  const norm = runnerView(log);
  const g = (re: RegExp): number | undefined => {
    const m = re.exec(norm);
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

// ─────────────────── Python `unittest` text summary (v1.1 Phase 2) ───────────────────
/**
 * `unittest` prints TWO facts and expects you to do the arithmetic:
 *
 *   Ran 4 tests in 0.000s
 *   OK (skipped=1)
 *   FAILED (failures=1, errors=2, skipped=3, expected failures=4, unexpected successes=5)
 *
 * The count that matters for observation agreement is per-CATEGORY, and the
 * categories are not the same three mocha reports, so they are mapped explicitly
 * rather than guessed:
 *   failing = failures + errors + unexpected successes   (a test that passed
 *             while marked as an expected failure IS a failure)
 *   pending = skipped + expected failures
 *   passing = total - failing - pending
 *
 * Returns undefined when the text is not a unittest summary OR when the numbers
 * cannot describe a run at all (`passing` negative). Refusing to invent counts
 * from inconsistent text is the point: this function feeds the AGREEMENT check
 * that makes printed output refutable, never the source of a count.
 */
export function parseUnittestCounts(log: string): SummaryCounts | undefined {
  const norm = runnerView(log);
  const ran = /^\s*Ran (\d+) tests? in /m.exec(norm);
  if (!ran) return undefined;
  const total = Number(ran[1]);
  // The verdict line is the LAST "OK"/"FAILED" line: unittest prints failure
  // detail blocks before it, and a test's own output could contain the word.
  let verdict: RegExpExecArray | null = null;
  const verdictRe = /^\s*(OK|FAILED)\b([^\n]*)$/gm;
  for (let m = verdictRe.exec(norm); m !== null; m = verdictRe.exec(norm)) verdict = m;
  if (verdict === null) return undefined;
  const detail = (verdict[2] ?? '').replace(/^\s*\(/, '').replace(/\)\s*$/, '');
  const counts = new Map<string, number>();
  for (const part of detail.split(',')) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?)\s*=\s*(\d+)\s*$/.exec(part);
    if (m) counts.set(m[1]!.trim().toLowerCase(), Number(m[2]));
  }
  const n = (k: string): number => counts.get(k) ?? 0;
  const failing = n('failures') + n('errors') + n('unexpected successes');
  const pending = n('skipped') + n('expected failures');
  const passing = total - failing - pending;
  if (passing < 0) return undefined; // text that cannot describe a run is not a summary
  return { passing, failing, pending };
}

// ─────────────────── node:test TAP summary (v1.1 Phase 2) ───────────────────
/**
 * `node --test` prints a TAP summary block at the END of stdout:
 *
 *   # tests 7
 *   # suites 0
 *   # pass 3
 *   # fail 2
 *   # cancelled 0
 *   # skipped 1
 *   # todo 1
 *
 * THREE measured properties make this parseable without trusting the subject:
 *
 *  1. The lines are ANCHORED (`^# pass N$`) and the LAST occurrence wins. The TAP
 *     reporter escapes a subject's own printed output: a test that runs
 *     `console.log('# pass 9')` appears on stdout as `# \# pass 9` (MEASURED, see
 *     `tooling/probes/node-test-reporter-events.mjs`), which does not match an
 *     anchored pattern. An unanchored `/ # pass (\d+)/` WOULD match it — the
 *     substring is there — which is why anchoring is load-bearing and not style.
 *  2. `# skipped` and `# todo` are SEPARATE counters and neither is inside
 *     `# pass` (measured: 1 skipped + 1 todo alongside `# pass 3` of 7 tests).
 *     Both are `pending` here, because that is what the frames carry.
 *  3. The arithmetic must close: pass + fail + skipped + todo == tests. Text that
 *     cannot describe a run is not accepted as a summary, and a `# cancelled N`
 *     run is refused rather than guessed at — no counter exists for it in the
 *     frame vocabulary, so agreement with it could not be checked.
 */
export function parseNodeTestCounts(log: string): SummaryCounts | undefined {
  const norm = runnerView(log);
  const last = (key: string): number | undefined => {
    const re = new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm');
    let m: RegExpExecArray | null = null;
    let value: number | undefined;
    while ((m = re.exec(norm)) !== null) value = Number(m[1]);
    return value;
  };
  const total = last('tests');
  const passing = last('pass');
  const failing = last('fail');
  if (total === undefined || passing === undefined || failing === undefined) return undefined;
  const pending = (last('skipped') ?? 0) + (last('todo') ?? 0);
  const cancelled = last('cancelled') ?? 0;
  if (cancelled !== 0) return undefined; // no frame counter exists: unverifiable
  if (passing + failing + pending !== total) return undefined; // text that cannot describe a run
  return { passing, failing, pending };
}

/**
 * The failing-test identities a node:test TAP stream names.
 *
 * TAP marks a failure `not ok N - <name>` at any nesting depth, so the pattern is
 * indentation-tolerant; the escaped subject line `# not ok 1 - forged` (a test
 * printing TAP) can never match because of its `# ` prefix. MEASURED on a run
 * where a test printed exactly that.
 */
export function extractNodeTestFailingNames(log: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /^\s*not ok \d+ - (.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(runnerView(log))) !== null) {
    const t = m[1]!.trim();
    if (t !== '' && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/**
 * The text-summary parser for a named observation channel. ONE dispatcher, so
 * the executor and `prove` cannot disagree about which text meant what: an
 * unknown runner has NO text counts, which is exactly right — its text is a
 * claim nothing can corroborate.
 */
export function parseSummaryCountsFor(runner: string | undefined, log: string): SummaryCounts {
  if (runner === 'python-unittest') return parseUnittestCounts(log) ?? {};
  if (runner === 'node-test') return parseNodeTestCounts(log) ?? {};
  return parseSummaryCounts(log);
}

/** Whether `log` contains the summary a named channel expects. */
export function hasRunnerSummaryFor(runner: string | undefined, log: string): boolean {
  if (runner === 'python-unittest') return parseUnittestCounts(log) !== undefined;
  if (runner === 'node-test') return parseNodeTestCounts(log) !== undefined;
  return parseSummaryCounts(log).passing !== undefined || parseSummaryCounts(log).failing !== undefined;
}

/**
 * The failing-test identities for a named observation channel. Same one-
 * dispatcher rule as the counts: the agreement check compares the frames against
 * the names read from THIS channel's own text format, so a node:test round is
 * never compared against mocha's `N) title` grammar.
 */
export function extractFailingTestNamesFor(runner: string | undefined, log: string): string[] {
  if (runner === 'node-test') return extractNodeTestFailingNames(log);
  return extractFailingTestNames(log);
}
