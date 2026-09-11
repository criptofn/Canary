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
 * (b) an AUTHORITY that binds those bytes to a runner the operator or Canary
 * itself can vouch for. Since v1.1 Phase 2 the authority is one of THREE kinds,
 * because runners are not all the same kind of artifact:
 *
 *   package-pin        the runner's release bytes match a pin in THIS repo
 *                      (mocha). Checked against KNOWN_RUNNER_RELEASES, which must
 *                      carry an npm-origin release.
 *   runtime-identity   the runner IS the runtime Canary is executing on
 *                      (`node --test`). There is no "which one did the operator
 *                      authorize?" question: expansion refuses any `node` whose
 *                      realpath is not `process.execPath`.
 *   operator-identity  the runner is neither: a Python interpreter or a pytest
 *                      installation on this host. Its identity (version + a
 *                      content digest of its own bytes) is MEASURED by Canary and
 *                      must be granted — in the product, by the operator's sealed
 *                      setup plan (apps/cli/src/runner-authority.ts).
 *
 * A non-package-pin STRONG row must also name the `channelModule` that implements
 * its loader and a `measuredOn` statement, and `runners.test.ts` checks that the
 * module EXISTS on disk — so a capability cannot be claimed without a channel a
 * reviewer can open, and "blocked" stays distinguishable from "not tried".
 *
 * UNKNOWN IS A FIRST-CLASS ANSWER. `resolveRunnerAdapter` returns null for a
 * runner nobody registered, and `observationCapabilityFor` turns that into
 * INCONCLUSIVE_ONLY with `runner-unverified`. That is how "unknown/unverified
 * runner ⇒ INCONCLUSIVE, never fabricated strong proof" is made structural
 * rather than a matter of remembering.
 */

import { KNOWN_RUNNER_RELEASES } from '@canary-rn/support';

import { OBSERVER_VERSION } from './observation.js';

/** Ecosystem a runner belongs to. Used for reporting and for the nested-scope
 *  work (item B), never as a trust signal by itself. */
export type RunnerFamily = 'node' | 'python' | 'rust' | 'go';

/**
 * What a strong label can rest on for this runner.
 *  - STRONG             Canary injects its own observer bytes, bound to an
 *                       authority (see the header), and re-counts the lifecycle it
 *                       watched. A VALID observation is reachable, so strong
 *                       labels are reachable.
 *  - INCONCLUSIVE_ONLY  No observation channel exists. Every fact about a run of
 *                       this runner is SUBJECT TEXT, and subject text is a claim.
 *                       Strong labels are structurally unreachable (classification
 *                       rule 14), by design.
 */
export type ObservationCapability = 'STRONG' | 'INCONCLUSIVE_ONLY';

/** Which authority binds an injected observer's bytes to a runner. */
export type ObservationAuthority = 'package-pin' | 'runtime-identity' | 'operator-identity';

/** The injected observation protocol a STRONG adapter implements. */
export interface StrongObservation {
  authority: ObservationAuthority;
  /** Key into KNOWN_RUNNER_RELEASES — required iff authority is 'package-pin'. */
  pinKey?: string;
  /** Repo-relative module implementing this channel's loader — required for every
   *  authority other than 'package-pin', so a claim names reviewable code. */
  channelModule?: string;
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
  /**
   * What was ACTUALLY EXECUTED to establish this row, or an explicit statement
   * that nothing was. Without this, "blocked" and "not tried" look identical in
   * a table — and a host limit must never be reported as a design decision, nor
   * the reverse (v1.1 Phase 2).
   */
  measuredOn?: string;
}

/** What a PACKAGE-PIN adapter needs, spelled once so every reason can point at it. */
const STRONG_REQUIREMENTS =
  'one KNOWN_RUNNER_RELEASES entry PLUS its reviewed manifest under '
  + 'packages/support/test/fixtures/runner-manifests/ (offline-verified by '
  + 'known-runners-manifest.test.ts), an injected observer whose bytes are '
  + "Canary's, a validation contract that re-counts what Canary watched, and "
  + 'mutation-battery coverage proving the gate is pinned — or, for a runner that '
  + 'is not an npm package, a Canary-owned channel PLUS an authority that binds it '
  + '(the verifying runtime itself, or an operator-sealed identity)';

