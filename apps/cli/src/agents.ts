/**
 * 1.1 §18–21 — agent integration behind ONE provider-neutral contract.
 *
 * Canary's verification core must not depend on Claude-specific hooks, and it
 * must not PRETEND about an agent it cannot gate. This file is the honest
 * capability table:
 *
 *   - `gating: true`  — this integration can BLOCK a completion (a hook the
 *                       harness actually honours). Only Claude Code qualifies
 *                       today, and its wiring implementation stays where it is
 *                       (one implementation, no fork).
 *   - `gating: false` — the integration is REAL but ADVISORY: it tells the
 *                       agent to consult Canary and gives it a compact,
 *                       machine-readable answer, but nothing can block a
 *                       completion the harness does not gate. Reported as
 *                       advisory, never as protection.
 *   - `available: false` — detected but not integrable at all.
 *
 * Every agent that can run a command already has the strongest portable
 * integration Canary can offer (`canary result --json` / `canary doctor
 * --json`); this table exists so nobody has to guess which of them can also be
 * *enforced*.
 *
 * The advisory integration writes a marked block into the project's AGENTS.md.
 * It is only ever installed by an explicit command, it is idempotent, it is
 * removable by one command, and it is containment-checked like every other file
 * Canary writes.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AgentIntegration {
  id: string;
  label: string;
  /** Can this integration BLOCK a completion, or only advise? */
  gating: boolean;
  /** Files whose presence means "this agent works here" (root-relative). */
  detectFiles: readonly string[];
  /** Executables that mean the same, looked for in the same trusted way the
   *  rest of Canary resolves programs (never PATH at verification time). */
  detectExe: readonly string[];
  /** What the human should know, in one line, with no overclaiming. */
  summary: string;
}

export const AGENT_INTEGRATIONS: readonly AgentIntegration[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    gating: true,
    detectFiles: ['.claude'],
    detectExe: ['claude'],
    summary: 'completion hook installed into this project — Canary runs the sealed checks when the agent says it is done, and blocks once on failure',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    gating: false,
    detectFiles: ['.codex', 'AGENTS.md'],
    detectExe: ['codex'],
    summary: 'ADVISORY only — no completion hook exists to gate, so Canary instructs the agent (marked block in AGENTS.md) and answers it with `canary result --json`',
  },
  {
    id: 'generic',
    label: 'Any command-line agent',
    gating: false,
    detectFiles: [],
    detectExe: [],
    summary: 'ADVISORY — the machine-readable protocol (`canary result --json`, `canary doctor --json`) and the expert commands are the integration',
  },
];

export const ADVISORY_BEGIN = '<!-- canary:advisory:v1 — installed by `canary agents install`; remove with `canary agents uninstall` -->';
export const ADVISORY_END = '<!-- /canary:advisory -->';

/** The exact text the advisory integration adds. It must be TRUE for an agent
 *  that cannot be gated: it says who owns the verdict, what to run, and what
 *  NOT to claim. */
export function advisoryBlock(): string {
  return [
    ADVISORY_BEGIN,
    '## Canary verification (read before claiming completion)',
    '',
    'Canary owns objective verification in this repository. Do not declare work',
    'finished from your own reasoning, and do not restate test output as proof:',
    '',
    '1. `canary result --json` — what Canary knows right now (compact, no logs).',
    '2. `canary doctor --json` — actually run the sealed checks and report the verdict.',
    '3. If the checks fail, fix exactly what was reported and run doctor again.',
    '',
    'Read `status`/`problems`/`next` from the JSON envelope. Full evidence stays in',
    'the files the envelope names — do not paste logs into the conversation.',
    'A `PASS`-like statement is only meaningful when it comes from those commands.',
    '',
    // v1.3 §A — the instruction that was MEASURED. The `guarded` arm (agent works
    // normally, told that verification is automatic and that it will be told what to fix) is the only
    // recorded Canary configuration CHEAPER than working without Canary: 92.7% of plain over the three
    // token fixtures, equal correctness, no false done — while the ceremony arm (`canary work` →
    // `finish`) cost 177.8%. The reliability half is deliberate and comes from the repository's own
    // measurement: the AGGRESSIVE variant ("do not run the checks yourself") produced a false done and
    // a false green, so the model keeps the decision to verify and only loses the repetition.
    '**Verification here is AUTOMATIC.** Finish when you believe the work is done:',
    'the sealed checks run for you and you will be told exactly what to fix. So do',
    'not re-read output you have already seen, and do not repeat a check you have just run.',
    'Ask `canary doctor` for the verdict instead of re-deriving it yourself.',
    'You may and should still check when you are unsure, when you changed behaviour',
    'the existing checks may not cover, or before finishing a change you cannot',
    'fully reason about: being right matters more than being quick.',
    '',
    ADVISORY_END,
  ].join('\n');
}

