/**
 * Provider-neutral runner-observation registry.
 *
 * WHY THIS EXISTS (v1.1 item A): the strong-label contract was never runner
 * neutral — it was mocha. `validateObservation` names mocha's fields
 * (`expectedMochaVersion`, `observedMochaVersion`), the injection decision is
 * `mochaBin !== undefined`, and the pin table has exactly one real runner. The
 * consequence is the honest gap `docs/EXECUTION-AUTHORITY.md` records: every
 * other runner (jest, vitest, ava, `node --test`, pytest, cargo, go) cannot
 * reach PASS / CONFIRMED_REGRESSION / FLAKY / PRE_EXISTING_FAILURE, because a
 * strong label requires a VALID execution observation and there is no channel
 * to observe with.
 *
 * That gap is CORRECT — it is the fail-closed floor doing its job. What was
 * missing is that the gap was implicit: nothing in the code said "this runner
 * is registered, and here is exactly why it cannot be strong". So this module
 * makes the decision explicit, per runner, in ONE place, and makes it
 * impossible to claim a capability nobody implemented.
 *
 * THE INVARIANT THAT MATTERS: `capability: 'STRONG'` may only be set for a
 * runner that really has (a) an injected observer whose bytes are Canary's and
 * (b) a pin-table release to bind those bytes to. `STRONG` is a claim about
 * IMPLEMENTATION, not about data, so it is declared per adapter and then
 * CHECKED against the pin table by `runnerRegistryProblems()`. A runner with
 * pins but no observer is still not strong; a runner with an observer but no
 * pin is not strong either. Both are reported, not assumed.
 *
 * UNKNOWN IS A FIRST-CLASS ANSWER. `resolveRunnerAdapter` returns null for a
 * runner nobody registered, and `observationCapabilityFor` turns that into
 * INCONCLUSIVE_ONLY with `runner-unverified`. That is how "unknown/unverified
 * runner ⇒ INCONCLUSIVE, never fabricated strong proof" is made structural
 * rather than a matter of remembering.
 */

import { KNOWN_RUNNER_RELEASES } from '@canary-rn/support';

/** Ecosystem a runner belongs to. Used for reporting and for the nested-scope
 *  work (item B), never as a trust signal by itself. */
export type RunnerFamily = 'node' | 'python' | 'rust' | 'go';

/**
 * What a strong label can rest on for this runner.
 *  - STRONG             Canary injects its own observer bytes, bound to a pinned
 *                       release, and re-counts the lifecycle it watched. A VALID
 *                       observation is reachable, so strong labels are reachable.
 *  - INCONCLUSIVE_ONLY  No observation channel exists. Every fact about a run of
 *                       this runner is SUBJECT TEXT, and subject text is a claim.
 *                       Strong labels are structurally unreachable (classification
 *                       rule 14), by design.
 */
export type ObservationCapability = 'STRONG' | 'INCONCLUSIVE_ONLY';

/** The injected observation protocol a STRONG adapter implements. */
export interface StrongObservation {
  /** Key into KNOWN_RUNNER_RELEASES — the release bytes the observer is bound to. */
  pinKey: string;
  /** Observer protocol id; must equal OBSERVER_VERSION for an implemented channel. */
  protocol: string;
}

export interface RunnerAdapter {
  /** Stable id, also the value recorded as the observation's runner identity. */
  id: string;
  family: RunnerFamily;
  /** Executable basenames that identify this runner (extension stripped, lowercase). */
  programs: readonly string[];
  /** Markers that identify this runner inside a `<pm> run <script>` body. */
  scriptMarkers: readonly RegExp[];
  capability: ObservationCapability;
  /** Present iff STRONG. */
  observation?: StrongObservation;
  /** Present iff INCONCLUSIVE_ONLY: precisely why no strong label is reachable. */
  blockedBy?: string;
  /** Present iff INCONCLUSIVE_ONLY: what would have to exist first. */
  requiredToUnblock?: string;
}