/**
 * The registry. Order is irrelevant to resolution (programs are unique), but
 * the STRONG entries come first because they are the ones with real evidence.
 */
export const RUNNER_ADAPTERS: readonly RunnerAdapter[] = [
  {
    id: 'mocha',
    family: 'node',
    programs: ['mocha'],
    scriptMarkers: [/\bmocha\b/],
    capability: 'STRONG',
    // `--require <preload>` expands the test argv with Canary's own bytes; frames
    // come back on a dedicated fd; the hello pid must equal the pid Canary spawned.
    observation: { authority: 'package-pin', pinKey: 'mocha', protocol: 'canary-observer-v1' },
  },
  {
    id: 'node-test',
    family: 'node',
    programs: ['node'],
    scriptMarkers: [/--test\b/, /\bnode:test\b/],
    capability: 'STRONG',
    // `--test-reporter=<file URL>` adds Canary's reporter as a SECOND reporter:
    // the ordinary TAP summary stays on stdout (output Canary did not produce) and
    // Canary's frames go to fd 3. Inserted immediately after the runtime, because
    // Node stops reading its own options at the first positional (measured).
    observation: {
      authority: 'runtime-identity',
      channelModule: 'packages/runner/executor/src/observers/node-test-reporter.ts',
      protocol: 'canary-observer-v1',
    },
    measuredOn: 'node 26.7.0 win32-x64: a real `node --test` run observed end-to-end (hello → pass/pending → bye) with '
      + 'counts agreeing with the runner TAP summary; printed TAP text minted nothing; two same-named tests both counted. '
      + 'Measured residual, favourable: each test FILE runs in its own child process, so subject code CANNOT reach the '
      + "observer's fd 3 (the write returns EBADF), unlike the in-process Python channels",
  },
  {
    id: 'pytest',
    family: 'python',
    programs: ['pytest'],
    scriptMarkers: [/\bpytest\b/, /-m\s+pytest\b/],
    capability: 'STRONG',
    // A plugin loaded through PYTHONPATH + PYTEST_PLUGINS (an environment door with
    // a fixed Canary-owned module name), so no argv surface can be used to displace
    // it; an explicit `-p no:canary_pytest_observer` is refused, and a project that
    // suppresses it through its own config simply produces no frames and the round
    // fails closed.
    observation: {
      authority: 'operator-identity',
      channelModule: 'packages/runner/executor/src/observers/pytest-observer.ts',
      protocol: 'canary-observer-v1',
    },
    measuredOn: 'pytest 9.1.1 / python 3.11.9 win32-x64 in a workspace-local venv (no global Python state touched): '
      + 'phase reports measured per category; the frames agreed with pytest own headline for '
      + 'passed/failed/error/skipped/xfailed/xpassed; a fabricated phase report for an unwatched item was rejected; a '
      + 'frame injected by test code corrupted the channel and failed the round closed',
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
    id: 'unittest',
    family: 'python',
    // Marker-only: `python` runs every Python program, so the program name alone
    // says nothing about whether a test runner is involved.
    programs: [],
    scriptMarkers: [/\bunittest\b/],
    capability: 'STRONG',
    // `sitecustomize` bytes on PYTHONPATH hook `unittest.TestResult` before any test
    // module is imported, and write the same NDJSON frames on fd 3. The authority is
    // the interpreter's own measured identity, granted by the operator's sealed
    // setup plan; a subject shipping its own interpreter earns ABSENT.
    observation: {
      authority: 'operator-identity',
      channelModule: 'packages/runner/executor/src/observers/python-observer.ts',
      protocol: 'canary-observer-v1',
    },
    measuredOn: 'python 3.11.9 win32-x64: a real unittest run observed end-to-end and agreeing with the interpreter own '
      + '"Ran N tests"; printed-summary forgery produced zero counts; a fabricated addSuccess was rejected live; and the '
      + 'whole path is now exercised through Recorder.expandArgvWithPlan + round (VALID observation, re-derivation parity, '
      + 'absent without a grant, INCONCLUSIVE on a rejected event)',
  },
  {
    id: 'cargo-test',
    family: 'rust',
    // Marker-only: `cargo build` is not a test run.
    programs: [],
    scriptMarkers: [/\bcargo\s+test\b/, /\bcargo\b.*\btest\b/],
    capability: 'INCONCLUSIVE_ONLY',
    // MEASURED ON THIS HOST (tooling/probes/runner-channels-rust-go.mjs, with a
    // workspace-local rust 1.98.1 on the GNU target because no MSVC linker is
    // installed). This is a PLATFORM limit, not an implementation gap:
    //   - `cargo test` runs and prints libtest's text summary;
    //   - `cargo test -- --format json` is REFUSED by the compiler itself:
    //     'The "json" format is only accepted on the nightly compiler with
    //      -Z unstable-options'.
    // So on stable Rust there is NO per-test event stream for Canary to
    // re-count. The text summary is a claim, and a claim is not proof.
    // Canary CAN own the launch (`CARGO_TARGET_<TRIPLE>_RUNNER` is honored: the
    // shim was invoked with the test binary and its args), which proves the
    // runner executed and binds the binary's identity — but per-test OUTCOMES
    // would still come from libtest's text.
    blockedBy: 'stable libtest exposes no machine-readable per-test event stream (the compiler refuses '
      + '"--format json" outside nightly with -Z unstable-options), so per-test outcomes can only come '
      + 'from libtest text — a claim, not an observation. Measured, not assumed; see '
      + 'tooling/probes/runner-channels-rust-go.mjs',
    requiredToUnblock: STRONG_REQUIREMENTS + '; the real seam is a Canary-owned test harness '
      + '(a `[[test]] harness = false` target whose main is Canary\'s), which turns per-test outcomes into '
      + 'Canary-emitted events. A nightly-only format is not a supportable pin',
    measuredOn: 'cargo 1.98.1 (GNU target), win32-x64: cargo test ran; --format json refused by the compiler; '
      + 'CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUNNER honored. ALSO MEASURED: under Canary\'s own sanitized '
      + 'environment the rustup PROXY cargo cannot choose a toolchain (RUSTUP_HOME/HOME are redirected), while the '
      + 'real toolchain binary runs fine — so a Rust STEP needs the adapter to resolve the toolchain binary, not the PATH proxy',
  },
  {
    id: 'go-test',
    family: 'go',
    // Marker-only: `go build` / `go run` are not test runs.
    programs: [],
    scriptMarkers: [/\bgo\s+test\b/],
    capability: 'INCONCLUSIVE_ONLY',
    // MEASURED ON THIS HOST (tooling/probes/runner-channels-rust-go.mjs, with a
    // workspace-local go1.27.1):
    //   - `go test -json` emits a real per-test event stream (17 events, named
    //     pass/skip records) that Canary can independently re-count;
    //   - `go test -exec=<shim>` IS honored, so Canary can own the launch of
    //     each test binary (the shim received `<pkg>.test.exe -test.paniconexit0 …`).
    // What is NOT yet closed is the FORGERY question: those events are produced
    // by the `go` tool from the test binary's own `test2json` output, so test
    // code that prints test-runner-shaped lines can mint events. That is an
    // implementation gap (a reviewed binding between the Canary-owned shim and
    // the event stream), not a platform limit.
    blockedBy: 'the event stream exists and Canary can own the test-binary launch, but nothing yet binds '
      + 'those events to the Canary-owned shim: `go test -json` derives them from the test binary\'s own '
      + 'test2json output, so subject test code can mint them. Measured; see '
      + 'tooling/probes/runner-channels-rust-go.mjs',
    requiredToUnblock: STRONG_REQUIREMENTS + '; the shim must frame the per-binary observation itself '
      + '(identity + count + exit bound to the pid Canary spawned) rather than trusting the tool\'s relay',
    measuredOn: 'go1.27.1 win32-x64: go test ran; -json produced named per-test pass/skip events; '
      + '-exec shim was invoked with the test binary. ALSO MEASURED: under Canary\'s own sanitized environment Go '
      + 'aborts with "build cache is required, but could not be located: GOCACHE is not defined and %LocalAppData% '
      + 'is not defined" (HOME/USERPROFILE are redirected) — so a Go STEP needs the adapter to declare a '
      + 'workspace-scoped GOCACHE/GOPATH',
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
  /** Present iff STRONG: the authority + protocol the injected observer uses. */
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
 *
 * Deliberately filesystem-free: the `channelModule` a claim names is checked to
 * EXIST by the test suite (which always runs inside the repository), so this
 * function stays pure and usable from a packaged CLI.
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
      const o = a.observation;
      if (o === undefined) {
        problems.push(`${a.id}: claims STRONG with no observation contract — a capability claim must name its observer`);
      } else {
        if (o.protocol !== OBSERVER_VERSION) {
          problems.push(`${a.id}: claims protocol "${o.protocol}", but this build implements "${OBSERVER_VERSION}"`);
        }
        if (o.authority === 'package-pin') {
          if (o.pinKey === undefined) {
            problems.push(`${a.id}: package-pin authority without a pinKey`);
          } else {
            const pins = KNOWN_RUNNER_RELEASES[o.pinKey] ?? [];
            if (pins.length === 0) {
              problems.push(`${a.id}: claims STRONG against pin key "${o.pinKey}", which has no release in KNOWN_RUNNER_RELEASES`);
            } else if (pins.every((p) => p.origin !== 'npm')) {
              problems.push(`${a.id}: claims STRONG but pin key "${o.pinKey}" has no npm-origin release — only an offline double, which is not an execution authority`);
            }
          }
          if (o.channelModule !== undefined) problems.push(`${a.id}: package-pin authority must not name a channelModule (the pinned package IS the runner)`);
        } else {
          // The runner is not an npm package, so the pin table cannot vouch for it.
          // What substitutes is a Canary-owned channel a reviewer can open PLUS an
          // authority, and a measured statement of what was executed.
          if (o.pinKey !== undefined) problems.push(`${a.id}: ${o.authority} authority must not carry a pinKey — nothing in KNOWN_RUNNER_RELEASES binds it`);
          if (o.channelModule === undefined || o.channelModule.trim() === '') {
            problems.push(`${a.id}: ${o.authority} authority must name the channel module that implements its loader`);
          }
          if (a.measuredOn === undefined || a.measuredOn.trim().length < 20) {
            problems.push(`${a.id}: STRONG on a non-package authority requires a measuredOn statement of what was executed`);
          }
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
export function runnerCapabilityTable(): Array<{ id: string; family: RunnerFamily; capability: ObservationCapability; why: string; measuredOn?: string }> {
  return RUNNER_ADAPTERS.map((a) => ({
    id: a.id,
    family: a.family,
    capability: a.capability,
    why: a.capability === 'STRONG'
      ? `injected observer (${a.observation?.protocol ?? 'unstated'}) bound by ${describeAuthority(a.observation)}`
      : (a.blockedBy ?? 'no reason recorded'),
    // Reporting the evidence keeps "blocked" and "not tried" distinguishable on
    // every surface, not only in this file's comments.
    ...(a.measuredOn !== undefined ? { measuredOn: a.measuredOn } : {}),
  }));
}

function describeAuthority(o: StrongObservation | undefined): string {
  if (o === undefined) return 'an unstated authority';
  if (o.authority === 'package-pin') return `pinned release "${o.pinKey ?? 'unstated'}"`;
  if (o.authority === 'runtime-identity') return 'the verifying runtime itself (the runner IS the binary Canary executes on)';
  return 'an operator-sealed runner identity (measured version + content digest)';
}
