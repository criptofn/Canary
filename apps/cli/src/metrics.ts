/**
 * 1.1 §35/§36 — model-neutral metrics, so the later benchmark campaign can
 * MEASURE instead of guess.
 *
 * The later phase compares Canary OFF vs ON vs Canary-aware across agent
 * families and wants: tokens, agent-visible output, commands, repair loops,
 * human interventions, wall time, Canary time, verification outcome, premature
 * DONE, false PASS/BLOCK. Canary can honestly supply the parts it owns
 * (commands, wall time, outcomes, output size) and must NOT pretend to supply
 * the parts it does not (token counts live in the harness, not here).
 *
 * Two rules make this safe to leave on:
 *
 *   1. **Metrics never touch a verdict.** Writing is fail-OPEN: if the target
 *      cannot be written, the command's exit code and output are unchanged. A
 *      measurement must never be able to turn a PASS into a failure or the
 *      other way round.
 *   2. **No free text escapes.** The record contains the command word and the
 *      FLAG NAMES only — never arguments, paths or task text, which is where a
 *      user's strings live. The campaign needs counts and outcomes, not a copy
 *      of the user's repository.
 *
 * Off unless `CANARY_METRICS` names a file. One JSON object per line (JSONL),
 * append-only, outside the repository by the user's choice.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const METRICS_SCHEMA = 'canary-metrics/1';

export interface MetricRecord {
  schema: string;
  at: string;
  /** The command word only ('status', 'doctor', 'setup', …). */
  command: string;
  /** Flag NAMES only, sorted — never a flag's value. */
  flags: string[];
  exitCode: number;
  /** Outcome as the process reported it, so a campaign can count false PASS/BLOCK. */
  ok: boolean;
  durationMs: number;
  canaryVersion: string;
  node: string;
  platform: string;
  /** Bytes the command wrote to each stream — the agent-visible-output proxy.
   *  null when the runtime does not expose it (never a guess). */
  stdoutBytes: number | null;
  stderrBytes: number | null;
}

/** Where records go, or null when instrumentation is off. */
export function metricsTarget(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.CANARY_METRICS?.trim();
  return v ? path.resolve(v) : null;
}

/** The command word and flag names from raw argv — the ONLY part that is safe
 *  to record. A bare (non-flag) argument is a path, a candidate name or task
 *  text, so its presence is recorded as a count, never as a value. */
export function describeInvocation(argv: readonly string[]): { command: string; flags: string[]; positionals: number } {
  const command = argv.find((a) => !a.startsWith('--')) ?? '(none)';
  const flags = argv.filter((a) => a.startsWith('--')).sort();
  const positionals = argv.filter((a) => !a.startsWith('--')).length - (command === '(none)' ? 0 : 1);
  return { command, flags, positionals: Math.max(0, positionals) };
}

function streamBytes(stream: NodeJS.WriteStream): number | null {
  const n = (stream as unknown as { bytesWritten?: unknown }).bytesWritten;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Append one record. Returns a problem string instead of throwing: the caller
 * is a command that has already decided its verdict, and a metrics failure must
 * never become that command's failure.
 */
export function appendMetric(record: MetricRecord, target: string | null): string | null {
  if (target === null) return null;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`);
    return null;
  } catch (e) {
    return `metrics not recorded: ${String((e as Error).message ?? e)}`;
  }
}

/** Build the record for one finished invocation. */
export function metricFor(
  argv: readonly string[],
  exitCode: number,
  durationMs: number,
  startedBytes: { out: number | null; err: number | null },
  canaryVersion: string,
): MetricRecord {
  const { command, flags } = describeInvocation(argv);
  const out = streamBytes(process.stdout);
  const err = streamBytes(process.stderr);
  return {
    schema: METRICS_SCHEMA,
    at: new Date().toISOString(),
    command,
    flags,
    exitCode,
    ok: exitCode === 0,
    durationMs,
    canaryVersion,
    node: process.version,
    platform: `${process.platform}/${process.arch} (${os.release()})`,
    stdoutBytes: out === null || startedBytes.out === null ? null : out - startedBytes.out,
    stderrBytes: err === null || startedBytes.err === null ? null : err - startedBytes.err,
  };
}

/** The byte counters as they stand now (null when unavailable). */
export function streamSnapshot(): { out: number | null; err: number | null } {
  return { out: streamBytes(process.stdout), err: streamBytes(process.stderr) };
}