/** Refuse to write through a link: a linked AGENTS.md could send this write
 *  outside the repository (the same one rule every other Canary write follows). */
function plainTarget(file: string): boolean {
  try {
    return !fs.lstatSync(file).isSymbolicLink();
  } catch {
    return true; // absent is fine
  }
}

export type AdvisoryResult = { ok: true; changed: boolean; file: string } | { ok: false; problem: string };

/** Install the advisory block into the project's AGENTS.md, idempotently:
 *  re-running replaces the marked block in place, preserves the file's own line
 *  endings, and leaves every other byte alone. */
export function installAdvisory(root: string): AdvisoryResult {
  const file = path.join(root, 'AGENTS.md');
  if (!plainTarget(file)) return { ok: false, problem: 'AGENTS.md is a link — Canary will not write through links' };
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = ''; }
  const nl = current.includes('\r\n') ? '\r\n' : '\n'; // match the file being edited
  const block = advisoryBlock().split('\n').join(nl);
  const start = current.indexOf(ADVISORY_BEGIN);
  const end = current.indexOf(ADVISORY_END);
  let next: string;
  if (start >= 0 && end > start) {
    // replace in place: keep the prefix and anything the user wrote after the
    // block, and keep the SAME trailing newline the fresh-install path leaves,
    // so installing twice is byte-identical.
    const rest = current.slice(end + ADVISORY_END.length).replace(/^\r?\n/, '');
    next = current.slice(0, start) + block + (rest.length > 0 ? rest : nl);
  } else {
    const trimmed = current.replace(/\s*$/, '');
    next = trimmed.length > 0 ? `${trimmed}${nl}${nl}${block}${nl}` : `${block}${nl}`;
  }
  if (next === current) return { ok: true, changed: false, file };
  try { fs.writeFileSync(file, next); } catch (e) { return { ok: false, problem: `AGENTS.md could not be written: ${String((e as Error).message ?? e)}` }; }
  return { ok: true, changed: true, file };
}

/** Remove exactly the marked block and nothing else. */
export function removeAdvisory(root: string): AdvisoryResult {
  const file = path.join(root, 'AGENTS.md');
  if (!plainTarget(file)) return { ok: false, problem: 'AGENTS.md is a link — Canary will not write through links' };
  let current: string;
  try { current = fs.readFileSync(file, 'utf8'); } catch { return { ok: true, changed: false, file }; } // nothing to remove
  const start = current.indexOf(ADVISORY_BEGIN);
  const end = current.indexOf(ADVISORY_END);
  if (start < 0 || end <= start) return { ok: true, changed: false, file };
  const rest = current.slice(end + ADVISORY_END.length).replace(/^\r?\n/, '');
  const prefix = current.slice(0, start).replace(/\n+$/, '\n'); // drop the blank line the block added
  const next = rest.length > 0 ? prefix + rest : prefix;
  try { fs.writeFileSync(file, next); } catch (e) { return { ok: false, problem: `AGENTS.md could not be written: ${String((e as Error).message ?? e)}` }; }
  return { ok: true, changed: true, file };
}

export function hasAdvisory(root: string): boolean {
  try {
    const text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    return text.includes(ADVISORY_BEGIN) && text.includes(ADVISORY_END);
  } catch { return false; }
}
