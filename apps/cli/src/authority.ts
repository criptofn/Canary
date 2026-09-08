/**
 * M9 — authority guard (directive §9: the worker candidate must never control
 * its verifier). PROVEN FACT (tooling/probes/m9-lock-facts.mjs, measured on
 * node v26.7.0/win32): FileHandle has NO lock API, and a same-user process
 * can break anything the kernel offers anyway (kill the holder, rewrite the
 * ACL, rename the parent). So M9 makes NO prevention claim inside the window.
 * What it DOES claim, and enforces fail-closed:
 *   - the authority bytes are fingerprinted on BOTH edges of plan execution
 *     (drift between the edges ⇒ the verdict cannot be trusted);
 *   - a change can neither be scored by mutated bytes nor hide as a PASS:
 *     drift forces BLOCKED — the code path that would have said PASS is
 *     never reached;
 *   - evidence storage is authority too (§9 lists it): the WHOLE base
 *     evidence dir is fingerprinted as a tree, so a plan step cannot plant
 *     a forged PASS bundle, edit an observed one, or delete history inside
 *     the window (the M8 residual "prevention is M9's job" closes here).
 *     Canary's own writes land OUTSIDE the window — pre-execution blocks
 *     write their bundle before the snapshot is taken, the verdict bundle
 *     lands after the re-read, pruning rides with it — so no self-trigger;
 *     a CONCURRENT canary invocation inside another's window can force a
 *     false BLOCK, never a false PASS (fail-closed direction, same-user
 *     concurrency is the documented ceiling).
 * Review-hardened (this session's adversarial pass, fixes F1–F4): the
 * fingerprint set now covers the VERIFIER'S OWN CODE TREE (dist/src — every
 * byte of the import graph loads at process start, so an in-window write is
 * inert THIS run but would execute on the next one, including promote's
 * fresh re-verify); a tampering caught during/after a window also leaves a
 * persistent QUARANTINE marker (§9.5 below); the sealed-plan checks re-run
 * AFTER the window (npm re-reads the candidate's package.json at every
 * spawn, so step 1 rewriting step 2's sealed text must not slip through);
 * and the base's HEAD ref is a sandwich token (shared object/ref store means
 * a sealed step CAN move the base branch — gate 6's idempotent arm must
 * never read an attacker-moved ref as proof of a past apply).
 *
 * Detection-only ceilings, stated honestly: a change-and-revert strictly
 * between two reads cannot be seen (same limit as M8's identity sandwich);
 * an outside-the-window edit is the containment gate's pre-execution job
 * (harness entry) and every human-side job (doctor). The verdict binds the
 * bytes it read, not a promise nobody touched them afterwards.
 *
 * §9.5 QUARANTINE — a mandate is one window's memory unless it persists:
 * a byte-idempotent mutation (re-writing the same mutated bytes) re-baselines
 * clean in the NEXT window and launders into a PASS. So a during/after-
 * execution mandate stamps a marker file; verify and promote refuse to
 * judge at all while it exists; only a human re-running setup (whose fresh
 * writeConfig IS the re-seal) clears it. The marker deliberately does NOT
 * join the fingerprint list — existence short-circuits before any window
 * opens, so in-window deletion is unreachable. Same-UID ceiling, stated: the
 * code that could have restored every byte by hand can also delete the
 * marker by hand; what quarantine closes is the automated laundering path
 * (retry the same tampering verify and the mutated baseline says PASS).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** State token of one path: sha of bytes, ABSENT, or UNREADABLE:<cause> —
 *  all three are first-class states, so create/delete/replace/corrupt all
 *  compare as drift, and an unreadable file can never read as "absent"
 *  on one edge and present on the other (fail-closed by construction). */
export type AuthorityState = string;

export interface AuthorityChange { file: string; before: AuthorityState; after: AuthorityState }

export function authorityState(p: string): AuthorityState {
  try {
    if (fs.statSync(p).isDirectory()) return 'UNREADABLE:directory';
    return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ABSENT' : `UNREADABLE:${(e as NodeJS.ErrnoException).code ?? 'error'}`;
  }
}

