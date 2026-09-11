/**
 * Execution observation — Canary's OWN record of what a test-runner child did.
 *
 * WHY THIS EXISTS (post-GLM observation hardening, Finding A):
 * Every classification fact Canary used to consume about test execution —
 * "a runner summary appeared", "N tests passed", "these M tests failed" — was
 * PARSED FROM THE SUBJECT'S OWN STDOUT/STDERR. A subject that merely prints
 * mocha-shaped prose certifies its own execution, and that is how a GLM
 * auditor obtained a false PASS (`node -e console.log('128 passing (1s)')`)
 * from an unmodified CLI. Printed text is a CLAIM, not evidence.
 *
 * The channel: for the one runner family Canary can observe from inside the
 * process it spawns — a mocha whose package directory BYTE-FOR-BYTE matches a
 * Canary-repo-pinned release (KNOWN_RUNNER_RELEASES, panel AM-1) — Recorder
 * expands the test argv with `--require <preload>` (Canary's own bytes) and
 * reads back NDJSON lifecycle frames from a dedicated fd the observer writes.
 * Canary counts what it WATCHED happen.
 *
 * STATUS SEMANTICS (panel decision A — keep the vocabulary honest):
 *  - ABSENT  Canary attempted no observation (no injection): 'not-mocha-bin',
 *            'runner-identity-unpinned', or the tripwire 'no-injection' (fd 3
 *            piped but argv carries no injected preload — stray bytes on that
 *            pipe are recorded (strayFd3Bytes/Sha256) as an EMULATION ATTEMPT,
 *            never credited as an observation).
 *  - INVALID Canary attempted an observation and the channel failed to
 *            produce a trustworthy one: malformed/truncated stream, rejected
 *            event, adapter error, boundary/count/version/exit/text
 *            contradictions.
 *  - VALID   a pinned-bytes mocha, launched with Canary-injected argv, ran a
 *            lifecycle Canary watched end-to-end, agreeing with its own text.
 *
 * TRUST TIER (docs/exec-authority.md keeps the canonical list): VALID frames
 * are a CANARY-CONTROLLED OBSERVATION bound to (a) argv re-derivable as
 * Canary's injection, (b) runner bytes matching a pin, (c) hello.pid equal to
 * the PID Canary spawned, (d) the preload's own version marker. They are NOT
 * authenticated provenance: there is no cryptographic trust root, and code
 * running INSIDE the injected genuine process can neutralize the hooks and
 * emulate the protocol, or execute trivially-real tests under renamed titles
 * (residuals 8a/8a′/F3, documented). What is now structurally DEAD is
 * certifying execution from TEXT ALONE.
 *
 * Fail-closed: ANY doubt yields INVALID (strong labels become unreachable at
 * the classifier gate), never a guess. INTEGRITY vs PROVENANCE: framesSha256
 * + the retained .attest.ndjson give integrity; provenance rides on argv
 * re-derivation, the pid binding, and arm/round-owned artifact naming. Both
 * together are still not a signature — stated, not oversold.
 */

import { sha256hex } from '@canary-rn/hashing';
import type { ExecutionObservation, AbsentKind } from '@canary-rn/classification';

/** Bumped ONLY if the frame protocol changes incompatibly; prove compares the
 * retained preload bytes against the current source, so drift is caught twice. */
export const OBSERVER_VERSION = 'canary-observer-v1';

/** A VALID observation's frame kinds may never include these appearing. */
const KNOWN_KINDS = ['hello', 'pass', 'pending', 'fail', 'retry', 'reject', 'bye', 'adapter-error'];

