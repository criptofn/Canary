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
  /** Text channel (agreement checks; `?? 0` semantics mirror audit-F1 —
   *  a summary line mocha omits parses to undefined, credited as 0). */
  textCounts: { passing?: number | undefined; failing?: number | undefined; pending?: number | undefined };
  hasSummary: boolean;
  textFailingNames: readonly string[];
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
  const bad = (invalidReason: string): ExecutionObservation => ({
    ...base, status: 'INVALID', invalidReason,
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
      ? { ...base, ...located, status: 'ABSENT', absentKind: v.absentKind }
      : { ...base, ...located, status: 'ABSENT', absentKind: v.absentKind,
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

  const mv = typeof hello.mochaVersion === 'string' ? hello.mochaVersion : '';
  const nv = typeof hello.node === 'string' ? hello.node : '';
  const ov = typeof hello.observerVersion === 'string' ? hello.observerVersion : '';
  const pid = typeof hello.pid === 'number' ? hello.pid : NaN;
  if (!/^\d+\.\d+\.\d+[^\s]*$/.test(mv)) return bad('hello-mochaVersion');
  if (!/^v?\d+\./.test(nv)) return bad('hello-node');
  if (ov !== OBSERVER_VERSION) return bad('observerVersion-mismatch'); // loaded bytes are not our current observer
  if (!Number.isInteger(pid) || v.childPid === undefined || pid !== v.childPid) return bad('pid-mismatch');
  if (v.expectedMochaVersion !== undefined && mv !== v.expectedMochaVersion) return bad('mochaVersion-vs-pin');

  // ── Canary's own replay of the lifecycle stream — the authority for counts
  // and identities. bye.counts must agree with it, never replace it.
  let passing = 0; let failing = 0; let pending = 0;
  const failIds: string[] = [];
  const seenPass = new Set<string>();
  for (let i = 1; i < frames.length - 1; i++) {
    const f = frames[i]!;
    const kind = f.k as string;
    const id = typeof f.id === 'string' ? f.id : '';
    if (kind === 'pass' || kind === 'pending' || kind === 'fail' || kind === 'retry') {
      if (id === '') return bad('event-missing-identity');
    }
    if (kind === 'pass') {
      const key = id + '\0' + String(f.file ?? '');
      if (seenPass.has(key)) return bad('duplicate-pass');
      seenPass.add(key);
      passing += 1;
    } else if (kind === 'fail') {
      failing += 1;
      if (f.hook !== true) failIds.push(id);
    } else if (kind === 'pending') {
      pending += 1;
    } else if (kind === 'retry') {
      seenPass.delete(id + '\0' + String(f.file ?? ''));
    }
  }
  const bc = (bye.counts ?? {}) as Record<string, unknown>;
  if (bc.pass !== passing || bc.fail !== failing || bc.pending !== pending) return bad('bye-vs-recount');

  // ── Exit consistency (panel D, capture mirror): what mocha's exit code
  // claims about failures must match what we watched.
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
    ...versioned,
    status: 'VALID',
    observedMochaVersion: mv,
    ...(v.expectedRunnerTreeSha256 !== undefined ? { expectedRunnerTreeSha256: v.expectedRunnerTreeSha256 } : {}),
    ...(v.observedRunnerTreeSha256 !== undefined ? { observedRunnerTreeSha256: v.observedRunnerTreeSha256 } : {}),
    observedCounts: { passing, failing, pending },
    observedFailingIdentities: [...new Set(failIds)].sort(),
  };
}
