/**
 * THE FAILURE PAYLOAD — the smallest thing an agent can act on.
 *
 * WHY THIS EXISTS, in the owner's terms: "the worker model should NOT spend tokens operating
 * Canary … on failure, return the smallest actionable payload possible". Measured before this:
 * a checkpoint block sent the model up to **4000 characters of raw runner output** plus prose,
 * because there was nowhere else for that output to live. The model then often re-ran the suite
 * to see more — paying twice for the same bytes.
 *
 * So the payload now carries only what a repair needs:
 *
 *   Canary verification failed: tests (node run-tests.js, exit 1). Fix this before finishing.
 *   tests/numbers.test.js :: total includes negative values
 *     expected 5, got 0
 *   full output: <path>
 *
 * The FULL stdout/stderr is written next to the evidence bundle and referred to by path, so a
 * human (or a model that explicitly asks) can still read everything. Nothing is hidden; the
 * model is simply not forced to pay for it.
 *
 * WHAT THIS FILE IS NOT: it is not a second verdict path. It runs only AFTER Canary has already
 * decided a block from checks it executed itself, and it can only ever shorten the message —
 * the exit codes and the logs are the evidence, and this is presentation.
 */

import { stripVTControlCharacters } from 'node:util';

/** One failing step, as the checkpoint path already has it. */
export interface FailingStep {
  /** Exact sealed step key, when the caller has the plan. */
  id?: string;
  kind: string;
  display: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Bounds, so one pathological log cannot become a 40k-token message. */
export const MAX_IDENTITIES_PER_CHECK = 3;
export const MAX_DETAIL_LINES_PER_CHECK = 2;
export const MAX_CHECKS = 3;
export const MAX_LINE_CHARS = 160;
export const MAX_TOTAL_CHARS = 1200;

const clip = (s: string, max = MAX_LINE_CHARS): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const VITEST_FAILURE = /^\s*FAIL\s+(\S+\.[A-Za-z0-9]+(?:\s*>\s*.+?|\s+\[\s+.+?\s+\]))\s*$/;

/**
 * Failing-test identities, best-effort, from the shapes the runners Canary supports actually
 * print. Best-effort is the honest description: this is a DISPLAY aid, the log path is the
 * authority. Each pattern is one real format:
 *   `not ok 1 - some test`            TAP (node:test)
 *   `✖ some test (1.23ms)`            node:test's SPEC reporter — `node --test`'s DEFAULT output
 *   `  1) some test`                  mocha
 *   `FAILED tests/x.py::test_y - ...` pytest short summary
 *   `file.test.js :: some test`       the repository's own plain-reporting runners
 *   `FAIL file.test.ts > suite > test` Vitest's detailed failure block
 */
export function extractFailureIdentities(text: string, limit = MAX_IDENTITIES_PER_CHECK): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /^\s*not ok \d+\s*-\s*(.+?)\s*$/,
    // MEASURED (v1.5 clean-room first run, `node --test` on a Node project): without this
    // pattern a failing spec-reporter run reached the agent with NO test name at all —
    // only `AssertionError ... actual: 'hello, Ada!'` — while README promises the block "names
    // the check and the failing test". The `(…ms)` duration anchor is load-bearing: node also
    // prints the header `✖ failing tests:`, which is a heading, not an identity.
    /^\s*\u2716\s+(.+?)\s*\(\d+(?:\.\d+)?\s*ms\)\s*$/,
    /^\s*\d+\)\s+(.+?)\s*$/,
    /^(?:FAILED|ERROR)\s+(\S+)/,
    /^\s*(\S+\.[A-Za-z0-9]+)\s*::\s*(.+?)\s*$/,
    VITEST_FAILURE,
  ];
  for (const line of stripVTControlCharacters(text).split(/\r?\n/)) {
    for (const re of patterns) {
      const m = re.exec(line);
      if (m === null) continue;
      const id = (m[2] ?? m[1] ?? '').trim();
      if (id === '' || seen.has(id)) break;
      seen.add(id);
      out.push(clip(id));
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The most informative short lines: the assertion/error lines a repair usually needs, and
 * nothing else. Kept deliberately narrow — a wrong "helpful" line costs more than it saves.
 */
export function extractDetailLines(text: string, limit = MAX_DETAIL_LINES_PER_CHECK): string[] {
  const out: string[] = [];
  const lines = stripVTControlCharacters(text).split(/\r?\n/);
  // Vitest can print expected caught errors from PASSING tests before its failure blocks.
  // Start at the actual first FAIL block so those diagnostics do not misdirect a repair.
  const firstFailure = lines.findIndex((line) => VITEST_FAILURE.test(line));
  for (const raw of firstFailure < 0 ? lines : lines.slice(firstFailure + 1)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!/^(?:E\s|expected|actual|AssertionError|Error:|TypeError|ReferenceError|SyntaxError|❯\s+\S+:\d+(?::\d+)?(?:\s|$)|.*!==.*|.*expected .* got .*)/i.test(line)) continue;
    if (/^at\s/.test(line)) continue;
    out.push(clip(line));
    if (out.length >= limit) break;
  }
  return out;
}

export interface FailurePayloadInput {
  steps: readonly FailingStep[];
  /** Writes the full text somewhere durable and returns its path, or null when it could not. */
  writeLog: (name: string, text: string) => string | null;
  /** Prefix of this installation's CLI, or null when no shell-safe command can be formed. */
  doctorCommandPrefix?: string | null;
}

/** Display command: PowerShell on Windows, POSIX shell elsewhere. Never splice a scope into code. */
export function doctorCheckCommand(id: string, platform = process.platform, commandPrefix = 'canary'): string {
  const arg = /^[A-Za-z0-9_./:-]+$/.test(id) ? id
    : platform === 'win32' ? `'${id.replace(/'/g, "''")}'` : `'${id.replace(/'/g, "'\\''")}'`;
  return `${commandPrefix} doctor --check ${arg}`;
}

/**
 * Build the compact reason. Deterministic: same failure, same message.
 */
export function buildFailurePayload({ steps, writeLog, doctorCommandPrefix }: FailurePayloadInput): string {
  const commandPrefix = doctorCommandPrefix === undefined ? 'canary' : doctorCommandPrefix;
  const failing = steps.slice(0, MAX_CHECKS).map((step, i) => {
    const text = `${step.stdout}\n${step.stderr}`;
    const kind = /^[a-z][a-z0-9-]{0,31}$/.test(step.kind) ? step.kind : 'step';
    return { step, text, log: writeLog(`${i + 1}-${kind}`, text) };
  });
  // Remove excerpts, then describe fewer checks, rather than chopping through a command or path.
  // All failures remain in the verification bundle; every displayed link is intact.
  for (let count = failing.length; count > 0; count -= 1) {
    for (const details of [true, false]) {
      const shown = failing.slice(0, count);
      const head = `Canary verification failed: ${shown
        .map(({ step: f }) => `${clip(f.kind, 32)} (${clip(f.display)}${f.exitCode === null ? ', could not run' : `, exit ${f.exitCode}`})`)
        .join('; ')}. Fix this before finishing.`;
      const blocks = shown.map(({ step, text, log }) => [
        ...(details ? [...extractFailureIdentities(text), ...extractDetailLines(text).map((d) => `  ${d}`)] : []),
        ...(step.id === undefined ? [] : [commandPrefix === null
          ? '  focused recheck after repair: use the configured Canary MCP canary_doctor(check) tool'
          : `  focused recheck after repair: ${doctorCheckCommand(step.id, process.platform, commandPrefix)}`]),
        `  full output: ${log ?? 'unavailable (evidence storage failed)'}`,
      ].join('\n'));
      const extra = steps.length > count
        ? `\nAdditional failing checks: ${steps.length - count}. ${commandPrefix === null
          ? 'See the full output logs above for the evidence bundle.'
          : `Run ${commandPrefix} result --json for the evidence bundle.`}` : '';
      const message = `${head}\n${blocks.join('\n')}${extra}`;
      if (message.length <= MAX_TOTAL_CHARS) return message;
    }
  }
  const fallback = commandPrefix === null
    ? 'The installed CLI path cannot be safely quoted for a shell command; use the configured Canary MCP diagnostics or inspect the saved logs.'
    : `run ${commandPrefix} result --json for the evidence bundle, or ${commandPrefix} doctor for the full gate.`;
  return `Canary verification failed: ${clip(steps[0]?.kind ?? 'checks', 32)}. Fix this before finishing.\n` +
    `Full output and recheck details exceed the message limit; ${fallback}`;
}