export interface ValidateInput {
  /** Raw fd-3 text captured for this round ('' when the pipe carried nothing). */
  raw: string;
  /** True when the round's (re-derived) argv contains Canary's injected --require. */
  injected: boolean;
  /** Set when injection was NOT attempted: why (never on injected rounds). */
  absentKind: AbsentKind;
  /** True if support capped the bytes (flood) — content is by definition suspect. */
  truncated: boolean;
  /** Child exit code (RunOutcome); -1 reserved for killed. */
  exitCode: number;
  /** RunOutcome.childPid — hello.pid must equal it (spawn binding). */
  childPid: number | undefined;
  /** Pin-table values, present iff injection was attempted. */
  expectedMochaVersion?: string | undefined;
  expectedRunnerTreeSha256?: string | undefined;
  /** Hash of the located mocha directory, present iff a mocha package was found. */
  observedRunnerTreeSha256?: string | undefined;
  /** sha256 of the NON-package runner's own bytes as Canary hashed them on disk
   *  (a stdlib test package, a toolchain binary). Present iff this round carries
   *  a provider-neutral identity pin. */
  observedRunnerIdentitySha256?: string | undefined;
  /** Text channel (agreement checks; `?? 0` semantics mirror audit-F1 —
   *  a summary line mocha omits parses to undefined, credited as 0). */
  textCounts: { passing?: number | undefined; failing?: number | undefined; pending?: number | undefined };
  hasSummary: boolean;
  textFailingNames: readonly string[];
  /**
   * PROVIDER-NEUTRAL CHANNEL (v1.1 Phase 2). Present iff a runner adapter other
   * than the mocha channel produced this round. When set, `expectedRunner` is
   * mandatory: an observation with no stated requirement is exactly the
   * "trust the text" failure this whole file exists to prevent.
   */
  runner?: string | undefined;
  expectedRunner?: {
    /** Must equal `runner` — a mismatch is a caller bug, refused loudly. */
    id: string;
    /** Version Canary requires, from its own pin or sealed identity. */
    version?: string | undefined;
    /** sha256 of the runner's own bytes Canary requires. */
    identitySha256?: string | undefined;
  } | undefined;
  /** The per-round nonce Canary placed in the child's observer environment.
   *  Binds the frames to THIS spawn; see the python observer's note on why pid
   *  equality alone is not sufficient on Windows. */
  expectedNonce?: string | undefined;
}

/**
 * The one shared implementation used by capture (Recorder.round), the prove
 * floor (verifyArtifactSemantics re-runs it over retained bytes), and
 * verifyClassificationDerivation — the re-derivation contract REQUIRES one
 * implementation, not three. Pure: no fs, no env, no Date.
 */
