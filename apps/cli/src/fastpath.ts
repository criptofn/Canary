/**
 * 1.1 §23 — the adaptive fast path: the DECISION half.
 *
 * The intent is that a README typo should not pay for a typecheck, a build and
 * the whole test suite. The only safe way to remove a check is if the PROJECT
 * declared which paths that check depends on and the change provably touched
 * none of them. So this file is deliberately the pure half of the feature:
 *
 *   - `validateStepPaths` checks a project's declaration before it is SEALED
 *     (setup refuses a malformed one, exactly like `canary.proofs`);
 *   - `pathMatchesGlobs` answers "is this path inside the declared set?";
 *   - `decideFastPath` answers which steps must still run, and WHY for each one.
 *
 * It performs no I/O and no spawning, and it can only ever REMOVE work that a
 * declaration justifies. The rules that make it fail closed:
 *
 *   1. No declaration for a step ⇒ the step RUNS. There is no implicit default.
 *   2. A declaration exists ⇒ a step is skipped only when EVERY changed path is
 *      outside it. One changed path inside is enough to run the step.
 *   3. Nothing recorded as changed ⇒ everything RUNS. A skip needs a reason that
 *      can be shown to a human, and "we saw no change" is not one.
 *   4. Matching is case-INSENSITIVE and `**` matches zero or more segments, so a
 *      declaration matches MORE than a strict reader might expect. That is the
 *      conservative direction: more matching means fewer skips.
 *   5. Unknown step keys in a declaration are refused rather than ignored: a
 *      declaration for a check that is not in the plan is a mistake, and silently
 *      dropping it would leave the project believing it had declared something.
 *
 * Every decision carries a reason, because a skip that cannot explain itself is
 * indistinguishable from a check that was forgotten.
 */
import { stepKey, type PlanStep } from './project.js';

export interface FastPathSkip {
  step: PlanStep;
  /** The sealed-declaration key the decision was made against. */
  key: string;
  /** Why this step may be left out — always shown, never implied. */
  reason: string;
}

export interface FastPathDecision {
  /** Steps that must run, in the plan's own order. */
  run: PlanStep[];
  /** Steps the declarations justify leaving out, each with its reason. */
  skipped: FastPathSkip[];
  /** True when at least one step was left out (the caller must say so loudly). */
  usedFastPath: boolean;
}

const MAX_GLOBS_PER_STEP = 32;
const MAX_GLOB_LENGTH = 200;

/** Reject a declaration that could not mean what its author intended. */
function validateGlob(glob: unknown, where: string): string {
  if (typeof glob !== 'string' || glob.trim().length === 0) throw new Error(`${where}: every declared path must be a non-empty string`);
  const g = glob.trim();
  if (g.length > MAX_GLOB_LENGTH) throw new Error(`${where}: declared path is longer than ${MAX_GLOB_LENGTH} characters`);
  if (g.includes('\0')) throw new Error(`${where}: declared path must not contain NUL`);
  if (g.includes('\\')) throw new Error(`${where}: declared paths use forward slashes only (got ${JSON.stringify(g)})`);
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g)) throw new Error(`${where}: declared paths are relative to the project root (got ${JSON.stringify(g)})`);
  if (g.split('/').some((seg) => seg === '..')) throw new Error(`${where}: declared paths must not escape the project root (got ${JSON.stringify(g)})`);
  return g;
}

/**
 * Validate the `canary.paths` declaration that setup will seal.
 *
 * `plan` is the plan being sealed: a key that is not in it is refused, so the
 * declaration can never describe a check that does not exist (or one that was
 * dropped from the plan).
 */
export function validateStepPaths(raw: unknown, plan: readonly PlanStep[]): Record<string, string[]> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('canary.paths must be an object mapping plan checks to path patterns');
  const known = new Set(plan.map((s) => stepKey(s)));
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) {
      throw new Error(`canary.paths declares paths for "${key}", which is not a check in the sealed plan (known: ${[...known].sort().join(', ') || 'none'})`);
    }
    if (!Array.isArray(value) || value.length === 0) throw new Error(`canary.paths["${key}"] must be a non-empty array of path patterns`);
    if (value.length > MAX_GLOBS_PER_STEP) throw new Error(`canary.paths["${key}"] declares more than ${MAX_GLOBS_PER_STEP} patterns`);
    out[key] = value.map((g) => validateGlob(g, `canary.paths["${key}"]`));
  }
  return out;
}

/** One path segment against one pattern segment (`*`, `?`, literals). */
function segmentMatches(pattern: string, segment: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');
  return re.test(segment);
}

function matchesFrom(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === '**') {
    for (let i = 0; i <= path.length; i += 1) if (matchesFrom(rest, path.slice(i))) return true;
    return false;
  }
  if (path.length === 0) return false;
  if (!segmentMatches(head as string, path[0] as string)) return false;
  return matchesFrom(rest, path.slice(1));
}

/** Is `p` inside any declared pattern? `**` matches zero or more segments, and
 *  comparison is case-insensitive on purpose (see the file header). */
export function pathMatchesGlobs(p: string, globs: readonly string[]): boolean {
  const segments = p.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter((s) => s.length > 0);
  return globs.some((g) => matchesFrom(g.split('/').filter((s) => s.length > 0), segments));
}

/**
 * Which steps still have to run?
 *
 * `changedPaths` is what the repository reports as touched since the sealed
 * baseline. `declared` is the SEALED `canary.paths` map (keys are `stepKey`s).
 */
export function decideFastPath(
  plan: readonly PlanStep[],
  declared: Readonly<Record<string, readonly string[]>>,
  changedPaths: readonly string[],
): FastPathDecision {
  const run: PlanStep[] = [];
  const skipped: FastPathSkip[] = [];
  const changed = changedPaths.filter((p) => p.length > 0);
  for (const step of plan) {
    const key = stepKey(step);
    const globs = declared[key];
    if (globs === undefined || globs.length === 0) {
      run.push(step);
      continue;
    }
    if (changed.length === 0) {
      // rule 3: no observation, no skip
      run.push(step);
      continue;
    }
    const inside = changed.filter((p) => pathMatchesGlobs(p, globs));
    if (inside.length === 0) {
      skipped.push({
        step, key,
        reason: `no changed path is inside the declared paths for "${key}" (${globs.join(', ')}); ${changed.length} changed path(s) were checked`,
      });
      continue;
    }
    run.push(step);
  }
  return { run, skipped, usedFastPath: skipped.length > 0 };
}
