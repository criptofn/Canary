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

/** One failing step, as the checkpoint path already has it. */
export interface FailingStep {
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

/**
 * Failing-test identities, best-effort, from the shapes the runners Canary supports actually
 * print. Best-effort is the honest description: this is a DISPLAY aid, the log path is the
 * authority. Each pattern is one real format:
 *   `not ok 1 - some test`            TAP (node:test)
 *   `  1) some test`                  mocha
 *   `FAILED tests/x.py::test_y - ...` pytest short summary
 *   `file.test.js :: some test`       the repository's own plain-reporting runners
 */
export function extractFailureIdentities(text: string, limit = MAX_IDENTITIES_PER_CHECK): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /^\s*not ok \d+\s*-\s*(.+?)\s*$/,
    /^\s*\d+\)\s+(.+?)\s*$/,
    /^(?:FAILED|ERROR)\s+(\S+)/,
    /^\s*(\S+\.[A-Za-z0-9]+)\s*::\s*(.+?)\s*$/,
  ];
  for (const line of text.split(/\r?\n/)) {
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
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!/^(?:E\s|expected|actual|AssertionError|Error:|TypeError|ReferenceError|SyntaxError|.*!==.*|.*expected .* got .*)/i.test(line)) continue;
    if (/^at\s/.test(line)) continue;
    out.push(clip(line));
    if (out.length >= limit) break;
  }
  return out;
}

export interface FailurePayloadInput {
  steps: readonly FailingStep[];
  /** Writes the full text somewhere durable and returns its path, or null when it could not. */
  writeLog: (kind: string, text: string) => string | null;
}

/**
 * Build the compact reason. Deterministic: same failure, same message.
 */
export function buildFailurePayload({ steps, writeLog }: FailurePayloadInput): string {
  const failing = steps.slice(0, MAX_CHECKS);
  const head = `Canary verification failed: ${failing
    .map((f) => `${f.kind} (${f.display}${f.exitCode === null ? ', could not run' : `, exit ${f.exitCode}`})`)
    .join('; ')}. Fix this before finishing.`;

  const blocks: string[] = [];
  for (const f of failing) {
    const text = `${f.stdout}${f.stderr}`;
    const lines: string[] = [];
    for (const id of extractFailureIdentities(text)) lines.push(id);
    for (const d of extractDetailLines(text)) lines.push(`  ${d}`);
    const log = writeLog(f.kind, text);
    lines.push(`  full output: ${log ?? 'unavailable (evidence storage failed)'}`);
    blocks.push(lines.join('\n'));
  }
  const body = blocks.join('\n');
  const message = `${head}\n${body}`;
  return message.length <= MAX_TOTAL_CHARS ? message : `${message.slice(0, MAX_TOTAL_CHARS - 1)}…`;
}