export function validateObservation(v: ValidateInput): ExecutionObservation {
  const framesSha256 = sha256hex(v.raw);
  const count = (v.raw === '' ? 0 : v.raw.replace(/\n$/, '').split('\n').length);
  const base = { framesSha256, frameCount: count, observedFailingIdentities: [] as string[] };
  // Provider-neutral identity carrier: mocha rounds keep emitting only the
  // mocha fields (so every existing iff-rule and bundle stays byte-identical),
  // and a non-mocha round emits the neutral ones.
  const chan = v.runner !== undefined
    ? {
        runner: v.runner,
        ...(v.expectedRunner?.version !== undefined ? { expectedRunnerVersion: v.expectedRunner.version } : {}),
        ...(v.expectedRunner?.identitySha256 !== undefined ? { expectedRunnerIdentitySha256: v.expectedRunner.identitySha256 } : {}),
        ...(v.observedRunnerIdentitySha256 !== undefined ? { observedRunnerIdentitySha256: v.observedRunnerIdentitySha256 } : {}),
      }
    : {};
  const bad = (invalidReason: string): ExecutionObservation => ({
    ...base, ...chan, status: 'INVALID', invalidReason,
    ...(v.expectedMochaVersion !== undefined ? { expectedMochaVersion: v.expectedMochaVersion } : {}),
    ...(v.observedRunnerTreeSha256 !== undefined ? { observedRunnerTreeSha256: v.observedRunnerTreeSha256 } : {}),
  });
  const located = v.observedRunnerTreeSha256 !== undefined
    ? { observedRunnerTreeSha256: v.observedRunnerTreeSha256 } : {};
  const versioned = v.expectedMochaVersion !== undefined
    ? { expectedMochaVersion: v.expectedMochaVersion } : {};

  // ── Not injected: Canary attempted nothing. Stray bytes on the tripwire
  // pipe are forensic (protocol-emulation attempt) but corrupt nothing that
  // was being measured — ABSENT with an anomaly note (panel decision A).
  if (!v.injected) {
    return v.raw === ''
      ? { ...base, ...chan, ...located, status: 'ABSENT', absentKind: v.absentKind }
      : { ...base, ...chan, ...located, status: 'ABSENT', absentKind: v.absentKind,
        strayFd3Bytes: true, strayFd3Sha256: framesSha256 };
  }

  // ── Injected rounds MUST produce a clean stream. Anything else is INVALID.
  if (v.truncated) return bad('flood-truncated');
  if (v.raw === '') return bad('empty-stream'); // preload never loaded, or fd 3 died early

  const lines = v.raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const frames: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let f: unknown;
    try { f = JSON.parse(line); } catch { return bad('unparseable-frame'); }
    if (typeof f !== 'object' || f === null) return bad('frame-not-object');
    const kind = (f as { k?: unknown }).k;
    if (typeof kind !== 'string' || !KNOWN_KINDS.includes(kind)) return bad('unknown-frame-kind');
    frames.push(f as Record<string, unknown>);
  }

  const hello = frames[0]!;
  const bye = frames[frames.length - 1]!;
  if (frames.length < 2 || hello.k !== 'hello' || bye.k !== 'bye') return bad('hello-bye-boundary');
  if (frames.some((f, i) => f.k === 'hello' && i !== 0)) return bad('duplicate-hello');
  if (frames.some((f, i) => f.k === 'bye' && i !== frames.length - 1)) return bad('duplicate-bye');
  // reject frames: the adapter caught a forged event LIVE (a pass whose Test
  // object Canary never watched run, or a dup) — the round is evidence of an
  // ATTACK, not of execution. Fail closed.
  if (frames.some((f) => f.k === 'reject')) return bad('rejected-event');
  if (frames.some((f) => f.k === 'adapter-error')) return bad('adapter-error'); // our hook broke: never trust

  const ov = typeof hello.observerVersion === 'string' ? hello.observerVersion : '';
  if (ov !== OBSERVER_VERSION) return bad('observerVersion-mismatch'); // loaded bytes are not our current observer

  // ── Channel identity. Mocha's rules are byte-for-byte what they always were
  // (an absent `runner` field means the mocha channel); a provider-neutral round
  // states its own requirement and is bound by it.
  let observedRunnerVersion: string | undefined;
  if (v.runner === undefined) {
    const mv = typeof hello.mochaVersion === 'string' ? hello.mochaVersion : '';
    const nv = typeof hello.node === 'string' ? hello.node : '';
    const pid = typeof hello.pid === 'number' ? hello.pid : NaN;
    if (!/^\d+\.\d+\.\d+[^\s]*$/.test(mv)) return bad('hello-mochaVersion');
    if (!/^v?\d+\./.test(nv)) return bad('hello-node');
    if (!Number.isInteger(pid) || v.childPid === undefined || pid !== v.childPid) return bad('pid-mismatch');
    if (v.expectedMochaVersion !== undefined && mv !== v.expectedMochaVersion) return bad('mochaVersion-vs-pin');
  } else {
    const er = v.expectedRunner;
    // An adapter round MUST state what it required: "observed something" is not
    // a requirement, and accepting it would be the text-trust failure again.
    if (er === undefined || er.id !== v.runner) return bad('runner-requirement-missing');
    const rid = typeof hello.runner === 'string' ? hello.runner : '';
    if (rid !== er.id) return bad('runner-mismatch');
    const rv = typeof hello.runnerVersion === 'string' ? hello.runnerVersion : '';
    if (!/^\d+\.\d+/.test(rv)) return bad('hello-runnerVersion');
    if (er.version !== undefined && rv !== er.version) return bad('runnerVersion-vs-seal');
    observedRunnerVersion = rv;
    const nv = typeof hello.node === 'string' ? hello.node : '';
    if (!/^[A-Za-z]/.test(nv)) return bad('hello-host');
    // Process binding: the NONCE Canary put in THIS spawn's observer environment
    // must round-trip, and the reporting process must be the spawned one or its
    // direct child (a Windows virtualenv's python.exe re-executes the base
    // interpreter, so pid equality alone would reject every legitimate venv).
    if (v.expectedNonce !== undefined) {
      const nonce = typeof hello.nonce === 'string' ? hello.nonce : '';
      if (nonce !== v.expectedNonce) return bad('nonce-mismatch');
    }
    const pid = typeof hello.pid === 'number' ? hello.pid : NaN;
    const ppid = typeof hello.ppid === 'number' ? hello.ppid : NaN;
    if (v.childPid === undefined || (!Number.isInteger(pid) && !Number.isInteger(ppid))) return bad('pid-mismatch');
    if (pid !== v.childPid && ppid !== v.childPid) return bad('pid-mismatch');
    // The runner's own bytes, required vs as hashed on disk by Canary.
    if (er.identitySha256 !== undefined && v.observedRunnerIdentitySha256 !== er.identitySha256) {
      return bad('runner-identity-drift');
    }
  }

  // ── Canary's own replay of the lifecycle stream — the authority for counts
  // and identities. bye.counts must agree with it, never replace it.
  let passing = 0; let failing = 0; let pending = 0;
  const failIds: string[] = [];
  const seenPass = new Set<string>();
  // The duplicate-pass key. `id` alone is the test's NAME, which two distinct
  // tests in one file may legitimately share (mocha's channel emits full nested
  // titles; node:test's reporter receives leaf names, measured). A channel that
  // can name a test more precisely adds `tid`/`file`, and keying on them keeps
  // the anti-replay rule exact: a REPLAYED pass carries the same tid and file and
  // is still refused, while two genuinely different tests are not conflated into
  // a false `duplicate-pass`. Mocha frames carry neither field, so its key is
  // byte-for-byte what it always was.
  const passKey = (f: Record<string, unknown>): string =>
    String(f.id ?? '') + '\0' + String(f.file ?? '') + '\0' + String(f.tid ?? '');
  for (let i = 1; i < frames.length - 1; i++) {
    const f = frames[i]!;
    const kind = f.k as string;
    const id = typeof f.id === 'string' ? f.id : '';
    if (kind === 'pass' || kind === 'pending' || kind === 'fail' || kind === 'retry') {
      if (id === '') return bad('event-missing-identity');
    }
    if (kind === 'pass') {
      const key = passKey(f);
      if (seenPass.has(key)) return bad('duplicate-pass');
      seenPass.add(key);
      passing += 1;
    } else if (kind === 'fail') {
      failing += 1;
      if (f.hook !== true) failIds.push(id);
    } else if (kind === 'pending') {
      pending += 1;
    } else if (kind === 'retry') {
      seenPass.delete(passKey(f));
    }
  }
  const bc = (bye.counts ?? {}) as Record<string, unknown>;
  if (bc.pass !== passing || bc.fail !== failing || bc.pending !== pending) return bad('bye-vs-recount');

  // ── Exit consistency (panel D, capture mirror): what mocha's exit code
  // claims about failures must match what we watched. -1 (killed) is exempt
  // BY DESIGN (post-glm F6b): a kill's exit code claims nothing about tests,
  // and the observation must say what was really watched — the authoritative
  // veto is classification rule 1's unconditional 'killed or signal death',
  // NOT an observation lie here. (Both directions pinned by F6b tests.)
  if (v.exitCode !== -1 && failing === 0 && v.exitCode !== 0) return bad('exit-contradiction-nonzero');
  if (failing > 0 && v.exitCode === 0) return bad('exit-contradiction-masked');

  // ── Agreement with the printed summary (post-sol RB-2: one evidence
  // contract; `?? 0` per audit-F1's omits-zero-lines semantics — a genuine
  // mocha run agrees with itself on BOTH channels, so this can only ever
  // reject prose that does not match watched execution).
  if (!v.hasSummary) return bad('no-summary');
  if ((v.textCounts.passing ?? 0) !== passing) return bad('passing-vs-text');
  if ((v.textCounts.failing ?? 0) !== failing) return bad('failing-vs-text');
  if ((v.textCounts.pending ?? 0) !== pending) return bad('pending-vs-text');
  const a = [...new Set(failIds)].sort().join('\n');
  const b = [...new Set(v.textFailingNames)].sort().join('\n');
  if (a !== b) return bad('identities-vs-text');

  return {
    ...base,
    ...chan,
    ...versioned,
    status: 'VALID',
    ...(v.runner === undefined
      ? { observedMochaVersion: typeof hello.mochaVersion === 'string' ? hello.mochaVersion : '' }
      : { runner: v.runner, ...(observedRunnerVersion !== undefined ? { observedRunnerVersion } : {}) }),
    ...(v.expectedRunnerTreeSha256 !== undefined ? { expectedRunnerTreeSha256: v.expectedRunnerTreeSha256 } : {}),
    ...(v.observedRunnerTreeSha256 !== undefined ? { observedRunnerTreeSha256: v.observedRunnerTreeSha256 } : {}),
    observedCounts: { passing, failing, pending },
    observedFailingIdentities: [...new Set(failIds)].sort(),
  };
}