/** Everything that changed between the snapshot and now. Same order as the
 *  input list, so bundles read deterministically. */
export function authorityDrift(before: ReadonlyMap<string, AuthorityState>, files: readonly string[]): AuthorityChange[] {
  const out: AuthorityChange[] = [];
  for (const p of files) {
    const now = authorityState(p);
    if (before.get(p) !== now) out.push({ file: p, before: before.get(p) ?? 'ABSENT', after: now });
  }
  return out;
}

export function snapshotAuthority(files: readonly string[]): Map<string, AuthorityState> {
  return new Map(files.map((p) => [p, authorityState(p)]));
}

/** Fingerprint of a WHOLE directory as rel-path → state (files only; dirs
 *  are structure). An absent dir snapshots as empty — "empty at both edges"
 *  is no drift, "had bundles, now gone" is. Depth-capped: evidence is
 *  bundle/<files>, nothing legitimate nests deeper. */
export function snapshotTree(dir: string, cap = 3, prefix = '', out = new Map<string, AuthorityState>()): Map<string, AuthorityState> {
  if (cap < 0) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; } // ENOENT/ENOTDIR/unreadable all snapshot identically at both edges → honest comparison either way
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) snapshotTree(path.join(dir, e.name), cap - 1, rel, out);
    else out.set(rel, authorityState(path.join(dir, e.name)));
  }
  return out;
}

/** Drift between a snapshotTree edge pair: planted files, edited bytes,
 *  deleted or wholly-removed bundles. Sorted keys → deterministic bundles. */
export function treeDrift(before: ReadonlyMap<string, AuthorityState>, dir: string): AuthorityChange[] {
  const now = snapshotTree(dir);
  const keys = [...new Set([...before.keys(), ...now.keys()])].sort();
  const out: AuthorityChange[] = [];
  for (const k of keys) {
    const b = before.get(k) ?? 'ABSENT';
    const n = now.get(k) ?? 'ABSENT';
    if (b !== n) out.push({ file: k, before: b, after: n });
  }
  return out;
}

/** 12 hex chars are enough to tell two states apart in human output; the
 *  bundle keeps the same display form so logs and evidence cannot diverge. */
export function shortState(s: AuthorityState): string {
  return s.startsWith('sha256:') ? `sha ${s.slice(7, 19)}` : s;
}

/** §9.5 — the quarantine marker's filename (lives under <base>/.canary/). */
export const QUARANTINE_FILE = 'authority-quarantine.json';

/** Stamp the marker after a during/after-execution mandate: a caught
 *  tampering must outlive the window that caught it, or a byte-idempotent
 *  mutation re-baselines clean next window and launders into a PASS.
 *  Best-effort by design — the STATE is the file's existence; its bytes only
 *  explain the catch. A failed write leaves the mandate + bundle standing and
 *  the next window judged on its own facts (fail-open only toward detection,
 *  never toward a verdict). */
export function stampQuarantine(p: string, when: string, changes: AuthorityChange[]): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ schema: 'canary-authority-quarantine/1', at: new Date().toISOString(), when, changes }, null, 2) + '\n');
  } catch { /* presence is the state; bytes are display — see above */ }
}

export interface QuarantineMark { at: string; when: string; changes: number }

/** Read the marker for display. null = no quarantine. 'unreadable' = present
 *  but the bytes are junk — FAIL-CLOSED: whoever can rewrite verification
 *  evidence can rewrite this file, so a garbage marker is still a marker. */
export function quarantineInfo(p: string): QuarantineMark | 'unreadable' | null {
  if (!fs.existsSync(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as { at?: unknown; when?: unknown; changes?: unknown } | null;
    if (!v || typeof v.at !== 'string' || typeof v.when !== 'string') return 'unreadable';
    return { at: v.at.slice(0, 40), when: v.when.slice(0, 64), changes: Array.isArray(v.changes) ? v.changes.length : -1 };
  } catch { return 'unreadable'; }
}
