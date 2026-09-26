/**
 * 1.1 §18–21 — agent integration behind ONE provider-neutral contract.
 *
 * Canary's verification core must not depend on Claude-specific hooks, and it
 * must not PRETEND about an agent it cannot gate. This file is the honest
 * capability table:
 *
 *   - `gating: true`  — this integration can BLOCK a completion (a hook the
 *                       harness actually honours). Claude Code and OpenAI Codex
 *                       CLI qualify today, and both run the SAME `checkpoint`
 *                       entry point: one verification implementation, two pieces
 *                       of wiring, no fork.
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
  /**
   * v1.3 §E — is the `gating` answer MEASURED, or merely documented?
   *
   * Absent means measured (every integration that existed before this field did). `false` means the
   * harness documents a mechanism that would gate, and this project has NOT reproduced it on a real
   * install — so it is reported as UNMEASURED rather than folded into either "yes" or "no". Both of
   * those would be claims: "yes" would assert protection nobody observed, and "no" would deny a
   * mechanism the vendor documents.
   */
  gatingMeasured?: boolean;
  /**
   * v1.4 §C — a one-time act the HARNESS owns before the hook this table calls GATED will run at
   * all. Absent = none.
   *
   * Codex runs a non-managed hook only after that exact hook definition has been reviewed and
   * trusted, and it records trust against the hook's current hash; a written-but-untrusted hook is
   * skipped. That is real friction in the user's hands, and a row that said GATED without it would be
   * the overclaim this file exists to prevent — so it is carried as data and printed beside the word.
   */
  gatingNeedsTrust?: string;
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
    summary: 'completion hook installed into this project — Canary runs your project\'s own checks when the agent says it is done, and blocks once on failure',
  },
  {
    /**
     * v1.4 §C — CODEX IS GATED, AND THIS ENTRY USED TO SAY IT COULD NOT BE.
     *
     * The old summary read "ADVISORY only — no completion hook exists to gate". MEASURED on this host
     * (2026-09-20): `codex --version` → `codex-cli 0.154.0`, `codex features list` → `hooks  stable
     * true`, `--help` exposes `--dangerously-bypass-hook-trust`, and the vendor's hook reference
     * documents a `Stop` event whose contract is the SAME one `cmdCheckpoint` already implements for
     * Claude Code: one JSON object on stdin (`cwd`, `stop_hook_active`), JSON on stdout,
     * `{"decision":"block","reason"}` to CONTINUE the turn with that reason as the next prompt, and
     * exit 0 with no output to let it stop. `canary setup` therefore writes a `Stop` handler into
     * `.codex/hooks.json` — the SAME command, from the SAME `buildHookCommand` — and the run that
     * gates is the same `canary checkpoint`, so the hook gains no authority it did not have.
     *
     * `gatingMeasured: true` is a claim about EVIDENCE, and the evidence is
     * `tooling/probes/v14-codex-stop-hook.mjs`: the hook driven exactly as Codex documents it
     * (stdin event → stdout decision, pass → silent allow, fail → parsed `decision: "block"`), plus a
     * real `codex exec` session in a temp repository in which Codex executed this hook and continued
     * the turn on its reason. If that run is not reproducible on a host — and the probe says so with
     * an explicit SKIP rather than a pass — the honest reading stays "the adapter is written; gating
     * is UNMEASURED there", and this field is what a reader must check before quoting "GATED".
     *
     * The one thing Canary does NOT own is stated in the summary and in `gatingNeedsTrust`: Codex
     * runs a non-managed hook only after that hook definition has been reviewed and trusted once, so
     * until the user takes that step the file is written and nothing is gated.
     */
    id: 'codex',
    label: 'OpenAI Codex CLI',
    gating: true,
    gatingMeasured: true,
    // v1.5 §4B — the trust step said WHAT to do (`/hooks`) but not WHAT you are approving, WHAT
    // Canary changes, or HOW to undo it. All three fit in one clause each; none of them is a
    // mechanism change, and the gate is untouched: the hook still runs `canary checkpoint`, which
    // can only run this repository's own sealed checks and send the agent back once.
    gatingNeedsTrust: 'Codex runs a project hook only after a one-time review and trust (`/hooks`) — until then the hook is written but gates nothing. What you approve is one Stop hook running `canary checkpoint`: it runs this repository\'s own checks and can only send the agent back to repair a failure — no permissions widen and no other Codex setting changes. `canary uninstall` removes it again',
    detectFiles: ['.codex', 'AGENTS.md'],
    detectExe: ['codex'],
    summary: 'completion hook installed into this project (.codex/hooks.json) — Canary runs your project\'s own checks when a Codex turn ends and sends the agent back to work once when they fail; Codex requires a one-time hook-trust review (`/hooks`) before it will run the hook, so an untrusted hook gates nothing',
  },
  {
    // v1.3 §E — CURSOR, reported as UNMEASURED rather than as anything stronger or weaker.
    //
    // What Cursor's own documentation says: it loads Claude Code hooks from `.claude/settings.json`
    // (including `Stop` → `stop`, honoured as an automatic follow-up) with third-party imports on by
    // default, which WOULD make the hook Canary already installs a completion gate. It also documents
    // no way to remove its native tools, so Canary cannot put Cursor's own edits inside a boundary.
    //
    // What this project has NOT done: reproduced the hook import on a real Cursor install. Cursor's
    // `stop` input is documented as `{status, loop_count}` — Canary derives the repository from
    // `input.cwd` and keys its one-repair guard on `stop_hook_active`, and whether Cursor synthesises
    // those for imported Claude hooks is undocumented. So the completion-gate question is answered
    // "unmeasured", and the confinement question is answered "no, and not claimed".
    id: 'cursor',
    label: 'Cursor',
    gating: false,
    gatingMeasured: false,
    detectFiles: ['.cursor'],
    detectExe: ['cursor'],
    summary: 'UNMEASURED completion gate — Cursor documents importing Claude Code hooks (including Stop), which would make the hook Canary installs effective there, but this project has not reproduced that on a real Cursor install, so it is NOT claimed. Cursor also documents no way to remove its native tools, so Canary cannot confine Cursor\'s own edits.',
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
    // recorded Canary configuration CHEAPER than working without Canary: 83.21% of plain over the three
    // token fixtures in the v1.5 fully-accounted two-run measurement — which INCLUDES the standing MCP
    // payload, unlike the historical 92.7% it replaces (that one excluded it and is not comparable).
    // Equal correctness, no false done — while the ceremony arm (`canary work` → `finish`) cost 177.8%.
    // Per task the v1.5 range is +43.8% MORE expensive to -38.7% cheaper, and the plain arm itself
    // drifted 27% between the two runs: the DIRECTION is measured, the SIZE is not stable (n=1 per cell).
    // The reliability half is deliberate and comes from the repository's own
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