/** What a STRONG adapter needs, spelled once so every reason can point at it. */
const STRONG_REQUIREMENTS =
  'one KNOWN_RUNNER_RELEASES entry PLUS its reviewed manifest under '
  + 'packages/support/test/fixtures/runner-manifests/ (offline-verified by '
  + 'known-runners-manifest.test.ts), an injected observer whose bytes are '
  + "Canary's, a validation contract that re-counts what Canary watched, and "
  + 'mutation-battery coverage proving the gate is pinned';

/**
 * The registry. Order is irrelevant to resolution (programs are unique), but
 * the STRONG entry is first because it is the one with real evidence behind it.
 */
export const RUNNER_ADAPTERS: readonly RunnerAdapter[] = [
  {
    id: 'mocha',
    family: 'node',
    programs: ['mocha'],
    scriptMarkers: [/\bmocha\b/],
    capability: 'STRONG',
    // The only implemented channel today. `--require <preload>` expands the test
    // argv with Canary's own bytes; frames come back on a dedicated fd; the
    // hello pid must equal the pid Canary spawned. See observation.ts.
    observation: { pinKey: 'mocha', protocol: 'canary-observer-v1' },
  },
  {
    id: 'jest',
    family: 'node',
    programs: ['jest'],
    scriptMarkers: [/\bjest\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: 'no injected observer and no pin: jest has no Canary-owned channel here, so its '
      + 'summary line is SUBJECT TEXT and classification rule 14 sends the verdict to INCONCLUSIVE',
    requiredToUnblock: STRONG_REQUIREMENTS,
  },
  {
    id: 'vitest',
    family: 'node',
    programs: ['vitest'],
    scriptMarkers: [/\bvitest\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: 'no injected observer and no pin: vitest has no Canary-owned channel here, so its '
      + 'summary is SUBJECT TEXT and rule 14 sends the verdict to INCONCLUSIVE',
    requiredToUnblock: STRONG_REQUIREMENTS,
  },
  {
    id: 'ava',
    family: 'node',
    programs: ['ava'],
    scriptMarkers: [/\bava\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: 'no injected observer and no pin: ava has no Canary-owned channel here, so its TAP '
      + 'output is SUBJECT TEXT and rule 14 sends the verdict to INCONCLUSIVE',
    requiredToUnblock: STRONG_REQUIREMENTS,
  },
  {
    id: 'node-test',
    family: 'node',
    programs: ['node'],
    scriptMarkers: [/--test\b/, /\bnode:test\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: '`node --test` is a first-class Node path and the reported TAP stream is still '
      + 'SUBJECT TEXT: no Canary-owned reporter is injected, so rule 14 sends the verdict to '
      + 'INCONCLUSIVE. `programs: [node]` is how it is RECOGNISED, not a claim that every `node` '
      + 'invocation is a test runner',
    requiredToUnblock: STRONG_REQUIREMENTS + '; the pin would be the Node build (version + binary '
      + 'digest) rather than an npm package tree',
  },
  {
    id: 'pytest',
    family: 'python',
    programs: ['pytest'],
    scriptMarkers: [/\bpytest\b/, /-m\s+pytest\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: 'no injected observer and no pin: pytest has no Canary-owned channel here, so its '
      + 'summary is SUBJECT TEXT and rule 14 sends the verdict to INCONCLUSIVE',
    requiredToUnblock: STRONG_REQUIREMENTS + '; for pytest the pin is a released distribution '
      + '(installed tree hash) and the injection point is a plugin loaded by absolute path',
  },
  {
    id: 'unittest',
    family: 'python',
    // Marker-only: `python` runs every Python program, so the program name alone
    // says nothing about whether a test runner is involved.
    programs: [],
    scriptMarkers: [/\bunittest\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: 'no injected observer and no pin: the Python journey Canary ships (project adapter '
      + 'discovery -> `-m unittest`) runs with no Canary-owned channel, so its output is SUBJECT '
      + 'TEXT and rule 14 sends the verdict to INCONCLUSIVE',
    requiredToUnblock: STRONG_REQUIREMENTS,
  },
  {
    id: 'cargo-test',
    family: 'rust',
    // Marker-only: `cargo build` is not a test run.
    programs: [],
    scriptMarkers: [/\bcargo\s+test\b/, /\bcargo\b.*\btest\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: 'no injected observer and no pin, AND no cargo/rustc is installed on the '
      + 'verification host, so no adapter here could be executed even once. An unexecuted '
      + 'observation path is not evidence, so it is not claimed',
    requiredToUnblock: STRONG_REQUIREMENTS + '; cargo offers a runner shim '
      + '(CARGO_TARGET_<TRIPLE>_RUNNER) that Canary could own, but it must be executed and '
      + 'mutation-pinned on a host that actually has the toolchain',
  },
  {
    id: 'go-test',
    family: 'go',
    // Marker-only: `go build` / `go run` are not test runs.
    programs: [],
    scriptMarkers: [/\bgo\s+test\b/],
    capability: 'INCONCLUSIVE_ONLY',
    blockedBy: 'no injected observer and no pin, AND no Go toolchain is installed on the '
      + 'verification host, so no adapter here could be executed even once. An unexecuted '
      + 'observation path is not evidence, so it is not claimed',
    requiredToUnblock: STRONG_REQUIREMENTS + '; `go test -exec=<shim>` is the plausible '
      + 'Canary-owned seam, but it must be executed and mutation-pinned on a host that actually '
      + 'has the toolchain',
  },
];

/** The synthetic answer for a runner nobody registered. Never strong. */
export const UNVERIFIED_RUNNER: RunnerAdapter = {
  id: 'unknown',
  family: 'node',
  programs: [],
  scriptMarkers: [],
  capability: 'INCONCLUSIVE_ONLY',
  blockedBy: 'runner is not registered in RUNNER_ADAPTERS and has no Canary-owned observation '
    + 'channel, so anything it printed is SUBJECT TEXT and rule 14 sends the verdict to '
    + 'INCONCLUSIVE — an unknown runner is never credited with strong proof',
  requiredToUnblock: `register the runner in packages/runner/executor/src/runners.ts, then satisfy: ${STRONG_REQUIREMENTS}`,
};

/** Strip a directory and a Windows executable extension: `/x/y/MOCHA.CMD` -> `mocha`. */
export function normalizeProgram(program: string): string {
  const base = program.replace(/\\/g, '/').split('/').pop() ?? program;
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
}

/** Resolution input: a resolved step program, its script body, or both. */
export interface RunnerRef {
  program?: string | undefined;
  script?: string | undefined;
}

/**
 * The registered adapter for this invocation, or null when nothing matches.
 *
 * A program match is stronger than a script match (an executable named `mocha`
 * is more specific than the word "mocha" appearing in a script body), so the
 * program is consulted first and `node` — which is `node-test`'s recognised
 * program — only wins on a script marker, never on its name alone.
 */
export function resolveRunnerAdapter(ref: RunnerRef): RunnerAdapter | null {
  const prog = ref.program === undefined ? null : normalizeProgram(ref.program);
  if (prog !== null) {
    for (const a of RUNNER_ADAPTERS) {
      // `node` is deliberately excluded from the bare-name path: every Node
      // script in existence runs under `node`, so the name alone would classify
      // unrelated invocations as a test runner. Its script marker is required.
      if (a.id === 'node-test') continue;
      if (a.programs.includes(prog)) return a;
    }
  }
  const script = ref.script ?? '';
  if (script !== '') {
    for (const a of RUNNER_ADAPTERS) {
      if (a.scriptMarkers.some((re) => re.test(script))) return a;
    }
  }
  return null;
}

/** The capability decision for an invocation, with the reason attached. */
export interface RunnerObservationDecision {
  /** Registered adapter id, or 'unknown'. */
  runner: string;
  family: RunnerFamily;
  capability: ObservationCapability;
  /** Absent iff STRONG. */
  reason?: string;
  /** Present iff STRONG: the pin key + protocol the injected observer uses. */
  observation?: StrongObservation;
}

/**
 * The ONE place a caller asks "can a strong label rest on this runner?".
 * Anything unrecognised is INCONCLUSIVE_ONLY/`unknown` — fail closed, and say so.
 */
export function observationCapabilityFor(ref: RunnerRef): RunnerObservationDecision {
  const a = resolveRunnerAdapter(ref) ?? UNVERIFIED_RUNNER;
  if (a.capability === 'STRONG' && a.observation !== undefined) {
    return { runner: a.id, family: a.family, capability: 'STRONG', observation: a.observation };
  }
  return {
    runner: a.id,
    family: a.family,
    capability: 'INCONCLUSIVE_ONLY',
    reason: a.blockedBy ?? 'no observation channel declared',
  };
}

/**
 * Every way the registry could be lying, as a list of human-readable problems.
 * Empty is the only acceptable answer; `runners.test.ts` asserts it, so a
 * capability claim cannot be added without its evidence, and an INCONCLUSIVE
 * entry cannot be added without saying why.
 */
export function runnerRegistryProblems(): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenPrograms = new Map<string, string>();
  for (const a of RUNNER_ADAPTERS) {
    if (seenIds.has(a.id)) problems.push(`duplicate adapter id "${a.id}"`);
    seenIds.add(a.id);
    if (a.programs.length === 0 && a.scriptMarkers.length === 0) {
      problems.push(`${a.id}: declares neither programs nor scriptMarkers, so it can never be resolved`);
    }
    for (const p of a.programs) {
      // `node` is intentionally shared: node-test is marker-resolved only.
      if (p === 'node') continue;
      const prev = seenPrograms.get(p);
      if (prev !== undefined) problems.push(`program "${p}" claimed by both ${prev} and ${a.id}`);
      seenPrograms.set(p, a.id);
    }
    if (a.capability === 'STRONG') {
      if (a.observation === undefined) {
        problems.push(`${a.id}: claims STRONG with no observation contract — a capability claim must name its observer`);
      } else {
        const pins = KNOWN_RUNNER_RELEASES[a.observation.pinKey] ?? [];
        if (pins.length === 0) {
          problems.push(`${a.id}: claims STRONG against pin key "${a.observation.pinKey}", which has no release in KNOWN_RUNNER_RELEASES`);
        }
        if (pins.length > 0 && pins.every((p) => p.origin !== 'npm')) {
          problems.push(`${a.id}: claims STRONG but pin key "${a.observation.pinKey}" has no npm-origin release — only an offline double, which is not an execution authority`);
        }
      }
      if (a.blockedBy !== undefined) problems.push(`${a.id}: STRONG must not also carry blockedBy`);
    } else {
      if (a.blockedBy === undefined || a.blockedBy.trim() === '') {
        problems.push(`${a.id}: INCONCLUSIVE_ONLY without blockedBy — the reason a runner cannot be strong must be stated, not implied`);
      }
      if (a.observation !== undefined) problems.push(`${a.id}: INCONCLUSIVE_ONLY must not carry an observation contract`);
    }
  }
  return problems;
}

/** Every runner the registry recognises, for reporting surfaces (`canary result`). */
export function runnerCapabilityTable(): Array<{ id: string; family: RunnerFamily; capability: ObservationCapability; why: string }> {
  return RUNNER_ADAPTERS.map((a) => ({
    id: a.id,
    family: a.family,
    capability: a.capability,
    why: a.capability === 'STRONG'
      ? `injected observer (${a.observation?.protocol ?? 'unstated'}) bound to pinned release "${a.observation?.pinKey ?? 'unstated'}"`
      : (a.blockedBy ?? 'no reason recorded'),
  }));
}
