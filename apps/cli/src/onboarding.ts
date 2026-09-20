/**
 * Productization surface: `canary setup | doctor | uninstall | checkpoint`.
 *
 * Doctrine (the NO PROOF, NO DONE rule applied to onboarding itself):
 *  - Verdict vocabulary is exactly READY / NEEDS ATTENTION / UNSUPPORTED.
 *    READY is printed ONLY when the protection wiring was verified to exist
 *    AND the detected checks were executed and passed in this setup run.
 *    Nothing was ever executed => not READY. A guessed command that was never
 *    disclosed is never run silently.
 *  - This path is the honest "verification-plan runner": it executes the
 *    project's own declared scripts at the harness completion boundary and
 *    records local evidence. It is a DIFFERENT promise from the attested
 *    proof pipeline (`prove`/`check` against a spec) and never claims it.
 *  - Safety invariants: Canary only ever removes hook entries whose command
 *    string it recorded as its own (exact match) — never a user entry. Config
 *    edits are preceded by a backup under .canary/backups/. A settings file
 *    that fails to parse is never overwritten. Plan steps are {pm, script}
 *    pairs reconstructed from a validated name charset, never stored as
 *    arbitrary command strings.
 *  - Local-state trust (post-review S1/S2/S3): a .canary config is honored by
 *    checkpoint/uninstall only when it is corroborated as this installation's
 *    own (cliPath matches this binary exactly; the file is not tracked in git
 *    — committed Canary state arrives from someone else's clone). No config,
 *    trusted or not, may make Canary read or write through a path that
 *    resolves outside <repo>/.claude or <repo>/.canary (symlink/junction
 *    containment via realpath).
 *  - doctor's READY is always earned in the invocation that prints it: doctor
 *    runs the checks every time; a stored checkpoint can never produce READY
 *    on its own (post-review S4 — the exit-0 oracle must not reward a record).
 *  - CLAIMS ARE NOT EVIDENCE (M2): a worker agent's reports ("427 tests
 *    passed", results.txt, logs, screenshots) are UNTRUSTED hints. Every check
 *    that carries a verdict is one Canary EXECUTED ITSELF in this invocation,
 *    and each run writes a verification bundle (.canary/evidence/) recording
 *    the candidate identity, exact argv, cwd, runtime identity, relevant env
 *    overrides, raw stdout/stderr (capped files + full sha256), exit code and
 *    independently derived observation counts. The bundle — like
 *    last-checkpoint.json — is NEVER read back to produce a verdict; it is
 *    written evidence for humans, not an oracle for the hook. An agent claim
 *    recorded via `canary claim` can only ANNOTATE a block Canary already
 *    decided from its own execution, and can never turn a pass into a block
 *    or a block into a pass.
 *  - uninstall keeps .canary (its ownership record) until cleanup fully
 *    succeeded, so the advertised "re-run uninstall" can actually work
 *    (post-review S6).
 *  - Exit codes (same doctrine as main.ts): 0 READY/success, 2 NEEDS
 *    ATTENTION / UNSUPPORTED / execution refused, 3 misuse.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { controllerExecution } from './provider/execution.js';
import { fileURLToPath } from 'node:url';
// Single-executable (SEA) detection for the standalone distribution (v1.1 item
// C). `node:sea` exists in every supported Node and `isSea()` is simply false
// outside a SEA build, so this import costs nothing in the ordinary case.
import sea from 'node:sea';
import { buildFailurePayload } from './failure-payload.js';
import { resolveNpmCli, sanitizedEnv } from '@canary-rn/support';

// M9 §9.5 — the quarantine marker filename. authority.ts imports only node
// builtins, so this direction adds no cycle (candidate.ts already imports it).
import { QUARANTINE_FILE } from './authority.js';
import { canonicalTask, declaredTask, taskWeakening, materialDigest, canonicalText, TASK_KINDS, MAX_REQUIREMENTS, type TaskKind, type TaskIdentity, type AuthorizationSubject, subjectDigest } from './authorization.js';
export { canonicalTask, declaredTask, taskWeakening, TASK_KINDS, MAX_REQUIREMENTS, subjectDigest };
export type { TaskKind, TaskIdentity, AuthorizationSubject };
// 1.1 §1 — the project model lives in project.js. onboarding re-exports the
// names it used to own so every existing importer (candidate.ts, the contract
// tests) compiles and behaves unchanged while the seam gains a second owner.
import { ADAPTERS, adapterFor, adapterForStep, assertStepArgv, composePlan, LOCKFILES, nodeAdapter, parseJsonOrNull, planAuthorityDrift, planDigest, planForScope, planProblemsForConfig, scopeDir, SCOPES_FILE, SCOPES_SCHEMA, sealPlanAuthority, sha256, stepArgv } from './project.js';
import { emitEnvelope, PROTOCOL_RESULT, PROTOCOL_STATUS, type ProtocolEnvelope, type ProtocolIntegration } from './protocol.js';
import { decideFastPath } from './fastpath.js';
import { AGENT_INTEGRATIONS, hasAdvisory, installAdvisory, removeAdvisory } from './agents.js';
import type { PlanAuthority, PlanStep } from './project.js';
// 1.1 P0 — the sealed authority store outside the repo. In this slice the
// store is SEALED at setup and REPORTED at status/doctor; no v1.0 verdict
// reads it (yet), so a legacy project without records loses nothing.
import { openSealed, probeTrustLevel, probeTrustLevelReadOnly, sealRecord, storeFromEnv, projectIdForRoot } from './trust-store.js';
// v1.1 Phase 3: the measured HARDENED boundary. Imported HERE (not into
// trust-store/platform-boundary, which the P0 mutation probe copies into a
// scratch tree and which must therefore stay free of new imports).
import { providerConfigured } from './provider/boundary.js';
import { providerStatus } from './provider/service.js';
import { measuredCapabilities } from './platform-boundary.js';
import { canonicalJson } from '@canary-rn/hashing';
import { CANARY_VERSION } from './pipeline.js';
export { detectPm, detectPlan, isSafeScriptName, sealPlanAuthority, planAuthorityDrift, stepArgv, planDigest, parseJsonOrNull } from './project.js';
export type { PlanKind, PlanStep, PlanAuthority } from './project.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The absolute path of the built CLI entry — what harness hooks invoke. */
export const CLI_ENTRY = sea.isSea() ? process.execPath : path.join(HERE, 'main.js');

/** argv that runs THIS Canary with `args`.
 *
 *  In a single-executable build there is no `main.js` on disk — the executable
 *  IS the CLI — so spawning `process.execPath` with the CLI path as its first
 *  argument would feed the binary its own path as a command name. `import.meta
 *  .url` cannot be used to detect this either: inside a SEA it resolves to the
 *  BUILD-time path, not the installed binary's. `sea.isSea()` is the supported
 *  signal, and this function is the ONE place that turns it into an argv, so no
 *  caller can get the standalone case wrong. */
export function selfArgv(args: readonly string[]): string[] {
  return sea.isSea() ? [...args] : [CLI_ENTRY, ...args];
}

export const CONFIG_DIR = '.canary';
const CONFIG_FILE = 'canary.local.json';
const CHECKPOINT_FILE = 'last-checkpoint.json';
/** M9: exported — evidence storage is protected authority bytes (§9). */
export const EVIDENCE_DIR = 'evidence';
const CLAIMS_FILE = path.join('claims', 'latest.json');
/** M9: exported for the authority fingerprint set — task intent is protected
 *  authority bytes (directive §9), even while it carries zero verdict weight. */
export const TASK_FILE = path.join('task', 'current.json');
/** bundles kept before the oldest are pruned — evidence must not grow unbounded */
const EVIDENCE_KEEP = 10;
const RAW_CAP = 256 * 1024;
/** A file Canary wrote into the repository, and WHICH KIND of entry it owns there. The kind decides
 *  how uninstall prunes it: hook entries are matched by command string, MCP server entries by their
 *  argv signature. Legacy configs carry no kind and are hooks by construction. */
export interface TouchedFile { path: string; created: boolean; kind?: 'hooks' | 'mcp' }
export interface CanaryConfig {
  version: string; installedAt: string; pm: string; plan: PlanStep[];
  cliPath: string; hookCommand: string;
  /** every command string ever installed here — uninstall matches exactly these */
  hookCommands: string[];
  /** v1.3: every MCP server argv signature ever written here, serialized — uninstall and re-setup
   *  match exactly these, so a key Canary did not write is never pruned or replaced. Absent on
   *  configs written before v1.3, which simply means "no MCP entry is owned here". */
  mcpArgSignatures?: string[];
  touched: TouchedFile[];
  /** M4 baseline: repo identity stamped by Canary at setup time — "state when
   *  Canary was wired". Optional: configs written before M4 have no provable
   *  baseline, and bundles say `baseline: null` rather than invent one. */
  baseline?: BaselineStamp;
  /** M5 trusted verification plan: the plan AND the exact script TEXTS that a
   *  human set up. Verified before every execution; drift blocks. Optional:
   *  configs written before M5 have no seal and verify exactly as before. */
  planAuthority?: PlanAuthority;
  /** 1.1 §1: which project adapter owns this repo. Absent = 'node' — every
   *  config written before 1.1 describes a Node project, and setup keeps that
   *  byte shape until detection can legitimately name another ecosystem. */
  project?: string;
}

// ---------- detection (pure, testable) ----------

export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface HarnessInfo { name: string; label: string; supported: boolean; action: string }
export function detectHarnesses(root: string): { found: HarnessInfo[]; integrable: HarnessInfo | null } {
  const found: HarnessInfo[] = [];
  const claudeDir = fs.existsSync(path.join(root, '.claude')) || fs.existsSync(path.join(os.homedir(), '.claude'));
  if (claudeDir) {
    found.push({ name: 'claude-code', label: 'Claude Code', supported: true, action: 'hook installed into this project' });
  }
  const codex = fs.existsSync(path.join(os.homedir(), '.codex')) || hasExe('codex');
  if (codex) {
    // No reliable block-at-completion hook surface today; an observe-only
    // integration would fake protection we cannot enforce, so we don't ship it.
    found.push({ name: 'codex', label: 'OpenAI Codex CLI', supported: false, action: 'detected, NOT integrated — no reliable blocking hook exists yet' });
  }
  // v1.3 §E: Cursor is DETECTED so the capability table can report it honestly. `supported: false`
  // because nothing about it is measured here — Cursor documents importing Claude Code hooks, which
  // would make the hook Canary installs effective, and documents no way to remove its native tools.
  // Detection is not a claim; the table entry carries what is and is not known.
  const cursor = fs.existsSync(path.join(root, '.cursor')) || hasExe('cursor');
  if (cursor) {
    found.push({ name: 'cursor', label: 'Cursor', supported: false, action: 'detected, completion-gate mechanism documented by the vendor but UNMEASURED by Canary' });
  }
  const cc = found.find((h) => h.name === 'claude-code') ?? null;
  return { found, integrable: cc };
}

function hasExe(name: string): boolean {
  // Trusted-dir scan, zero spawn (blocker 1): a which/where probe under the
  // caller's PATH would let a shim decide which harnesses Canary reports.
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  return trustedDirs().some((d) => names.some((n) => fs.existsSync(path.join(d, n))));
}

/** Build the hook command; null when the CLI path cannot be safely quoted. */
export function buildHookCommand(cliPath: string): string | null {
  if (cliPath.includes('"') || cliPath.includes('\n')) return null; // cannot embed safely
  // A single-executable Canary IS the command: prefixing `node` would demand a
  // Node installation, which is exactly what the standalone build removes.
  return sea.isSea() ? `"${cliPath}" checkpoint` : `node "${cliPath}" checkpoint`;
}

// ---------- config + settings.json plumbing ----------

export function configPath(root: string): string { return path.join(root, CONFIG_DIR, CONFIG_FILE); }

/** Shape validation: a parseable-but-wrong-shape file is 'corrupt' (S7 — the
 *  documented self-heal path must fire instead of exit-3 TypeErrors). */
function validConfigShape(v: unknown): v is CanaryConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  const isStr = (x: unknown): boolean => typeof x === 'string';
  return isStr(c.version) && isStr(c.installedAt) && isStr(c.pm) && isStr(c.cliPath) && isStr(c.hookCommand)
    // 1.1: a step's optional fields are shape-checked HERE, so a hand-edited
    // config with a malformed argv is 'corrupt' (documented self-heal) rather
    // than a runtime throw at execution time. An empty argv can never execute,
    // so it is corrupt too — refusing early beats discovering it mid-plan.
    && Array.isArray(c.plan) && c.plan.every((s) => {
      if (!s || typeof s !== 'object') return false;
      const p = s as PlanStep;
      if (!isStr(p.kind) || !isStr(p.script)) return false;
      if (p.adapter !== undefined && !isStr(p.adapter)) return false;
      if (p.scope !== undefined && !isStr(p.scope)) return false;
      if (p.argv !== undefined && (!Array.isArray(p.argv) || p.argv.length === 0 || !p.argv.every(isStr))) return false;
      return true;
    })
    && Array.isArray(c.hookCommands) && c.hookCommands.every(isStr)
    && Array.isArray(c.touched) && c.touched.every((t) => t && typeof t === 'object' && isStr((t as TouchedFile).path) && typeof (t as TouchedFile).created === 'boolean'
      // v1.3 §C: the kind decides HOW uninstall prunes. An unrecognised value is corrupt rather than
      // silently treated as 'hooks' — pruning the wrong way could leave an entry behind while
      // reporting success, which is the one outcome uninstall may never produce.
      && ((t as TouchedFile).kind === undefined || (t as TouchedFile).kind === 'hooks' || (t as TouchedFile).kind === 'mcp')
      && (c.touched as TouchedFile[]).filter((x) => x.kind === 'mcp').length <= 1)
    // 1.1 §1: a config may only name a REGISTERED adapter — an unknown id is
    // 'corrupt' (the documented self-heal path fires), never a silent fallback
    // that would run the Node pipeline against a foreign project.
    && (c.project === undefined || (typeof c.project === 'string' && Object.hasOwn(ADAPTERS, c.project)));
}
export function readConfig(root: string): CanaryConfig | null | 'corrupt' {
  const p = configPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return validConfigShape(v) ? v : 'corrupt';
  } catch { return 'corrupt'; }
}

/** Case-exact path equality (win32 paths are case-insensitive). */
function samePath(a: string, b: string): boolean {
  const [x, y] = process.platform === 'win32' ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
  return x === y;
}

/** true = the config file is tracked in git (arrives from a clone — someone
 *  else's local state). false = not tracked. null = git cannot answer. */
const configTrackedMemo = new Map<string, boolean | null>();
export function configTracked(root: string): boolean | null {
  // Once per process per root: cmdSetup asks twice (the pre-write tracked-config
  // refusal and the prevUsable dedupe seed) and nothing in-process commits
  // .canary between the two. Both non-false answers are refusals, so a
  // remembered answer can only ever refuse as much as a re-ask would.
  const seen = configTrackedMemo.get(root);
  if (seen !== undefined) return seen;
  const gr = gitCommand(root, ['ls-files', '--', `${CONFIG_DIR}/${CONFIG_FILE}`]);
  const out = !gr || gr.status !== 0 ? null : gr.stdout.trim().length > 0;
  configTrackedMemo.set(root, out);
  return out;
}

/** Why this config must not be honored as "our own local state" — or null.
 *  cliPath binding catches configs written by another installation (the S2
 *  cloned-repo vector: a bogus cliPath is the attacker's unavoidable
 *  footprint; a same-path guess additionally needs the committed settings.json
 *  to pass Claude Code's own project-settings approval). The tracked check
 *  closes the same-install-path case: to reach a victim, the config must be
 *  committed, and committed Canary state is exactly what must never be trusted. */
export function untrustedConfigReason(root: string, cfg: CanaryConfig): string | null {
  if (!samePath(path.normalize(cfg.cliPath), CLI_ENTRY)) return `it was written by a different Canary installation ("${cfg.cliPath}")`;
  if (configTracked(root) === true) return 'it is committed to this repo — Canary state must stay local (.canary self-ignores); a cloned config is not yours';
  return null;
}

/** realpath containment: resolve p without ever escaping root. Symlinks AND
 *  Windows junctions are followed by realpath, so a committed
 *  `.canary -> /somewhere/else` (or `.gitignore -> ../../.gitignore`) resolves
 *  outside root and returns null (S3). Non-existent final components are safe
 *  to re-join once their nearest existing ancestor is contained. */
export function containedRealPath(root: string, p: string): string | null {
  try {
    const r = fs.realpathSync(root);
    const inside = (t: string) => process.platform === 'win32'
      ? (t.toLowerCase() === r.toLowerCase() || t.toLowerCase().startsWith(r.toLowerCase() + path.sep))
      : (t === r || t.startsWith(r + path.sep));
    if (fs.existsSync(p)) return inside(fs.realpathSync(p)) ? fs.realpathSync(p) : null;
    let cur = path.resolve(p);
    const tail: string[] = [];
    while (!fs.existsSync(cur)) {
      tail.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
    const anc = fs.realpathSync(cur);
    return inside(anc) ? path.join(anc, ...tail) : null;
  } catch { return null; }
}
/**
 * Atomic replace (GLM F-2): full bytes to a temp sibling -> fsync -> close ->
 * rename over the target. An interrupted or crashed write can only ever leave
 * the PREVIOUS complete file or the NEW complete file — never a half-written
 * config that readConfig would call 'corrupt'. fs.renameSync replaces an
 * existing target on Windows (MoveFileEx REPLACE_EXISTING) and POSIX.
 * Callers keep their own containment pre-checks; this preserves them:
 * assertPlainTarget on BOTH final and temp (no dangling-link landing pads),
 * and a failed attempt removes its temp and rethrows — bytes untouched.
 * Ceiling (ponytail): no parent-directory fsync (not portable on Windows);
 * the rename itself is the atomic step, so the worst crash window is a
 * surviving temp sibling, which self-heals on the next write.
 */
export function writeFileAtomic(p: string, data: string): void {
  assertPlainTarget(p);
  const tmp = `${p}.${process.pid}.canary-tmp`;
  assertPlainTarget(tmp);
  try {
    // 'wx' exclusive create: a planted hardlink at the predictable temp name
    // fails EEXIST instead of being written through (closes the check->open
    // TOCTOU window assertPlainTarget alone cannot see).
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort; a surviving temp is inert */ }
    throw e;
  }
}

/** Make .canary self-ignoring BEFORE Canary's first repo write. installStopHook
 *  drops a settings backup under .canary/backups, and the baseline dirty-stamp
 *  runs after that — if the self-ignore only arrives with writeConfig, Canary's
 *  own backup stamps the baseline dirty and permanently blinds worktree-deletion
 *  blame in the common "repo tracks .claude/settings.json" setup (review #2). */
export function ensureCanarySelfIgnore(root: string): void {
  const dir = path.join(root, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) writeFileAtomic(gi, '*\n');
}

export function writeConfig(root: string, cfg: CanaryConfig): void {
  const dir = path.join(root, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, '.gitignore'), '*\n'); // self-ignoring; never dirties the user repo
  writeFileAtomic(path.join(dir, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n');
}

export function settingsPath(root: string): string { return path.join(root, '.claude', 'settings.json'); }

/** Refuse to create-or-follow a symlink for the final component (S3, second
 *  half): containedRealPath only sees links whose target EXISTS — a dangling
 *  `.canary/last-checkpoint.json -> /somewhere/else` passes the ancestor walk,
 *  then writeFileSync would CREATE the external file through the link. Every
 *  path Canary writes to must be a plain file (or not exist at all). */
function assertPlainTarget(p: string): void {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`refused to write through symlink: ${p}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // absent = safe to create
    throw e;
  }
}

/** Collect Canary-owned Stop entries (exact command match) and remove them. */
function pruneOwned(doc: Record<string, unknown>, ownedCommands: Set<string>): number {
  const hooks = doc.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || !Array.isArray(hooks.Stop)) return 0;
  let removed = 0;
  const kept: unknown[] = [];
  for (const group of hooks.Stop as Array<{ hooks?: unknown[] }>) {
    if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
    const inner = group.hooks.filter((h) => {
      const mine = !!h && typeof h === 'object' && ownedCommands.has(String((h as { command?: unknown }).command ?? ''));
      if (mine) removed++;
      return !mine;
    });
    if (inner.length) kept.push({ ...group, hooks: inner });
  }
  if (kept.length) hooks.Stop = kept; else delete hooks.Stop;
  if (!Object.keys(hooks).length) delete doc.hooks;
  return removed;
}

/**
 * Install the Stop hook into <root>/.claude/settings.json.
 * Preflight parses (refuses on malformed); backs up before any write; prunes
 * previously-owned entries first (idempotent, no stacking); records backups in
 * .canary/backups/. Returns the touched-file record for uninstall.
 */
export function installStopHook(
  root: string, command: string, priorCommands: Set<string>, backupsDir: string,
): { ok: boolean; touched?: TouchedFile; problem?: string } {
  const file = settingsPath(root);
  try { assertPlainTarget(file); } catch {
    return { ok: false, problem: `${rel(root, file)} is a symbolic link — Canary will not write through links. Replace it with a real file, then run setup again. Nothing was changed.` };
  }
  const existed = fs.existsSync(file);
  let doc: Record<string, unknown> = {};
  if (existed) {
    const parsed = parseJsonOrNull(file);
    if (!parsed) return { ok: false, problem: `${rel(root, file)} is not valid JSON — fix it and re-run setup. Nothing was changed.` };
    doc = parsed;
  }
  pruneOwned(doc, new Set([command, ...priorCommands]));
  // valid JSON, but an unexpected hooks/Stop shape (string/object instead of
  // list) is unmergeable — refuse in plain words like a parse failure (S5),
  // never crash with an internal TypeError.
  if (doc.hooks !== undefined && (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks))) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks" section that is not a settings object — fix it and re-run setup. Nothing was changed.` };
  }
  if (doc.hooks !== undefined && (doc.hooks as Record<string, unknown>).Stop !== undefined && !Array.isArray((doc.hooks as Record<string, unknown>).Stop)) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks.Stop" that is not a list of hook groups — fix it and re-run setup. Nothing was changed.` };
  }
  const hooks = (doc.hooks ??= {}) as Record<string, unknown[]>;
  const stop = (hooks.Stop ??= []) as Array<{ hooks: unknown[] }>;
  stop.push({ hooks: [{ type: 'command', command, timeout: 1800 }] });

  if (existed) {
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `${stamp}-settings.json`);
    try { assertPlainTarget(dest); fs.copyFileSync(file, dest); } catch (e) {
      return { ok: false, problem: `could not back up ${rel(root, file)} (${String(e).slice(0, 140)}) — nothing was changed.` };
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  try {
    writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n'); // harness settings: an interrupted write must not leave broken JSON
  } catch (e) {
    // rename can fail transiently on Windows (AV/indexer holds the target);
    // the atomic path guarantees the original bytes are untouched — say so.
    return { ok: false, problem: `could not update ${rel(root, file)} (${String(e).slice(0, 140)}) — ${existed ? 'your file was left exactly as it was, and the backup is in place' : 'nothing was created'}; a momentarily locked file (AV/indexer) is the usual cause. Re-run setup.` };
  }
  return { ok: true, touched: { path: file, created: !existed } };
}

/** True when doc's Stop hooks still contain one of our exact commands. */
export function hasCanaryEntry(doc: Record<string, unknown>, owned: Set<string>): boolean {
  const stop = (doc.hooks as Record<string, unknown> | undefined)?.Stop;
  if (!Array.isArray(stop)) return false;
  return stop.some((g) => Array.isArray((g as { hooks?: unknown })?.hooks)
    && (g as { hooks: Array<{ command?: string }> }).hooks.some((h) => owned.has(String(h?.command ?? ''))));
}

// ---------- v1.3 §C: the MCP server, wired by setup instead of by hand ----------
//
// WHY THIS IS INSTALLED AND NOT MERELY DOCUMENTED. The completion gate already tells the agent, at the
// END, that a green suite which cannot discriminate the change proves nothing (measured: the everyday
// Stop hook BLOCKS it). What the agent cannot do is ASK. So it runs its own tests instead — measured
// on the long fixture, ~36 of 57 confined execs were the model re-running its own checks and building
// a fuzz/mutation rig as whole-file writes, which is ~70% of that arm's token cost and is the single
// largest reason a long task costs more than the unguarded arm.
//
// `canary mcp` already exists, already refuses `accept` deliberately, and already exposes only thin
// argv templates over operations the CLI had before it (mcp.ts:67-164). The missing piece was that a
// user had to discover and configure an MCP client by hand. This closes that gap with the same
// discipline as the Stop hook: parse first, refuse to write through a link, back up, prune only our
// OWN prior entry, write atomically, and record exactly what we touched so `uninstall` can undo it.
//
// It grants NO new authority: the server can only REQUEST `result`/`status`/`agents`/`doctor`/`work`/
// `finish`, each of which runs the same CLI and is judged by the same gates.
const MCP_SERVER_KEY = 'canary';
const MCP_CONFIG_BASENAME = '.mcp.json';

export function mcpConfigPath(root: string): string { return path.join(root, MCP_CONFIG_BASENAME); }

/** The exact program a client should run: this Canary, serving MCP.
 *
 *  Deliberately PINNED to the Node that is running setup, unlike the hook command, which spells bare
 *  `node` and therefore depends on the harness's PATH. That difference is intentional: a completion
 *  hook is executed BY a shell, so PATH is its native mechanism and is already required; an MCP server
 *  is spawned DIRECTLY by the editor, and a GUI-launched editor routinely has a different PATH than
 *  the user's terminal. Pinning removes a whole class of "the server never started" reports that would
 *  otherwise be blamed on Canary. */
export function mcpServerCommand(cliPath: string): string { return sea.isSea() ? cliPath : process.execPath; }
export function mcpServerArgs(cliPath: string): string[] { return sea.isSea() ? ['mcp'] : [cliPath, 'mcp']; }
export const mcpArgSignature = (args: readonly string[]): string => JSON.stringify([...args]);

/** Is OUR entry present — matched by argv signature, never by the key alone? */
export function hasMcpEntry(doc: Record<string, unknown>, owned: Set<string>): boolean {
  const servers = doc.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_KEY];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const args = (entry as { args?: unknown }).args;
  return Array.isArray(args) && owned.has(mcpArgSignature(args.map(String)));
}

/** Remove ONLY entries this installation wrote, matched by argv signature. Anything else under the
 *  key — a stranger's `canary` server, a hand-written one — is left exactly as it was. */
export function pruneOwnedMcp(doc: Record<string, unknown>, owned: Set<string>): number {
  const servers = doc.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 0;
  const map = servers as Record<string, unknown>;
  const entry = map[MCP_SERVER_KEY];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 0;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || !owned.has(mcpArgSignature(args.map(String)))) return 0;
  delete map[MCP_SERVER_KEY];
  if (Object.keys(map).length === 0) delete doc.mcpServers;
  return 1;
}

/**
 * Install the Canary MCP server into <root>/.mcp.json.
 *
 * Refusals are plain and Nothing Is Changed: a symlinked file, invalid JSON, a `mcpServers` that is
 * not an object, or a `canary` key that exists but was NOT written by this installation. That last
 * one is the confused-deputy guard — Canary will not silently replace a server it did not create.
 */
export function installMcpServer(
  root: string, cliPath: string, priorSignatures: Set<string>, backupsDir: string,
): { ok: boolean; touched?: TouchedFile; problem?: string } {
  const file = mcpConfigPath(root);
  try { assertPlainTarget(file); } catch {
    return { ok: false, problem: `${rel(root, file)} is a symbolic link — Canary will not write through links. Replace it with a real file, then run setup again. Nothing was changed.` };
  }
  const existed = fs.existsSync(file);
  let doc: Record<string, unknown> = {};
  if (existed) {
    const parsed = parseJsonOrNull(file);
    if (!parsed) return { ok: false, problem: `${rel(root, file)} is not valid JSON — fix it and re-run setup. Nothing was changed.` };
    doc = parsed;
  }
  if (doc.mcpServers !== undefined && (typeof doc.mcpServers !== 'object' || doc.mcpServers === null || Array.isArray(doc.mcpServers))) {
    return { ok: false, problem: `${rel(root, file)} has an "mcpServers" section that is not an object — fix it and re-run setup. Nothing was changed.` };
  }
  const args = mcpServerArgs(cliPath);
  const signature = mcpArgSignature(args);
  const owned = new Set([signature, ...priorSignatures]);
  const existing = (doc.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_KEY];
  if (existing !== undefined && !hasMcpEntry(doc, owned)) {
    return {
      ok: false,
      problem: `${rel(root, file)} already defines an MCP server named "${MCP_SERVER_KEY}" that Canary did not write. Canary will not replace a server it does not own — rename or remove that entry (or point it elsewhere), then run setup again. Nothing was changed.`,
    };
  }
  pruneOwnedMcp(doc, owned);
  // RE-ACQUIRE the map: pruning the last server deletes `mcpServers` itself, so a reference taken
  // before the prune would write our entry into a detached object and silently produce a file with no
  // servers at all. (A test caught exactly that: a re-run left the document empty.)
  const map = (doc.mcpServers ??= {}) as Record<string, unknown>;
  map[MCP_SERVER_KEY] = { command: mcpServerCommand(cliPath), args };

  if (existed) {
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `${stamp}-mcp.json`);
    try { assertPlainTarget(dest); fs.copyFileSync(file, dest); } catch (e) {
      return { ok: false, problem: `could not back up ${rel(root, file)} (${String(e).slice(0, 140)}) — nothing was changed.` };
    }
  }
  try {
    writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  } catch (e) {
    return { ok: false, problem: `could not update ${rel(root, file)} (${String(e).slice(0, 140)}) — ${existed ? 'your file was left exactly as it was, and the backup is in place' : 'nothing was created'}. Re-run setup.` };
  }
  return { ok: true, touched: { path: file, created: !existed, kind: 'mcp' } };
}

/** Remove Canary entries from every touched settings file. Returns problems[]. */
export function uninstallHooks(root: string, cfg: CanaryConfig): { removed: number; problems: string[] } {
  const owned = new Set(cfg.hookCommands.length ? cfg.hookCommands : [cfg.hookCommand]);
  const ownedMcp = new Set(cfg.mcpArgSignatures ?? []);
  const problems: string[] = [];
  let removed = 0;
  for (const t of cfg.touched) {
    if (!fs.existsSync(t.path)) continue;
    // A config (even a valid-shape one) can name paths outside the repo — the
    // S1 vector. No touched entry may resolve outside root; refuse it loudly
    // instead of rewriting or deleting a stranger's settings file.
    if (containedRealPath(root, t.path) === null) {
      problems.push(`${t.path} resolves outside this repository — Canary never modifies files outside the repo it was set up in. Left untouched.`);
      continue;
    }
    const doc = parseJsonOrNull(t.path);
    if (!doc) { problems.push(`${rel(root, t.path)} is not valid JSON — left untouched. Repair it, then re-run uninstall.`); continue; }
    let pruned = 0;
    try {
      // v1.3 §C: an MCP entry is owned by its argv signature, not by a command string, so the two
      // kinds prune differently. A legacy touched entry (no kind) is a hooks file by construction.
      pruned = t.kind === 'mcp' ? pruneOwnedMcp(doc, ownedMcp) : pruneOwned(doc, owned);
      if (fs.existsSync(t.path)) {
        if (Object.keys(doc).length === 0 && t.created) fs.rmSync(t.path);
        else writeFileAtomic(t.path, JSON.stringify(doc, null, 2) + '\n');
      }
    } catch (e) {
      // write/delete failed — the on-disk file was NOT changed, so the
      // pruned entries must not be counted and the file must be reported.
      problems.push(`${rel(root, t.path)} could not be updated (${String(e).slice(0, 140)}) — left untouched; re-run uninstall once the file lock clears.`);
      continue;
    }
    removed += pruned;
  }
  return { removed, problems };
}

// ---------- execution (PRE-1.0 blocker 1: hardened) ----------
// RULE: an untrusted CALLER ENVIRONMENT must never control proof-authoritative
// execution. EVERY subprocess whose result can move READY / PASS / FAIL /
// BLOCKED / NOT PROVEN / PROMOTABLE / ACCEPTED goes through this section:
//   - fully REPLACED deny-by-omission environment (sanitizedEnv — the caller's
//     PATH, NODE_OPTIONS, NODE_PATH, npm_config_*, GIT_* simply do not exist
//     for the child; there is deliberately no merge option, support F9);
//   - executable resolved WITHOUT any caller-controlled path: the running
//     Node's own install dir (where corepack/npm-bundled tools live) plus
//     fixed OS-managed (root/admin-owned) directories. git gets the same
//     treatment from literal candidates, never %SystemRoot%- or PATH-derived;
//   - shell:false everywhere — the win32 .cmd shim problem is solved by
//     running the CLI ENTRY SCRIPTS under node, not by handing cmd.exe a PATH.
// Each bundle step records WHAT RAN (resolved file + digest + policy), so
// evidence names the actual bytes instead of an argv that could describe a
// different binary. Same-UID total forgery (swapping the node binary itself,
// pre-planting files in these directories) remains the documented ceiling (M2).

const NODE_DIR = path.dirname(process.execPath);
export const ENV_POLICY = 'canary-sanitized/1';

/** The literal absolute candidates Canary will execute git from. Never
 *  PATH-derived: a PATH or %SystemRoot% shim must not be able to become git. */
const gitCandidates = (): string[] => process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    'C:\\Windows\\System32\\git.exe', path.join(NODE_DIR, 'git.exe')]
  : ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];

/**
 * The directories Canary is willing to execute from.
 *
 * EXPORTED because a probe asserts that every executed file lies inside this
 * set, and until this function was exported that probe kept a hardcoded MIRROR
 * of it — so the assertion that is supposed to police the trust set silently
 * desynchronised whenever the set changed (which is exactly what happened on
 * win32: `gitExe()` executes git from a literal Git install directory that this
 * list did not contain, and the probe failed on the contradiction).
 *
 * The rule the list encodes: a directory Canary will EXECUTE from is trusted by
 * construction, so the declared set must contain every candidate the product
 * resolves to — see `gitCandidates` below. Adding these directories cannot widen
 * what a PROJECT can make Canary run: they are fixed literals, not search paths.
 */
export function trustedDirs(): string[] {
  const base = process.platform === 'win32'
    ? [NODE_DIR, 'C:\\Windows\\System32', 'C:\\Windows']
    : [NODE_DIR, '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set([...base, ...gitCandidates().map((c) => path.dirname(c))])];
}

// ws.root doubles as the child's isolated HOME/TMP base. It is os.tmpdir(),
// which the caller can steer — but every dir a steered TEMP points at is
// already fully attacker-writable at this UID, so pre-planting there grants
// nothing the same-UID ceiling does not already cover. What matters (and what
// this closes) is that env-var INJECTION can no longer steer resolution.
const hardenedEnv = (fixture: string): NodeJS.ProcessEnv =>
  sanitizedEnv({ ws: { root: os.tmpdir(), fixture }, nodeDir: NODE_DIR });

/**
 * The SAME environment door, plus the toolchain variables the step's own
 * ecosystem declared (`ProjectAdapter.toolchainEnv`).
 *
 * A second function rather than a wider signature on purpose: the two lines above
 * are the anchor the master-pass M7 mutation pins ("merge the CALLER environment
 * under the sanitized one" must stay dead), and widening that expression would
 * have moved the anchor for no gain. This door adds only what an adapter
 * declared, and `sanitizedEnv` still enforces the key allowlist and workspace
 * containment on every value.
 */
const hardenedEnvWithToolchain = (fixture: string, toolchain: Record<string, string>): NodeJS.ProcessEnv =>
  sanitizedEnv({ ws: { root: os.tmpdir(), fixture }, nodeDir: NODE_DIR, toolchain: { env: toolchain } });

/** Compact executable identity for evidence: sha256 where cheap, size where not. */
export function execDigest(p: string): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > 8 * 1024 * 1024) return `size:${st.size}`;
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch { return null; }
}

let gitExeCache: string | null | undefined;
/** Fixed literal candidates — a PATH or %SystemRoot% shim cannot become git. */
export function gitExe(): string | null {
  if (gitExeCache !== undefined) return gitExeCache;
  gitExeCache = gitCandidates().find((c) => fs.existsSync(c)) ?? null;
  return gitExeCache;
}

/** One hardened raw git call — the ONLY way product code spawns git.
 *  null = git is not resolvable in the trusted environment: fail closed. */
export interface GitResult { status: number | null; stdout: string; stderr: string; error?: Error | undefined }
export function gitCommand(root: string, args: string[], timeoutMs = 15_000): GitResult | null {
  const exe = gitExe();
  if (exe === null) return null;
  const controller = controllerExecution.getStore();
  const r = spawnSync(exe, [...(controller ? ['-c', `core.hooksPath=${controller.hooksDirectory}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'] : []), '-C', root, ...args], {
    // 32MB maxBuffer: the 1MB default would turn a large repo's `ls-tree -r`
    // (M7's submodule probe) into a spurious null.
    cwd: root, encoding: 'utf8', timeout: timeoutMs,
    env: { ...sanitizedEnv({ ws: { root: os.tmpdir(), fixture: root }, nodeDir: NODE_DIR, materialize: false }),
      ...(controller ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } : {}) }, shell: false, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Resolve the package manager to TRUSTED bytes — PATH is never consulted.
 *  Order: (1) the CLI entry script bundled inside the running Node's install
 *  (npm/pnpm/yarn run under node itself — no .cmd shim, no lookup; npm uses
 *  the single canonical resolveNpmCli from @canary-rn/support for probe
 *  parity); (2) an absolute executable found in a trusted directory, win32
 *  .cmd/.bat only through the literal-system cmd.exe. null = unresolvable. */
export interface ResolvedPm { spawnArgv: [string, ...string[]]; file: string; via: string }
const PM_ENTRIES: Record<string, string> = { npm: 'npm/bin/npm-cli.js', pnpm: 'pnpm/bin/pnpm.cjs', yarn: 'yarn/bin/yarn.js' };
export function resolvePm(pm: string): ResolvedPm | null {
  const entry = Object.hasOwn(PM_ENTRIES, pm) ? PM_ENTRIES[pm] : undefined;
  if (entry !== undefined) {
    const hit = pm === 'npm' ? resolveNpmCli()
      : [path.join(NODE_DIR, 'node_modules'), path.join(NODE_DIR, '..', 'lib', 'node_modules')]
        .map((d) => path.join(d, entry)).find((c) => fs.existsSync(c));
    if (hit) return { spawnArgv: [process.execPath, hit], file: hit, via: 'node-entry' };
  }
  const names = process.platform === 'win32' ? [`${pm}.exe`, `${pm}.cmd`, `${pm}.bat`] : [pm];
  for (const dir of trustedDirs()) {
    for (const n of names) {
      const abs = path.join(dir, n);
      if (!fs.existsSync(abs)) continue;
      if (/\.(cmd|bat)$/i.test(abs)) {
        // literal, never %ComSpec%: the caller owns that env var
        const cmdExe = 'C:\\Windows\\System32\\cmd.exe';
        if (!fs.existsSync(cmdExe)) continue;
        return { spawnArgv: [cmdExe, '/d', '/s', '/c', abs], file: abs, via: 'trusted-cmd' };
      }
      return { spawnArgv: [abs], file: abs, via: 'trusted-path' };
    }
  }
  return null;
}

const PM_NAMES = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Resolve one program to TRUSTED bytes for a step's argv[0].
 *
 * Package managers keep their existing resolution exactly (this is the same
 * resolvePm the doctor liveness probe uses, so plan and probe still consult one
 * door). Any OTHER program — an interpreter or toolchain a non-script ecosystem
 * declares — is looked for in the baseline trusted dirs plus the declaring
 * adapter's conventional dirs. PATH is still never consulted, so a candidate
 * cannot plant a `python` ahead of the sealed one and have Canary spawn it as
 * sealed authority. An ABSOLUTE program path is accepted as the authority the
 * seal already covers (setup sealed the argv that names it) and is still
 * digest-recorded for evidence. null = unresolvable: callers fail closed.
 */
export function resolveProgram(program: string, adapterId?: string): ResolvedPm | null {
  const asPm = resolvePm(program);
  if (asPm !== null) return asPm;
  const dirs: string[] = [...trustedDirs()];
  try { dirs.push(...adapterFor(adapterId === undefined ? {} : { project: adapterId }).trustedProgramDirs); }
  catch { /* unregistered adapter id: baseline dirs only, and the step will refuse below */ }
  const names = path.isAbsolute(program)
    ? [program]
    : process.platform === 'win32' ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`, program] : [program];
  for (const n of names) {
    const candidates = path.isAbsolute(n) ? [n] : dirs.map((d) => path.join(d, n));
    for (const abs of candidates) {
      if (!fs.existsSync(abs)) continue;
      if (/\.(cmd|bat)$/i.test(abs)) {
        // literal, never %ComSpec%: the caller owns that env var (same rule as resolvePm)
        const cmdExe = 'C:\\Windows\\System32\\cmd.exe';
        if (!fs.existsSync(cmdExe)) continue;
        return { spawnArgv: [cmdExe, '/d', '/s', '/c', abs], file: abs, via: 'trusted-cmd' };
      }
      return { spawnArgv: [abs], file: abs, via: 'trusted-path' };
    }
  }
  return null;
}

/** The exact command a step will run, from whichever authority owns it: an
 *  explicit sealed argv (a non-script ecosystem), or the validated
 *  `<pm> run <script>` shape (Node). Throws on anything it cannot validate — a
 *  step that cannot be validated is never run anyway. */
export function stepCommand(pm: string, step: PlanStep): string[] {
  // A 1.1 scoped step names its own scope's package manager (sealed with the
  // step); `pm` is the repository-level fallback for 1.0 steps.
  return step.argv !== undefined ? assertStepArgv(step.argv) : stepArgv(step.pm ?? pm, step.script);
}

/** How a step is shown to a human: the argv for an explicit step, the 1.0
 *  `<pm> run <script>` wording for a script step (unchanged output), and the
 *  step's OWN scope's pm when it carries one — a nested `web/` step shown as
 *  `python run test` would be a lie about what will execute. */
export function stepDisplay(pm: string, step: PlanStep): string {
  const scoped = step.scope ? `${step.scope}: ` : '';
  return step.argv !== undefined ? `${scoped}${assertStepArgv(step.argv).join(' ')}` : `${scoped}${step.pm ?? pm} run ${step.script}`;
}

/**
 * Pin every program an explicit-argv step names to an ABSOLUTE path, and seal
 * that path.
 *
 * This is the ONLY place Canary consults PATH, and it is the one moment a human
 * authorizes the plan: `setup`. What gets sealed is the absolute path; every
 * later verification resolves that path and nothing else (resolveProgram), so a
 * candidate cannot plant a program earlier on a search path and have Canary
 * spawn it as sealed authority — the thing `resolvePm` has always refused for
 * package managers, now extended to interpreters and toolchains.
 *
 * Returns the pinned plan and one problem per program that could not be pinned;
 * a step whose program cannot be found is never silently dropped.
 */
export function pinPlanPrograms(plan: PlanStep[]): { plan: PlanStep[]; problems: string[] } {
  const problems: string[] = [];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const cache = new Map<string, string | null>();
  const resolveOnPath = (program: string): string | null => {
    if (cache.has(program)) return cache.get(program) ?? null;
    const names = process.platform === 'win32'
      ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`, program]
      : [program];
    let found: string | null = null;
    for (const d of pathDirs) {
      for (const n of names) {
        const abs = path.join(d, n);
        if (fs.existsSync(abs)) { found = abs; break; }
      }
      if (found !== null) break;
    }
    cache.set(program, found);
    return found;
  };
  const out: PlanStep[] = plan.map((step) => {
    if (step.argv === undefined) return step; // script steps keep `<pm> run <script>`
    const argv = assertStepArgv(step.argv);
    const head = argv[0] as string;
    if (path.isAbsolute(head)) return { ...step, argv };
    // ADAPTER-DECLARED DIRECTORIES COME FIRST (v1.1). For most ecosystems they are
    // empty and this is a no-op. For Rust they are the point: rustup installs a
    // PATH PROXY at `~/.cargo/bin/cargo`, and the proxy cannot run under Canary's
    // sanitized environment (RUSTUP_HOME/HOME are redirected), while the REAL
    // toolchain binary at `<rustup>/toolchains/<tc>/bin/cargo` runs fine — measured
    // in tooling/probes/runner-channels-rust-go.mjs. Sealing the proxy would seal a
    // step that can never execute, so a reviewed, literal adapter directory is
    // preferred over whatever PATH happens to resolve to.
    const abs = resolveFromAdapterDirs(step, head) ?? resolveOnPath(head);
    if (abs === null) {
      problems.push(`"${head}" (needed by the ${step.kind} check "${step.script}") was not found on PATH at setup time`);
      return { ...step, argv };
    }
    return { ...step, argv: [abs, ...argv.slice(1)] };
  });
  return { plan: out, problems };
}

/** Try the step's own adapter's declared program directories, in order. */
function resolveFromAdapterDirs(step: PlanStep, program: string): string | null {
  let dirs: readonly string[] = [];
  try { dirs = adapterForStep({}, step).trustedProgramDirs; } catch { return null; }
  const names = process.platform === 'win32'
    ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`, program]
    : [program];
  for (const d of dirs) {
    for (const n of names) {
      const abs = path.join(d, n);
      try { if (fs.statSync(abs).isFile()) return abs; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Shared spawn for a resolved pm: the plan runner and doctor's liveness
 *  probe must consult the SAME bytes, so they share this one door. */
function spawnHardened(resolved: ResolvedPm, args: string[], cwd: string, timeoutMs: number, toolchain?: Record<string, string>) {
  const controller = controllerExecution.getStore();
  if (controller) return controller.run([...resolved.spawnArgv, ...args], cwd, timeoutMs);
  return spawnSync(resolved.spawnArgv[0], [...resolved.spawnArgv.slice(1), ...args], {
    cwd, encoding: 'utf8', timeout: timeoutMs,
    env: toolchain !== undefined && Object.keys(toolchain).length > 0 ? hardenedEnvWithToolchain(cwd, toolchain) : hardenedEnv(cwd),
    shell: false, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export interface StepResult {
  kind: string; display: string; ok: boolean; exitCode: number | null; secs: number; tail: string;
  /** M2 evidence fields — recorded, never consulted for a verdict */
  argv: string[]; cwd: string; stdout: string; stderr: string;
  /** blocker 1: what actually EXECUTED (argv[0] above is the whitelisted
   *  display form; execArgv/exec are the trusted-resolution record) */
  execArgv: string[];
  exec: { file: string; digest: string | null; via: string; policy: string };
  /** M4 provenance: wall-clock stamps around the spawn, recorded, never judged */
  startedAt: string; endedAt: string;
}

/** Synthetic non-ran step for resolution failures at the one call site
 *  (setup smoke) that must report honestly instead of crashing. exitCode
 *  null = "could not run at all", the same infra truth a spawn error gives. */
function unresolvedStep(root: string, pm: string, step: PlanStep, err: unknown): StepResult {
  const at = new Date().toISOString();
  const msg = String(err);
  // the command is usually still computable here (resolution failed, not
  // validation) — but never at the cost of throwing inside a failure reporter
  let argv: string[];
  try { argv = stepCommand(pm, step); } catch { argv = [pm, 'run', step.script]; }
  return {
    kind: step.kind, display: argv.join(' '), ok: false, exitCode: null, secs: 0,
    tail: msg, argv, cwd: scopeDir(root, step), stdout: '', stderr: msg,
    execArgv: [], exec: { file: '', digest: null, via: 'unresolved', policy: ENV_POLICY },
    startedAt: at, endedAt: at,
  };
}

export function runPlanStep(root: string, pm: string, step: PlanStep, timeoutMs = 600_000): StepResult {
  const argv = stepCommand(pm, step); // throws unless the step's command is fully validated
  const display = argv.join(' ');
  const program = argv[0] as string;
  const resolved = resolveProgram(program, step.adapter);
  if (resolved === null) {
    throw new Error(PM_NAMES.has(program)
      ? `package manager "${program}" is not resolvable in Canary's trusted execution environment (the running Node's install dir and OS-managed dirs only — the calling PATH is deliberately ignored). Install it with corepack or into the same Node prefix, then re-run.`
      : `program "${program}" is not resolvable in Canary's trusted execution environment (the running Node's install dir, the OS-managed dirs, and the directories the declaring project adapter names — the calling PATH is deliberately ignored). Install it in one of those locations, or seal its absolute path in the plan, then re-run.`);
  }
  // A step runs in ITS OWN SCOPE's directory. In a nested polyglot repo the
  // scoped check is declared by `<scope>/package.json` (or `<scope>/pyproject
  // .toml`), so running it from the repository root is not merely untidy — the
  // package manager cannot find the manifest and the check fails with
  // `ENOENT ... package.json`, which the smoke caught. `scopeDir` is the same
  // function the plan problems and the sealing use, so there is one answer.
  const cwd = scopeDir(root, step);
  // The step's OWN ecosystem declares what its toolchain needs under the
  // sanitized env (e.g. Go's workspace-scoped GOCACHE/GOPATH). A legacy step has
  // no adapter and therefore no declaration — and needs none.
  const toolchain = (() => {
    try {
      const adapter = adapterForStep({}, step);
      return adapter.toolchainEnv?.({ dir: cwd, workspace: os.tmpdir() });
    } catch { return undefined; }
  })();
  const startedAt = new Date().toISOString();
  const r = spawnHardened(resolved, argv.slice(1), cwd, timeoutMs, toolchain);
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const out = `${stdout}${stderr}`;
  const infra = r.error !== undefined && r.status === null;
  return {
    kind: step.kind, display, ok: !infra && r.status === 0,
    exitCode: infra ? null : r.status, secs: 0,
    tail: out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'),
    argv, cwd, stdout, stderr,
    execArgv: [...resolved.spawnArgv, ...argv.slice(1)],
    exec: { file: resolved.file, digest: execDigest(resolved.file), via: resolved.via, policy: ENV_POLICY },
    startedAt, endedAt: new Date().toISOString(),
  };
}

// ---------- M2 evidence: claims are not evidence ----------

/** M4 identity shape: candidate and baseline share it. `tree` is the git TREE
 *  (content) identity, distinct from the commit — two commits with the same
 *  tree verify the same bytes. */
export interface Identity { resolved: boolean; head: string | null; tree: string | null; dirty: boolean | null }
/** M4 baseline: who the repo was AT THE MOMENT CANARY WAS WIRED, stamped by
 *  Canary's own read-only probes. The honest anchor the onboarding path has:
 *  setup sees the present, never the agent's past — `at` names when the
 *  stamp was taken, so no bundle claims to know pre-agent state it cannot. */
export interface BaselineStamp extends Identity { at: string }

/** Read-only, fixed-argv git probes (same spawn pattern as configTracked).
 *  A fake .git dir that cannot answer is recorded as UNIDENTIFIED — the
 *  evidence bundle never upgrades an unknown candidate into a known one.
 *  Containment, not just answers: git discovery walks UP, so when root/.git
 *  is absent or invalid and some ANCESTOR is a real repo, `status` exits 0
 *  with the PARENT's file list while `HEAD` may fail outright — reporting
 *  that as this candidate's identity is a misattribution (found by the
 *  2026-09-07 environment: a stray zero-commit repo under %TEMP%'s home).
 *  The toplevel must resolve to root itself — linked worktrees and
 *  submodules do; a parent repo does not — or everything is UNIDENTIFIED. */
/** One containment gate for EVERY read-only git probe Canary makes: fixed
 *  argv, run under `-C root`, and the answer must be ABOUT root — git
 *  discovery walks up, so a parent repo answering for a fake/absent .git
 *  is a misattribution, not information (see candidateIdentity's history:
 *  found via a stray zero-commit repo under the home dir). M6's diff
 *  signals and M7's protected-surface reads share this one door. */
const withinRootGate = new Map<string, boolean>();
export function gitWithinRoot(root: string, args: string[]): string | null {
  const run = (a: string[]): string | null => {
    // hardened env + trusted git binary (blocker 1): GIT_*/NODE_OPTIONS/PATH
    // shims can no longer forge the identity or diffs that feed verdicts.
    const r = gitCommand(root, a);
    return r !== null && r.status === 0 ? r.stdout : null;
  };
  // The gate is a fact about this process's filesystem ("is root its own git
  // toplevel"), so it is computed ONCE per real path — one verify ran ~17
  // identical `rev-parse --show-toplevel` children. What the memo NEVER caches
  // is a probe's answer: every real query below still runs live, so a repo
  // that vanished or was swapped mid-process fails its own probe (null =
  // fail-closed) no matter what the gate remembers.
  const rootReal = containedRealPath(root, root);
  if (rootReal === null) return null; // root itself unresolvable — the same refusal as a failed gate
  let gated = withinRootGate.get(rootReal);
  if (gated === undefined) {
    const top = run(['rev-parse', '--show-toplevel']);
    const topReal = top === null ? null : (top.trim() ? containedRealPath(root, top.trim()) : null);
    gated = top !== null && topReal !== null && topReal === rootReal;
    withinRootGate.set(rootReal, gated);
  }
  if (!gated) return null; // not a repo at all — or answered about an ancestor, not about root
  return run(args);
}

export function candidateIdentity(root: string): Identity {
  const unidentified: Identity = { resolved: false, head: null, tree: null, dirty: null };
  const head = gitWithinRoot(root, ['rev-parse', 'HEAD']);
  if (head === null || head.trim().length === 0) return unidentified;
  const tree = gitWithinRoot(root, ['rev-parse', 'HEAD^{tree}']);
  const status = gitWithinRoot(root, ['status', '--porcelain']);
  // The index can be made to LIE about dirtiness: --assume-unchanged prints a
  // lowercase status letter and --skip-worktree prints 'S' in `ls-files -v`,
  // and both hide a tracked edit from `git status` entirely. That lie is
  // precisely what promotion must never eat: the verdict would judge working-
  // tree bytes while the ff-only apply fast-forwards different COMMITTED
  // bytes, and gate 2's dirty refusal would read "clean". Treat any flagged
  // entry as dirty (fail-closed; ls-files silent = unknowable, do not guess).
  const flags = gitWithinRoot(root, ['ls-files', '-v']);
  const sneaky = status === null ? false : flags !== null && /^(?:[a-z]|S) /m.test(flags);
  return {
    resolved: true,
    head: head.trim(),
    tree: tree?.trim() ?? null,
    dirty: status === null || flags === null ? null : status.trim().length > 0 || sneaky,
  };
}

/** Derive test counts FROM THE BYTES CANARY CAPTURED (or from claim text —
 *  same parser, applied to untrusted input). Observation only: nothing here
 *  can make a command succeed or fail; the exit code remains the oracle and
 *  a printed summary is just another claim.
 *  Cost is bounded twice over (M2 review): only the LAST 256 KiB is scanned
 *  (summaries sit at the tail anyway) and the jest gap is a bounded `{0,120}`
 *  lazy — an adversarial multi-MB single line of "Tests:Tests:..." cannot
 *  stall the hook (an unbounded [^\n]*? here is per-start quadratic, and a
 *  hung checkpoint gets the hook killed, which fails the stop gate open). */
export function deriveObservedCounts(raw: string): { parser: string; passed: number; failed: number } | null {
  const text = raw.length > 262_144 ? raw.slice(-262_144) : raw;
  const families: Array<[string, RegExp, RegExp]> = [
    ['node --test', /#\s*pass\s+(\d+)/, /#\s*fail\s+(\d+)/],
    ['mocha', /(\d+)\s+passing\b/, /(\d+)\s+failing\b/],
    ['jest', /Tests:[^\n]{0,120}?(\d+)\s+passed/, /Tests:[^\n]{0,120}?(\d+)\s+failed/],
    ['vitest', /Tests\s+(\d+)\s+passed/, /Tests\s+(\d+)\s+failed/],
  ];
  for (const [parser, pass, fail] of families) {
    const matches = (re: RegExp): RegExpMatchArray[] => [...text.matchAll(new RegExp(re.source, `${re.flags}g`))];
    const pm = matches(pass).pop();
    if (!pm) continue;
    const fm = matches(fail).pop();
    return { parser, passed: Number(pm[1]), failed: fm ? Number(fm[1]) : 0 };
  }
  return null;
}

/** Which env vars that steer child behavior were present (NAMES only, never
 *  values — a token in NODE_OPTIONS is not evidence to store). */
function relevantEnvNames(): string[] {
  return Object.keys(process.env)
    .filter((k) => /^(npm_config_|NODE_OPTIONS$|NODE_PATH$|CI$)/.test(k))
    .sort();
}

// ---------- M3 evidence trust classes ----------
/**
 * Every evidence item belongs to exactly ONE class, stamped by the code that
 * WRITES its bytes — the label describes the writer, it is never authority:
 *
 *   CANARY_OBSERVED      Canary executed it itself (verification bundles).
 *   EXTERNALLY_VERIFIED  a third party's executed proof, imported by a human
 *                        (CI attestation, GLM audit). NO PRODUCER EXISTS YET:
 *                        until a real import path is built, anything on disk
 *                        claiming this class is unvalidated text at best
 *                        AGENT_REPORTED.
 *   AGENT_REPORTED       the worker's own words (claims file). A hint with
 *                        ZERO verdict authority — never sufficient for PASS,
 *                        never creates a BLOCK.
 *
 * Enforcement is STRUCTURAL, not label-based: a verdict is produced only
 * from checks Canary executes in the same invocation, and evidence is never
 * read back for one (M2 doctrine). So copying a bundle, self-declaring a
 * class inside file content, or renaming AGENT_REPORTED bytes into a
 * Canary-owned path all change NOTHING — the classes are honest description
 * for humans and downstream tooling, and the tests pin that they stay inert
 * as input.
 */
export type TrustClass = 'CANARY_OBSERVED' | 'EXTERNALLY_VERIFIED' | 'AGENT_REPORTED';

// ---------- M4 provenance ----------
/**
 * M4 answers the questions authoritative evidence must carry: WHAT plan
 * (planDigest) and WHAT task (task digest, optional), WHICH CODE (baseline +
 * candidate head/tree), WHERE (per-step cwd), WHEN (per-step start/end),
 * WHAT HAPPENED (exit codes, raw-byte hashes, artifacts) — and the
 * verification.sha256 companion binds the whole answer together. All of it is
 * OBSERVATION recorded by the executing code and is never consulted for a
 * verdict (M2 doctrine stands): provenance documents proof, it never replaces
 * it, and no field here claims cryptographic authenticity — there is no
 * signing key; the bundle hash is tamper-EVIDENCE against corruption and
 * accidental edit, nothing more.
 */
/** Bundle provenance, computed by the CALLER from trusted state (config) or
 *  observation — never from file content read back off the evidence dir. */
export interface BundleProvenance {
  planDigest: string;
  baseline: BaselineStamp | null;
  /** digest of the optional task string a hook sent; raw prose is never stored */
  taskDigest?: string;
}

// ---------- M6 (spec M5): orchestrate the right proof for the task ----------
/**
 * Beyond "run whatever npm test exists": each task kind carries PROOF
 * OBLIGATIONS evaluated against what Canary itself observed (sealed-plan
 * execution + contained git diffs), not against what the worker says.
 *
 * Direction of travel is one-way (this is what keeps the hint honest):
 * classification can only ADD obligations — the sealed plan (M5) is the floor
 * no declaration lifts, and no task kind can excuse a failing check. A worker
 * who declares "ui" still gets diff-implied coverage obligations; a worker who
 * declares nothing still gets the diff-implied ones. `canary task` is
 * AGENT_REPORTED — same zero-authority plumbing as `canary claim`.
 *
 * Statuses: `met` (Canary observed it this invocation), `unproven` (obligation
 * stands, no objective proof available — allowed through WITH an honest
 * systemMessage, never a silent fake-complete), `unmet` (objectively violated
 * — blocks). Per spec: do not pretend subjective requirements have
 * deterministic truth; prove every objective part; mark what remains unproven;
 * ask the human one concise question only when necessary (the multi-part
 * enumeration hint) — inference first, question last.
 *
 * Attribution honesty: only deletions Canary can ATTRIBUTE block — COMMITTED
 * ones (baseline..HEAD is post-baseline by construction) and STAGED/WORKTREE
 * ones when setup stamped the tree CLEAN. The index is never snapshotted at
 * setup, so pre-existing staged residue is the same epistemic class as worktree
 * dirt: a repo that was already dirty (or whose state Canary never proved)
 * cannot have its pre-existing state blamed on the agent (M4). Unattributable
 * signals inform notes, never verdicts.
 */

const KIND_PATTERNS: Array<[RegExp, TaskKind]> = [
  /**
   * v1.3 — the ORDINARY ways a developer states a defect, not only the jargon.
   *
   * MEASURED (tooling/probes/v13-journey-baseline.mjs; and this repository's own benchmark fixture
   * `bug-sum`, whose task statement is "This small Node project has a test suite (npm test) that is
   * currently failing."): the previous vocabulary — bug/fix/broken/crash/regress/defect — inferred
   * NOTHING from the most common way a failing task is described. `work` then froze an EMPTY kind set
   * and `finish` refused a correct, tested, discriminating fix with `task-authority UNPROVEN`, after
   * the whole session had been spent. Canary knew at handoff; this is the cheap half of the repair.
   *
   * The words added here all ASSERT brokenness rather than mention a topic. That distinction is the
   * whole safety argument: a `bugfix` kind adds ONE duty — a measured base-vs-candidate discrimination
   * — and unlike "error handling" (a feature that merely contains the word "error"), every phrase
   * below describes behaviour that is wrong, so the duty it adds is one the change can discharge.
   * A mislabel still only ever ADDS work; nothing here can remove a duty.
   */
  [/\b(bug|fix|broken|crash|regress\w*|defect|wrong|incorrect|failing|fails?|misbehav\w*)\b/i, 'bugfix'],
  [/\b(?:does\s?n[o']?t|do(?:es)?\s+not|don'?t|not|never)\s+work(?:ing|s|ed)?\b/i, 'bugfix'],
  [/\b(refactor\w*|restructure|extract (a |the )?(method|function|class)|clean[- ]up)\b/i, 'refactor'],
  [/\b(dependenc\w+|lockfile|upgrade .{0,20}package|bump .{0,20}version|npm (install|update|add))\b/i, 'dependency'],
  [/\b(performance|benchmark|faster|slower|latency|throughput|speed up|slow\w* down|memory usage|optimi[sz]\w+)\b/i, 'performance'],
  // blocker 3: SUBJECTIVE aesthetic language is a ui duty — "make it
  // prettier" must infer, never fall through to taskless. Deterministic
  // markers only: this is a floor, not a language-understanding subsystem.
  [/\b(prett\w*|prettif\w+|beautif\w+|polish\w*|styli[sz]\w*|stylish|visual\w*|aesthetic\w*|ux|look and feel|make it pop)\b/i, 'ui'],
  // blocker 3: a MEASURABLE target is a performance duty even when the word
  // "performance" is absent — "< 2 seconds", "under 500ms", "at least 60fps".
  [/<\s*\d+(\.\d+)?\s*(ms|msecs?|secs?|seconds?|minutes?|mb|gb|kb|fps|%)/i, 'performance'],
  [/\bunder \d+(\.\d+)?\s*(ms|secs?|seconds?|minutes?|mb|gb|fps|%)\b/i, 'performance'],
  [/\bat least \d+(\.\d+)?\s*(fps|mb|gb|%)\b/i, 'performance'],
  [/\b(ui|interface|screen|render|component|css|button|dialog|page|browser|e2e|accessibility)\b/i, 'ui'],
  [/\b(multi[- ]?part|several requirements|requirements? (below|listed|following)|each (of the )?(parts|requirements|items))\b/i, 'multi'],
];

/** Collect every kind a prose hint suggests (union — a mislabel adds work, never removes it). */
export function inferTaskKinds(text: string): TaskKind[] {
  const found = new Set<TaskKind>();
  for (const [re, kind] of KIND_PATTERNS) if (re.test(text)) found.add(kind);
  return [...found];
}

const isTestDirPath = (p: string): boolean =>
  /(^|[\\/])(tests?|__tests__|spec[s]?)([\\/]|$)/i.test(p);
const isTestPath = (p: string): boolean =>
  isTestDirPath(p)
  || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p)   // node: *.test.ts / *.spec.js
  || /(^|[\\/])test_[^\\/]*\.py$/i.test(p)     // python: test_*.py
  || /_test\.py$/i.test(p)                     // python: *_test.py
  || /_test\.go$/i.test(p)                     // go: *_test.go
  || /_test\.rs$/i.test(p);                    // rust: *_test.rs
// Lockfiles ONLY: package.json edits are authority moves (script text — M5's
// sealed turf), not dependency-graph evidence, and blaming them here made
// every setup-repair story trip the dep obligation. A deps bump without a
// lockfile change is still caught one-way by `canary task --kind dependency`.
// 1.1: every REGISTERED adapter's declared manifests count as well, so a
// python/rust/go lockfile change is dependency evidence through the same one
// predicate — never guessed from a file extension.
const isDepPath = (p: string): boolean => {
  const base = p.split(/[\\/]/).pop() ?? '';
  if (LOCKFILES.some(([f]) => base === f)) return true;
  return Object.values(ADAPTERS).some((a) => a.dependencyPaths.includes(base));
};
/** A path rides human-facing notes ONLY in this shape (odd names collapse —
 *  classification never sees this layer: git probes answer in -z raw bytes). */
function safePath(p: string): string {
  const q = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return /^[A-Za-z0-9 ._\-/:@+~]{1,160}$/.test(q) ? q : '<odd path>';
}
function formatPaths(list: string[]): string {
  const head = list.slice(0, 8).map(safePath).join(', ');
  return list.length > 8 ? `${head} (+${list.length - 8} more)` : head;
}

/** One parsed change entry from git name-status / porcelain output. */
export interface ChangeEntry { st: 'add' | 'mod' | 'del' | 'ren'; paths: string[] }

const NAME_ST: Record<string, ChangeEntry['st']> = { A: 'add', M: 'mod', D: 'del', R: 'ren', C: 'ren', T: 'mod', U: 'mod' };
/** `git diff --name-status -z` output: NUL-separated status + 1-2 RAW paths.
 *  -z is what makes classification trustworthy: git C-quotes (wraps in `"` and
 *  octal-escapes) any non-ASCII/quote/backslash path in line mode, and the
 *  quote characters silently defeated isTestPath/isDepPath at both ends — a
 *  committed deletion of tests/ünï.test.js went SILENT (M6 review #1, major:
 *  one non-ASCII character evaded the coverage-loss gate). Raw -z bytes have
 *  no quoting to outsmart. Unknown status codes degrade to mod, never crash. */
export function parseNameStatus(out: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const stRaw = toks[i]!;
    if (!stRaw) continue;
    const st = NAME_ST[stRaw.charAt(0)] ?? 'mod';
    if (st === 'ren') {
      const old = toks[++i]; const nw = toks[++i];
      if (old !== undefined && nw !== undefined) entries.push({ st, paths: [old, nw] });
    } else {
      const p = toks[++i];
      if (p !== undefined) entries.push({ st, paths: [p] });
    }
  }
  return entries;
}

/** `git status --porcelain -z` output: each entry is "XY path" NUL-terminated;
 *  R/C entries are followed by a second NUL-terminated path (the NEW name).
 *  In -z mode git never quotes and never joins renames with ' -> ', so a real
 *  filename containing ' -> ' or `"` cannot mis-split old/new sides either.
 *  `??` is untracked = add-shaped. */
export function parsePorcelain(out: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const line = toks[i]!;
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const body = line.slice(3);
    if (xy === '??') { entries.push({ st: 'add', paths: [body] }); continue; }
    if (xy.includes('R') || xy.includes('C')) {
      const nw = toks[++i];
      if (nw !== undefined) entries.push({ st: 'ren', paths: [body, nw] });
      continue;
    }
    let st: ChangeEntry['st'] = 'mod';
    if (xy[0] === 'A') st = 'add';
    if (xy.includes('D')) st = 'del';
    entries.push({ st, paths: [body] });
  }
  return entries;
}

/** Deletion-shaped paths: plain deletes, plus renames whose NEW side escaped
 *  test shape — either entirely (git mv tests/x.test.js docs/x.md) or out of
 *  the test DIRECTORY while keeping a .test.js suffix (tests/x.test.js →
 *  src/x.test.js: most runners' include scope is directory-shaped, so the
 *  moved file silently stops executing while the suffix pretends coverage
 *  survived). A move that keeps the directory shape (tests/a → tests/sub/a)
 *  is intact; suffix-only repos (old never dir-matched) are not touched —
 *  their scope is unknowable without reading runner config, which is NOT
 *  sealed (stated ceiling, final report). Exported for contract pins (#5). */
export const delPaths = (entries: ChangeEntry[]): string[] =>
  entries.flatMap((e) => (e.st === 'del' ? e.paths : e.st === 'ren' && (!isTestPath(e.paths[1]!) || (isTestDirPath(e.paths[0]!) && !isTestDirPath(e.paths[1]!))) ? [e.paths[0]!] : []));

export interface DiffSignals {
  /** at least one attributable git source answered (committed or staged diff) */
  resolved: boolean;
  /** every touched path from any source (committed + staged + worktree) */
  touched: string[];
  /** touched EXCLUDING deletion paths — renames count by their NEW side only.
   *  Regression evidence is "a test was added/changed", never "a test vanished"
   *  (review #4). depTouched still keys off `touched`: a deleted lockfile is a
   *  dependency change. */
  changes: string[];
  /** deletions of test-shaped paths Canary can attribute to this session — the BLOCK signal */
  deletedTestsAttributable: string[];
  /** test deletions it cannot attribute (staged/worktree on a non-clean baseline) — note material only */
  deletedTestsUnattributable: string[];
  /** the baseline stamp PROVED dirt at setup; false also covers "never stamped /
   *  unresolved / probe failed", where the note must not claim otherwise (review #6) */
  setupDirtProven: boolean;
  depTouched: boolean;
}

/** Shared core of the diff-signal collection: three -z git outputs in,
 *  attribution out. blameClean = "the tree AND index provably matched HEAD at
 *  the baseline, so staged/worktree deletions cannot be pre-existing dirt".
 *  Both callers below answer that question from a DIFFERENT premise. */
function diffSignalsFrom(committed: string | null, staged: string | null, worktree: string | null, blameClean: boolean, setupDirtProven: boolean): DiffSignals {
  if (committed === null && staged === null && worktree === null) {
    return { resolved: false, touched: [], changes: [], deletedTestsAttributable: [], deletedTestsUnattributable: [], setupDirtProven, depTouched: false };
  }
  const fromCommitted = committed !== null ? parseNameStatus(committed) : [];
  const fromStaged = staged !== null ? parseNameStatus(staged) : [];
  const fromWorktree = worktree !== null ? parsePorcelain(worktree) : [];
  // Attribution: a baseline Canary stamped CLEAN proves the tree AND index
  // matched HEAD at setup, so deletions seen now — staged or unstaged —
  // CANNOT be pre-existing dirt; they are the agent's. Without that proof
  // (dirty or unknown baseline) both classes stay note-material only: the
  // index is never snapshotted, so pre-existing staged residue is epistemically
  // the worktree case, not the committed case (review #3 — design (c) blesses
  // baseline..HEAD alone, which is post-baseline by construction).
  const attributable = blameClean ? [...fromCommitted, ...fromStaged] : fromCommitted;
  const wtOnlyDel = blameClean
    ? delPaths(fromWorktree).filter((p) => !attributable.some((e) => e.paths.includes(p)))
    : [];
  const attrDel = [...delPaths(attributable), ...(blameClean ? wtOnlyDel : [])];
  const residDel = [...delPaths(fromStaged), ...delPaths(fromWorktree)].filter((p) => !attrDel.includes(p));
  const touched = [...new Set([...attributable, ...fromStaged, ...fromWorktree].flatMap((e) => e.paths))];
  const changes = [...new Set([...attributable, ...fromStaged, ...fromWorktree].flatMap((e) =>
    e.st === 'del' ? [] : e.st === 'ren' ? [e.paths[1]!] : e.paths))];
  return {
    // "resolved" = the candidate-vs-BASELINE story is knowable: either git
    // answered the sealed baseline directly, or a clean baseline makes the
    // worktree diff that story. Staged-only answers do not count.
    resolved: blameClean || committed !== null,
    touched,
    changes,
    deletedTestsAttributable: [...new Set(attrDel)].filter(isTestPath),
    deletedTestsUnattributable: [...new Set(residDel)].filter(isTestPath),
    setupDirtProven,
    depTouched: touched.some(isDepPath),
  };
}

/** Read-only contained git probes (gitWithinRoot — the parent repo never answers
 *  for the candidate). A malformed baseline head from a hand-edited config is
 *  dropped rather than interpolated: defense-in-depth below the distrust gate. */
export function collectDiffSignals(root: string, cfg: CanaryConfig): DiffSignals {
  const baselineHead = cfg.baseline?.head ?? null;
  // -z everywhere classification reads: line mode C-quotes non-ASCII/quote/
  // backslash paths and silently defeats isTestPath/isDepPath (review #1).
  const committed = cfg.baseline?.resolved && baselineHead !== null && /^[0-9a-f]{40,64}$/i.test(baselineHead)
    ? gitWithinRoot(root, ['diff', '--name-status', '-z', baselineHead, 'HEAD']) : null;
  const staged = gitWithinRoot(root, ['diff', '--name-status', '-z', '--cached']);
  const worktree = gitWithinRoot(root, ['status', '--porcelain', '-z']);
  return diffSignalsFrom(committed, staged, worktree,
    cfg.baseline !== undefined && cfg.baseline.resolved && cfg.baseline.dirty === false,
    cfg.baseline?.dirty === true);
}

/** M10 (directive §10) — the same signals for a CANDIDATE worktree, diffed
 *  against the record's frozen baseHead (conflating cfg.baseline here would
 *  blame the base's own post-setup commits on the worker). The attribution
 *  premise differs from collectDiffSignals and is PROVEN, not stamped:
 *  `git worktree add --detach` checks out exactly the resolved commit and
 *  isolateCreate post-verifies HEAD before registering — the candidate began
 *  provably clean, so every deletion seen now is the candidate's. If the
 *  baseHead..HEAD probe cannot answer (pruned object? fake git?), the premise
 *  is moot: blameClean drops to false and deletions land UNATTRIBUTABLE —
 *  fail-safe to UNPROVEN, never a false `met`. */
export function candidateDiffSignals(root: string, baseHead: string): DiffSignals {
  const committed = /^[0-9a-f]{40,64}$/i.test(baseHead)
    ? gitWithinRoot(root, ['diff', '--name-status', '-z', baseHead, 'HEAD']) : null;
  const staged = gitWithinRoot(root, ['diff', '--name-status', '-z', '--cached']);
  const worktree = gitWithinRoot(root, ['status', '--porcelain', '-z']);
  return diffSignalsFrom(committed, staged, worktree, committed !== null, false);
}

export interface Obligation { id: string; mode: 'objective' | 'non-objective'; status: 'met' | 'unproven' | 'unmet'; note: string;
  /** A MET obligation whose evidence is weaker than the word "met" suggests — said plainly, never hidden. */
  caveat?: string }

/**
 * Canary's OWN wiring is not the product under test.
 *
 * MEASURED: `setup` installs the Stop hook into `.claude/settings.json` and writes `.canary/`
 * AFTER the baseline commit, so a repository with no code change at all still showed those paths as
 * "the candidate's change" — and the regression-evidence question, correctly asked, then reported
 * NOT PROVEN for a project nobody had touched (the probe's case D). Counting the verifier's own
 * files as the change is a measurement error, not a strict rule.
 */
const isCanaryOwnArtifact = (p: string): boolean =>
  p === '.claude' || p.startsWith('.claude/')
  || p === CONFIG_DIR || p.startsWith(`${CONFIG_DIR}/`)
  // v1.3 §C: setup now writes the MCP server entry itself. Without this the freshly written
  // `.mcp.json` would count as "the change", `planDiscrimination` would find the sealed checks green
  // on the base too, and EVERY repo would report NOT PROVEN the moment it was wired — the verifier's
  // own file mistaken for the author's work, which is the same measurement error this list exists for.
  || p === MCP_CONFIG_BASENAME;

/**
 * Paths whose change cannot alter the product's BEHAVIOUR, so there is nothing for a regression check
 * to discriminate: prose, licences, ignore files. Manifests are deliberately NOT here — a version or
 * script change in `package.json` is behaviour a user sees, and it is exactly what a bump task must
 * prove.
 */
const isNonBehaviourPath = (p: string): boolean =>
  /\.(md|markdown|txt|rst)$/i.test(p)
  || /(^|[\\/])(docs?|licen[cs]e|changelog|news|contributing|code_of_conduct)([\\/.]|$)/i.test(p)
  || /(^|[\\/])\.gitignore$/i.test(p);

/**
 * Generated and cached files are not the candidate's change.
 *
 * MEASURED false positive: the documented Python journey runs `setup` then `doctor` with NO edit at
 * all, and the second `doctor` reported NOT PROVEN — because running the sealed checks had created
 * `__pycache__/*.pyc` inside the repository, which git reports as an untracked change. Anything the
 * toolchain generates belongs to the run, not to the author, and asking for regression evidence
 * about a byte-compiled cache file is an invented duty.
 */
const isGeneratedArtifact = (p: string): boolean =>
  /(^|[\\/])__pycache__([\\/]|$)/.test(p)
  || /(^|[\\/])(node_modules|\.venv|venv|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|target|out|coverage|\.nyc_output|\.next|\.turbo|obj|bin)([\\/]|$)/.test(p)
  || /\.(pyc|pyo|pyd|class|o|obj|log|tmp|temp|bak|swp)$/i.test(p)
  || /(^|[\\/])\.coverage$/i.test(p)
  || /\.egg-info([\\/]|$)/.test(p);

/**
 * THE REGRESSION-EVIDENCE OBLIGATION.
 *
 * The product invariant this implements, in the owner's words: *existing behaviour that must be
 * preserved requires regression evidence, and missing or ambiguous proof must fail closed, never
 * degrade to PASS.*
 *
 * `planDiscrimination` measures whether the sealed checks are SENSITIVE to this change. That
 * measurement becomes an ordinary proof obligation here, so the checkpoint gate, `doctor` and the
 * promotion path all read one thing — and an obligation that is `unproven` is NOT a pass.
 *
 * `null` means no comparison duty applies (for example, no behavior changed).
 * A required comparison that could not run remains objectively UNPROVEN.
 */
export function discriminationObligation(root: string, cfg: CanaryConfig, timeoutMs = 600_000, isolationBase?: string): Obligation | null {
  const disc = planDiscrimination(root, cfg, timeoutMs, isolationBase);
  if (!disc.applicable) return null;
  if (disc.basePassed === null) return {
    id: 'regression-evidence', mode: 'objective', status: 'unproven',
    note: `required baseline comparison could not be established: ${disc.reason} — regression evidence UNPROVEN; restore the comparison prerequisites and re-run verification`,
  };
  const files = disc.changedPaths.slice(0, 4).map(safePath).join(', ');
  const more = disc.changedPaths.length > 4 ? ` (+${disc.changedPaths.length - 4} more)` : '';
  if (disc.basePassed === true) {
    return {
      id: 'regression-evidence', mode: 'objective', status: 'unproven',
      note: `the sealed checks pass on the base commit too, so they carry no evidence about this change (${files}${more}): existing behaviour that must be preserved needs a check that FAILS without the change and passes with it. Add or bind one (a sealed proof obligation), or a human accepts the risk from an interactive terminal — a green plan alone does not close this`,
    };
  }
  return {
    id: 'regression-evidence', mode: 'objective', status: 'met',
    note: `the sealed checks fail without this change (${disc.baseFailures.join(', ') || 'a sealed step'}), so their pass is evidence about it${disc.overlaidChecks.length > 0 ? ` (candidate check files overlaid on the base: ${disc.overlaidChecks.slice(0, 3).map(safePath).join(', ')})` : ''}`,
    ...(disc.addedChecks.length > 0
      ? { caveat: `the evidence that discriminates this change includes check file(s) THIS SESSION ADDED (${disc.addedChecks.slice(0, 3).map(safePath).join(', ')}) — sensitive to the change, but written by the same worker whose work it judges. Independent coverage needs an operator-bound check (package.json canary.proofs, or canary.project.json proofs) or a human's acceptance` }
      : {}),
  };
}


function copyInto(fromRoot: string, toRoot: string, relPath: string): boolean {
  try {
    const src = path.join(fromRoot, relPath);
    const dst = path.join(toRoot, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch { return false; }
}

/**
 * A failure that says "the comparison could not run" rather than "the checks caught the change".
 *
 * MEASURED REASON this exists: the discrimination run compares a BASE tree (plus the candidate's
 * check files) against the candidate. If a new check needs a new fixture file that lives outside
 * the check directories, the base run fails with ENOENT — and reading that as "the checks
 * discriminate" would mint a PASS out of a missing file. Anything that looks like a broken
 * environment is therefore UNESTABLISHED, never evidence.
 */
function looksLikeInfraFailure(r: StepResult): boolean {
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return /ENOENT|Cannot find module|MODULE_NOT_FOUND|no such file or directory|package\.json not found|could not determine executable|command not found|is not recognized as an internal or external command/i.test(text);
}

export interface DiscriminationResult {
  /** false only when no comparison duty applies; true with basePassed:null means UNPROVEN. */
  applicable: boolean;
  reason: string;
  changedPaths: string[];
  overlaidChecks: string[];
  /**
   * Check files that did NOT exist at the sealed baseline — i.e. written by THIS session.
   *
   * MEASURED reason this is recorded (`bench-final-constraint-hold-guarded-3`): an agent added
   * `tests/csv-quoted.test.js` (assertions 6 → 18), the sealed plan passed, the hidden oracle found
   * the stated rule still broken, and Canary said READY. The regression evidence was REAL (the new
   * check fails without the change) and simultaneously the worker's own reading of the requirement —
   * SENSITIVITY, not independence. A verdict that rests on it must say so.
   */
  addedChecks: string[];
  basePassed: boolean | null;
  baseFailures: string[];
}

/**
 * DOES THE SEALED PLAN ACTUALLY DISCRIMINATE THIS CHANGE?
 *
 * The completion gate's original question is "do the operator's checks pass?". The stronger
 * question this answers — and the one the owner's reliability target needs — is "do they pass
 * BECAUSE of this change, or would they have passed anyway?".
 *
 * MEASURED reason it matters (`bench-r5-refactor-preserve-invisible-2`): an agent rewrote
 * `formatMoney`'s string handling, ran nothing, and finished while `formatMoney("0.5")` returned
 * `$0.05`. The project's checks passed before AND after the change, so Canary reported READY — a
 * false green that no amount of care in the runner can catch, because the checks simply do not
 * discriminate that change.
 *
 * The experiment is the classic one: run the sealed plan against the BASE commit with the
 * candidate's CHECK files overlaid, which asks "do the checks fail without the source change?".
 *   - they FAIL  -> the plan discriminates this change, and its pass is evidence about it;
 *   - they PASS  -> whatever the plan proves, it does not prove THIS change;
 *   - they cannot run (missing module/fixture/manifest) -> UNESTABLISHED, which is neither answer.
 *
 * It never writes a verdict by itself: it returns the measurement, and the caller decides what an
 * unproven change means. It also never mutates the working tree — the comparison happens in a
 * throwaway `git worktree` at the sealed baseline, removed in a `finally`.
 */
export function planDiscrimination(root: string, cfg: CanaryConfig, timeoutMs = 600_000, isolationBase?: string): DiscriminationResult {
  const none = (reason: string, changedPaths: string[] = []): DiscriminationResult =>
    ({ applicable: false, reason, changedPaths, overlaidChecks: [], addedChecks: [], basePassed: null, baseFailures: [] });
  const unknown = (reason: string, changedPaths: string[] = []): DiscriminationResult =>
    ({ ...none(reason, changedPaths), applicable: true });

  const signals = isolationBase === undefined ? collectDiffSignals(root, cfg) : candidateDiffSignals(root, isolationBase);
  /**
   * A baseline stamped DIRTY cannot attribute worktree changes to this session — the very same
   * doctrine the obligation engine uses for deletions. MEASURED case that forced this: `canary
   * setup` re-run after a script swap (the operator deliberately re-sealing) stamps a dirty baseline,
   * and the uncommitted `package.json` that caused the re-seal was then asked for regression
   * evidence about itself. The operator's own re-seal is not the worker's change.
   */
  /**
   * Dependency manifests and lockfiles are excluded from the DISCRIMINATION question, for two
   * measured reasons. (1) Running the sealed checks can REWRITE them: the Rust journey's
   * `cargo check/test/build` updates `Cargo.lock`, and the gate then demanded regression evidence
   * for a file the toolchain had just touched. (2) When the agent really does move a dependency,
   * that is already its own obligation (`dependency-change`), not a behaviour change a regression
   * check should discriminate.
   */
  const changed = signals.changes.filter((p) =>
    !isCanaryOwnArtifact(p) && !isGeneratedArtifact(p) && !isDepPath(p));
  if (changed.length === 0) return none('the working tree has no change to discriminate');
  /**
   * A change that touches ONLY check/definition files has no product behaviour to discriminate:
   * adding a test, editing docs, or re-sealing a manifest cannot make the project's behaviour
   * different from the base, so demanding "a check that fails without your change" there would be
   * friction without a question behind it. The duty applies to changes to the product.
   */
  if (!changed.some((p) => !isTestPath(p) && !isNonBehaviourPath(p))) {
    return none('only check/documentation files changed — there is no product behaviour to discriminate', changed);
  }

  if (!signals.resolved) return unknown('the change cannot be attributed to the sealed baseline, so the comparison premise does not hold', changed);
  if (signals.setupDirtProven) return unknown('the repo was already dirty at setup, so this change cannot be attributed to the worker', changed);
  const head = isolationBase ?? cfg.baseline?.head ?? null;
  if (head === null || !/^[0-9a-f]{40,64}$/i.test(head)) return unknown('the sealed baseline has no commit to compare against', changed);

  let tmp: string | undefined;
  let tree: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-discriminate-'));
    tree = path.join(tmp, 'tree');
    if (gitWithinRoot(root, ['worktree', 'add', '--detach', '--force', tree, head]) === null) {
      return unknown('git could not materialize the sealed baseline for a comparison run', changed);
    }
    const overlaid: string[] = [];
    const addedChecks: string[] = [];
    for (const p of changed) {
      if (!isTestPath(p) || !signals.changes.includes(p)) continue;
      // "Did this check file exist at the sealed baseline?" — asked of git, not guessed: a check the
      // session ADDED is the worker's own evidence, and that distinction is the point.
      const atBaseline = gitWithinRoot(root, ['cat-file', '-e', `${head}:${p}`]) !== null;
      if (!atBaseline) addedChecks.push(p);
      if (!copyInto(root, tree, p)) return unknown(`candidate check could not be overlaid: ${safePath(p)}`, changed);
      overlaid.push(p);
    }
    const ran: StepResult[] = [];
    for (const s of cfg.plan) {
      let r: StepResult;
      try { r = runPlanStep(tree, cfg.pm, s, timeoutMs); } catch (e) {
        return unknown(`the sealed checks could not run against the baseline (${String(e).slice(0, 120)})`, changed);
      }
      ran.push(r);
      if (r.exitCode === null) return unknown('the sealed checks could not run against the baseline (the program produced no exit code)', changed);
    }
    if (ran.length === 0) return unknown('no sealed check ran against the baseline', changed);
    const failures = ran.filter((r) => !r.ok);
    if (failures.length > 0 && failures.some(looksLikeInfraFailure)) {
      return unknown('the baseline run failed in an environment-shaped way (a missing module or file), so it proves nothing either way', changed);
    }
    return {
      applicable: true,
      reason: failures.length === 0
        ? 'the sealed checks pass on the base commit too, so they do not demonstrate this change'
        : 'the sealed checks fail without this change, so their pass is evidence about it',
      changedPaths: changed,
      overlaidChecks: overlaid,
      addedChecks,
      basePassed: failures.length === 0,
      baseFailures: failures.map((f) => f.kind),
    };
  } catch (e) {
    return unknown(`the baseline comparison failed (${String(e).slice(0, 120)})`, changed);
  } finally {
    try { if (tree) gitWithinRoot(root, ['worktree', 'remove', '--force', tree]); } catch { /* fall through to the rm */ }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: never fail a verdict on cleanup */ }
  }
}

/** The obligation engine: pure over (kinds, signals, sealed-plan kinds, requirement count).
 *  `planKinds` comes from the SEALED plan — an obligation is only satisfiable
 *  by a command actually sealed at setup; Canary never executes an unsealed
 *  "benchmark" just because the task mentioned one. */
/** `baseline` names the premise the signals were collected against: 'setup'
 *  for the checkpoint/doctor path, 'isolation' at the candidate boundary —
 *  where the state WAS proven clean at registration (isolate post-check), so
 *  an unattributable deletion means the baseHead..HEAD diff cannot be read,
 *  not that the baseline was never established. Default keeps every pre-M10
 *  note byte-identical (m6 contract pins depend on it). */
export function obligationsFor(
  kinds: TaskKind[], sig: DiffSignals, planKinds: Set<string>, requirementCount: number,
  baseline: 'setup' | 'isolation' = 'setup',
  task?: TaskIdentity | null,
  authority?: { plan: PlanStep[]; planAuthority?: PlanAuthority },
): Obligation[] {
  const out: Obligation[] = [];
  const add = (o: Obligation) => { if (!out.some((x) => x.id === o.id)) out.push(o); };
  const has = (k: string) => planKinds.has(k);

  if (kinds.includes('bugfix')) {
    const testTouched = sig.changes.some(isTestPath); // deletions are coverage LOSS, never regression evidence (review #4)
    add(testTouched
      ? { id: 'regression-evidence', mode: 'objective', status: 'unproven', note: 'test files were added/modified, but a changed filename is not regression proof — a measured baseline comparison must establish discrimination' }
      : { id: 'regression-evidence', mode: 'objective', status: 'unproven', note: `no test file was added or changed since ${baseline} — regression evidence UNPROVEN (an old suite can stay green while the bug survives). Add a test that reproduces the fixed bug.` });
  }
  if (kinds.includes('refactor') || has('tests')) {
    add(has('tests')
      ? { id: 'tests-green', mode: 'objective', status: 'met', note: 'the sealed test run passed against the candidate' }
      : { id: 'tests-green', mode: 'objective', status: 'unproven', note: 'this project\'s sealed plan has no tests step — behavior preservation is UNPROVEN' });
  }
  if (sig.deletedTestsAttributable.length > 0) {
    add({ id: 'coverage-loss', mode: 'objective', status: 'unmet', note: `verification coverage removed by candidate — deleted test files: ${formatPaths(sig.deletedTestsAttributable)}` });
  } else if (sig.deletedTestsUnattributable.length > 0) {
    // the premise must match what Canary actually PROVED (review #6): the stamp
    // saying "dirty" is a different fact from "never established the state".
    // At the candidate boundary the baseline WAS proven clean (isolate
    // post-check), so unattributable means the committed-diff probe went
    // silent — a different honest sentence (correctness review #5).
    const premise = baseline === 'isolation'
      ? 'the candidate-vs-isolation-base committed diff cannot be resolved'
      : sig.setupDirtProven
      ? 'the repo was already dirty at setup'
      : "Canary cannot establish the repo's state at setup";
    add({ id: 'coverage-loss-unattributable', mode: 'objective', status: 'unproven', note: `test files are missing from the working tree but ${premise}, so the deletion cannot be attributed to this session: ${formatPaths(sig.deletedTestsUnattributable)} — whether coverage was lost is UNPROVEN` });
  } else if (kinds.includes('refactor')) {
    add(sig.resolved
      ? { id: 'coverage-loss', mode: 'objective', status: 'met', note: 'no test file was deleted in the candidate diff — verification coverage intact' }
      : { id: 'coverage-loss', mode: 'objective', status: 'unproven', note: 'candidate-vs-baseline diff unresolvable — lost verification coverage cannot be ruled out (UNPROVEN)' });
  }
  if (kinds.includes('dependency') || sig.depTouched) {
    // blocker 2: a duty must name its REAL completion path. Observed dep
    // evidence is listed (meaningful evidence, not mere declaration); a
    // declared-but-unobserved dependency task says so honestly instead of
    // claiming a change it cannot see. Both close via an interactive-terminal
    // acceptance —
    // never auto-met, never a dead end.
    const depFiles = sig.touched.filter(isDepPath);
    add(!sig.depTouched
      ? { id: 'dependency-change', mode: 'non-objective', status: 'unproven', note: 'the task declares dependency work but the candidate diff touches no dependency file — nothing observed to compare, nothing observed to accept; UNPROVEN. Land the change, or accept the candidate as-is from an interactive terminal: canary accept <candidate>' }
      : { id: 'dependency-change', mode: 'non-objective', status: 'unproven', note: sig.resolved
        ? `dependency change observed (${formatPaths(depFiles)}): the sealed plan re-ran against the new graph, but downstream behavior needs a trusted baseline/candidate comparison — UNPROVEN. Closes after review from an interactive terminal: canary accept <candidate>`
        : 'dependency change observed against an unresolvable baseline — comparison UNPROVEN. It can still be closed after review from an interactive terminal: canary accept <candidate>' });
  }
  const numericPerformance = task?.objectiveTargets.some(t => t.kind === 'bench') ?? false;
  const numericUi = task?.objectiveTargets.some(t => t.kind === 'e2e') ?? false;
  if (kinds.includes('performance') && !numericPerformance) {
    add(has('bench') && !task?.subjectivePerformance
      ? { id: 'performance-proof', mode: 'objective', status: 'met', note: 'the sealed benchmark ran and passed (its exit code is the threshold sealed at setup)' }
      : { id: 'performance-proof', mode: 'non-objective', status: 'unproven', note: task?.subjectivePerformance
        ? 'subjective performance feel requires human judgment even when a benchmark passes — UNPROVEN. Review the exact committed candidate and accept from an interactive terminal: canary accept <candidate>'
        : 'a performance obligation needs a repeatable benchmark with a defined threshold; the sealed plan has none — UNPROVEN. Paths to close it: add a bench script and re-run canary setup (seals + smokes it), or accept the measured judgment from an interactive terminal: canary accept <candidate>' });
  }
  if (kinds.includes('ui') && !numericUi && !numericPerformance) {
    add(has('e2e')
      ? { id: 'ui-proof', mode: 'objective', status: 'met', note: 'the sealed e2e/browser proof ran and passed' }
      : { id: 'ui-proof', mode: 'non-objective', status: 'unproven', note: 'no browser/e2e/accessibility proof is available in the sealed plan — UI behavior UNPROVEN (visual truth is not pretend-deterministic). Closes only by judgment from an interactive terminal: canary accept <candidate>' });
  }
  if (task?.subjectiveVisual) add({ id: 'subjective-visual-acceptance', mode: 'non-objective', status: 'unproven',
    note: 'aesthetic satisfaction requires judgment from an interactive terminal; a generic e2e check cannot establish it' });
  for (const target of task?.objectiveTargets ?? []) {
    const script = authority?.planAuthority?.proofBindings?.[target.digest];
    const bound = script !== undefined && authority!.plan.some(s => s.script === script && s.kind === target.kind);
    add({ id: `target-${target.kind}-${target.digest}`, mode: 'objective', status: bound ? 'met' : 'unproven',
      note: bound ? `sealed ${script} checks target ${target.digest}; its successful exit is required independently`
        : `objective target ${target.digest} has no sealed ${target.kind} proof binding. Bind this digest to the matching script in package.json canary.proofs and run setup; acceptance cannot replace measurement.` });
  }
  /**
   * PER-REQUIREMENT COVERAGE, and the binding path that makes it attainable.
   *
   * The invariant: every objective requirement must have a FROZEN proof obligation or remain NOT
   * PROVEN. A requirement is covered when it is either a frozen objective target (a numeric
   * bench/e2e target, bound above) or directly bound in `package.json` `canary.proofs` to a script
   * the sealed plan actually runs — that script's exit code is then the measurement.
   *
   * MEASURED gap this closes: the binding map accepted any requirement digest, but only plans whose
   * requirements happened to LOOK numeric could be covered, and nothing ever printed the digest an
   * operator would need — so the only reachable end state was human acceptance, and "bind it to a
   * sealed check" was advice with no way to follow it.
   */
  const boundScriptFor = (d: string): string | null => {
    const script = authority?.planAuthority?.proofBindings?.[d];
    return script !== undefined && authority!.plan.some(s => s.script === script) ? script : null;
  };
  const digests = task?.requirementDigests ?? [];
  const uncovered = digests.filter(d => !task!.objectiveTargets.some(t => t.digest === d) && boundScriptFor(d) === null);
  if (digests.length > 0 && uncovered.length === 0) {
    const bound = digests.map(d => boundScriptFor(d)).filter((s): s is string => s !== null);
    add({ id: 'per-requirement', mode: 'objective', status: 'met',
      note: `every one of the ${digests.length} registered requirement(s) is covered: ${bound.length > 0 ? `sealed proof script(s) ${[...new Set(bound)].join(', ')}` : 'frozen objective targets'} whose exit codes the sealed plan produces` });
  } else if ((kinds.includes('multi') || requirementCount > 0) && (!task || requirementCount === 0 || uncovered.length > 0)) {
    /**
     * THE CLASSIFICATION MUST NOT CONTRADICT ITS OWN NOTE (v1.2 fix).
     *
     * MEASURED BUG this replaces: the duty was ALWAYS `mode: 'non-objective'`, i.e. closable by a
     * human `canary accept`, while its own note said "acceptance cannot replace measurement for an
     * objective requirement". The consequence was the opposite of the intent: an operator could
     * close an unbound OBJECTIVE requirement with a TTY signature, and — because the Stop hook
     * routes non-objective duties down its operator-only branch — a worker facing it was told
     * "none of them is yours to close" and left to loop. Benchmarked at 1.5-1.85M tokens.
     *
     * The rule now: an uncovered requirement is a MEASUREMENT duty (objective, unproven) unless
     * the registration itself carries a subjective marker. A declared requirement is a
     * requirement; "the dashboard should feel cleaner" is subjective only because it says so, and
     * that case keeps its own acceptance path via `subjective-visual-acceptance` /
     * `subjectivePerformance`.
     */
    const subjectiveRegistration = task?.subjectiveVisual === true || task?.subjectivePerformance === true;
    add({ id: 'per-requirement', mode: subjectiveRegistration ? 'non-objective' : 'objective', status: 'unproven', note: requirementCount > 0
      ? `multi-part task: ${requirementCount} registered requirement(s), ${uncovered.length} with NO sealed proof — a green plan proves the plan, NOT each part. Bind each uncovered digest in package.json canary.proofs to a script your plan runs and re-run canary setup (acceptance cannot replace measurement for an objective requirement)${subjectiveRegistration ? ', or accept the candidate from an interactive terminal (canary accept <candidate>)' : ''} — until then UNPROVEN, never permanently dead`
      : 'multi-part task detected but requirements were never enumerated — ask the human ONCE which parts must be proven separately, or register them: canary task "..." --requirement "..." per part (BEFORE isolation), or accept the candidate as-is from an interactive terminal: canary accept <candidate>' });
  }
  return out;
}

/** One requirement that no sealed check measures, with the plan scripts it could be bound to. */
export interface UnboundRequirement {
  digest: string;
  /** Distinct plan scripts that do NOT already carry a binding — the candidate proof targets. */
  candidateScripts: string[];
}

/** The requirements a registration declared and no frozen binding covers. */
export interface UnboundReport {
  /** Digests with no frozen binding and no frozen objective target. */
  unbound: UnboundRequirement[];
  /** True when the registration itself carries a subjective marker, so acceptance is a real path. */
  subjective: boolean;
  /** Every script the sealed plan will run, so a suggestion is always actionable. */
  planScripts: string[];
}

/**
 * INSPECT A REGISTRATION BEFORE A WORKER IS HANDED ANYTHING (v1.2, Mission 2).
 *
 * WHY THIS EXISTS AS A SEPARATE, PRE-HANDOFF QUESTION: v1.1 could only discover an unbound
 * requirement at the END of a worker's session — at the Stop hook or at `finish` — after the model
 * had already spent its budget trying to close a duty that was never its to close. Measured at
 * 1.5-1.85M tokens for a five-requirement task. The information needed to prevent that is
 * available the moment the task is registered, so it is answered here and consumed by the
 * handoff, rather than rediscovered a million tokens later.
 *
 * It reports facts only: which digests are uncovered, and which plan scripts they could be bound
 * to. It never decides a verdict and never mints a binding.
 */
export function unboundRequirements(
  root: string,
  cfg: { plan: PlanStep[]; planAuthority?: PlanAuthority } | null,
): UnboundReport {
  const task = readTaskRecord(root);
  if (!task || task.requirementDigests.length === 0 || cfg === null) {
    return { unbound: [], subjective: false, planScripts: cfg?.plan.map((s) => s.script) ?? [] };
  }
  const bindings = cfg.planAuthority?.proofBindings ?? {};
  const inPlan = (script: string): boolean => cfg.plan.some((s) => s.script === script);
  const digestSet = new Set(task.requirementDigests);

  // Scripts already bound to one of THIS registration's requirements are not candidates for the
  // others: a digest must map to the check that measures THAT requirement.
  const usedByThisRegistration = new Set(
    Object.entries(bindings).filter(([d]) => digestSet.has(d)).map(([, s]) => s),
  );
  const candidateScripts = [...new Set(cfg.plan.map((s) => s.script))].filter((s) => !usedByThisRegistration.has(s));

  const unbound: UnboundRequirement[] = task.requirementDigests
    .filter((d) => !task.objectiveTargets.some((t) => t.digest === d))
    .filter((d) => {
      const script = bindings[d];
      return script === undefined || !inPlan(script);
    })
    .map((digest) => ({ digest, candidateScripts }));

  return {
    unbound,
    subjective: task.subjectiveVisual === true || task.subjectivePerformance === true,
    planScripts: cfg.plan.map((s) => s.script),
  };
}

/** Strict canonical declaration reader. Incomplete/legacy records return null;
 * candidate completion then has no usable task authority and fails closed.
 * Isolation freezes this exact representation for the shared monotonic guard. */
export function readTaskRecord(root: string): TaskIdentity | null {
  try {
    const p = path.join(root, CONFIG_DIR, TASK_FILE);
    if (containedRealPath(root, p) === null) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return v?.schema === 'canary-task/2' ? canonicalTask(v) : null;
  } catch { return null; }
}

// ---------- blocker 3: ACCEPTANCE FROM AN INTERACTIVE TERMINAL (the subjective completion path) ----------
/** Acceptance is the human-authority boundary, never a promotion shortcut:
 *  it can close ONLY non-objective duties, never an objective proof. The
 *  record binds to the exact candidate, the exact base HEAD it was verified
 *  against, the exact committed bytes reviewed, the frozen task state, AND
 *  the acceptance-eligible DUTY SET as it stood when the judgment was made
 *  (GLM F-3) — any of those moving makes it STALE (the duties reopen).
 *  Claim stated exactly (no more, no less): Canary refuses the normal
 *  NON-INTERACTIVE acceptance path and requires an interactive terminal for
 *  the supported acceptance flow. A TTY is not cryptographic human identity:
 *  a same-UID process able to drive a PTY (e.g. `script -qec`) or to write
 *  this file directly remains inside Canary's documented local forgery
 *  ceiling (M2). The gate takes the USUAL agent path away; it is policy /
 *  friction, not an OS security boundary.
 *  It lives OUTSIDE .canary/evidence by design: the evidence tree is inside
 *  M9's fingerprint window, and an acceptance written between windows must
 *  not look like authority-drift. */
export const ACCEPTANCE_SUBDIR = 'acceptance';
export interface AcceptanceRecord {
  schema: 'canary-acceptance/3'; at: string; candidate: string;
  subject: AuthorizationSubject;
  subjectDigest: string;
  acceptedBy: 'tty-human';
}
export function readAcceptance(root: string, name: string): AcceptanceRecord | null {
  try {
    const p = path.join(root, CONFIG_DIR, ACCEPTANCE_SUBDIR, `${name}.json`);
    if (containedRealPath(root, p) === null) return null; // linked dirs: never read through
    if (!fs.existsSync(p)) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<AcceptanceRecord> | null;
    if (typeof v !== 'object' || v === null) return null;
    if (v.schema !== 'canary-acceptance/3' || typeof v.at !== 'string' || v.candidate !== name || v.acceptedBy !== 'tty-human') return null;
    const sub = v.subject;
    if (!sub || sub.candidate !== name || !canonicalTask(sub.frozenTask) || !canonicalTask(sub.liveTask)
      || ![sub.candidateCommit, sub.candidateTree, sub.baseHead, sub.baseTree].every(x => typeof x === 'string' && /^[0-9a-f]{40,64}$/.test(x))
      || typeof sub.baseAuthorityIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(sub.baseAuthorityIdentity)
      || !Array.isArray(sub.subjectiveDuties) || !sub.subjectiveDuties.every(x => typeof x === 'string')
      || typeof v.subjectDigest !== 'string' || v.subjectDigest !== subjectDigest(sub)) return null;
    return v as AcceptanceRecord;
  } catch { return null; }
}
export function writeAcceptance(root: string, rec: AcceptanceRecord): boolean {
  try {
    const dir = path.join(root, CONFIG_DIR, ACCEPTANCE_SUBDIR);
    if (containedRealPath(root, dir) === null) return false;
    const p = path.join(dir, `${rec.candidate}.json`);
    if (containedRealPath(root, p) === null) return false;
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(p, JSON.stringify(rec, null, 2) + '\n');
    return true;
  } catch { return false; }
}

/**
 * M6 task-intake: the worker registers what it was ASKED for so Canary can
 * derive that kind's proof obligations. The registration itself carries ZERO
 * authority (AGENT_REPORTED, like `canary claim`): it can only ever ADD
 * obligations — the sealed plan stays the floor no declaration lifts.
 */
export function cmdTask(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no project here to attach a task to.', 'cd into your project and try again'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Canary's local config is unreadable — it will not attach a task to state it cannot read.", 'run: canary setup'); return 2; }
  if (!cfg) { o.verdict('NEEDS ATTENTION', 'Canary is not set up in this repo, so there is no verification record to attach a task to.', 'run: canary setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Canary will not record a task against a config it does not trust (${distrust}).`, "run: canary setup --yes (rewrites it as this machine's own)"); return 2; }
  let kindFlag: string | null = null;
  const prose: string[] = [];
  const requirements: string[] = [];
  /**
   * A STATED REQUIREMENT MUST NEVER BE SILENTLY DROPPED (v1.2, found by a probe rather than by a hunch).
   *
   * MEASURED, tooling/probes/v12-fixture-configurations.mjs: fixture `cli-exit-codes` states EIGHT
   * requirements and `canary task` recorded SEVEN digests. The missing one begins with `--`:
   *
   *   "--strict moves warnings into errors rather than dropping them"
   *
   * The old loop required the value to NOT start with `--` (`!rest[i+1].startsWith('--')`) and then
   * skipped any remaining `--` token outright, so a requirement whose TEXT begins with a dash-like
   * token was neither consumed nor reported: the operator saw "8 requirements" in their head and
   * "7 requirement(s)" on screen, and the eighth became prose nobody checks. That is the exact
   * failure this repository exists to prevent, and it is the same defect class as the MEASURED `work`
   * bug recorded in orchestrate.ts ("Canary silently registered FEWER, i.e. weaker verification than
   * the human authorized") — fixed there in v1.1, still present here.
   *
   * The rule now: `--requirement` takes the NEXT ARGUMENT VERBATIM as the requirement text. The only
   * values rejected are the ones that cannot be text at all — no value, or another option token,
   * which is a misuse Canary refuses instead of guessing. An unrecognised option is REFUSED rather
   * than ignored, because ignoring `--requirment "x"` (a typo) registers zero duties while the
   * operator believes otherwise, and a silent coverage hole is the one outcome this command may
   * never produce.
   */
  const optionToken = (s: string): boolean => s === '--requirement' || s === '--kind' || s.startsWith('--kind=');
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--kind') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) {
        o.say(`REFUSED — --kind needs one of: ${TASK_KINDS.join(', ')}${value === undefined ? ' (no value followed it)' : ` (it was followed by "${value.slice(0, 40)}", which is another option)`}. Nothing was registered.`);
        return 3;
      }
      kindFlag = rest[++i]!; continue;
    }
    if (a.startsWith('--kind=')) { kindFlag = a.slice(7); continue; }
    // GLM F-3: the requirement TEXT keeps its identity — hashed, prose never
    // stored (M3/M4). Counting alone let ["A","B"] and ["C","D"] share one
    // acceptance; an acceptance now binds to WHAT was listed.
    if (a === '--requirement') {
      const value = rest[i + 1];
      if (value === undefined) {
        o.say('REFUSED — --requirement needs the requirement TEXT as its value and nothing followed it. Nothing was registered, because registering fewer duties than were listed is the one outcome this command may never produce.');
        return 3;
      }
      if (optionToken(value)) {
        o.say(`REFUSED — --requirement was followed by the option "${value.slice(0, 40)}", so its value is missing or mis-ordered. Quote the requirement text (a requirement that itself begins with "--" is fine: put it after --requirement). Nothing was registered.`);
        return 3;
      }
      requirements.push(rest[++i]!); continue;
    }
    if (a.startsWith('--')) {
      o.say(`REFUSED — unknown option "${a.slice(0, 40)}". canary task takes --kind and --requirement only; an ignored option here would silently register FEWER duties than you listed. Nothing was registered.`);
      return 3;
    }
    prose.push(a);
  }
  const requirementCount = requirements.length;
  const text = prose.join(' ').trim();
  if (!text && kindFlag === null && requirementCount === 0) { o.say('usage: canary task "<intent>" [--kind bugfix|refactor|dependency|performance|ui|multi] [--requirement "<part>"]…'); return 3; }
  const inferred = inferTaskKinds([text, ...requirements].join(' '));
  let kinds: TaskKind[];
  if (kindFlag !== null) {
    if (!(TASK_KINDS as readonly string[]).includes(kindFlag)) { o.verdict('NEEDS ATTENTION', `unknown task kind "${kindFlag.slice(0, 40)}" — one of: ${TASK_KINDS.join(', ')}.`, 're-run with --kind <one of those>, or omit --kind and let Canary infer'); return 3; }
    // blocker 3 LAW: an agent-selected --kind may ADD useful classification;
    // it may NEVER REMOVE trusted/inferred material intent. The recorded
    // kinds are the UNION — "--kind bugfix" on "fix the crash and make the
    // dialog prettier" keeps the ui duty. --kind is not an authority override.
    kinds = [...new Set([kindFlag as TaskKind, ...inferred])];
  } else kinds = inferred;
  if (requirementCount > 0 && !kinds.includes('multi')) kinds.push('multi');
  let task: TaskIdentity;
  try { task = declaredTask(text, kinds, requirements); }
  catch (e) { o.say(`REFUSED — ${(e as Error).message}`); return 2; }

  try {
    if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) {
      o.verdict('NEEDS ATTENTION', '.canary resolves outside the repository (a link?) — Canary will not write through it.', 'replace it with a real folder, then re-run'); return 2;
    }
    const taskPath = path.join(root, CONFIG_DIR, TASK_FILE);
    if (containedRealPath(root, taskPath) === null) {
      o.verdict('NEEDS ATTENTION', `${rel(root, taskPath)} resolves outside the repository (a link?) — Canary will not write through it.`, 'replace it with a real folder inside .canary, then re-run'); return 2;
    }
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    writeFileAtomic(taskPath, JSON.stringify({
      schema: 'canary-task/2', at: new Date().toISOString(), ...task,
      trustClass: 'AGENT_REPORTED',
      authority: 'ZERO — registering a task can only ADD proof obligations; the sealed plan is the floor no declaration lifts',
    }, null, 2) + '\n');
  } catch (e) {
    o.verdict('NEEDS ATTENTION', `could not record the task (${String(e).slice(0, 140)}).`, 'fix the file/permission, then re-run'); return 2;
  }
  o.say(`task registered: ${kinds.length ? kinds.join(' + ') : 'no kind inferred'}${requirementCount ? ` (${requirementCount} requirement(s))` : ''}.`);
  for (const target of task.objectiveTargets) o.say(`objective ${target.kind} target: ${target.digest} — matching proof must be sealed via package.json canary.proofs`);
  /**
   * Print every requirement's digest so the operator can actually BIND it.
   *
   * MEASURED gap this closes: `canary.proofs` accepts any requirement digest, but nothing ever told
   * the operator what the digest was — so "bind this requirement to a sealed check" was advice with
   * no way to follow it, and the only reachable end state was human acceptance. Coverage has to be
   * attainable, or "every objective requirement has a frozen proof obligation" is not a promise.
   */
  for (const r of requirements) {
    const d = materialDigest(r);
    const covered = task.objectiveTargets.some((t) => t.digest === d);
    o.say(`requirement ${covered ? '[frozen target]' : '[needs proof or acceptance]'}: ${d} — "${canonicalText(r).slice(0, 90)}"`);
    if (!covered) o.say(`  bind it: package.json "canary": { "proofs": { "${d}": "<script name from your plan>" } }, then: canary setup`);
  }
  o.say('this is an AGENT_REPORTED hint with zero authority — the next checkpoint proves the sealed plan PLUS this task\'s obligations; nothing here weakens either.');
  if (text !== '' && inferred.length === 0) {
    // blocker 3: the intent was understood by NO pattern. The honest move is
    // to surface the ambiguity ONCE at registration — a --kind flag chosen by
    // the agent must not silently resolve it. Requirements are the human's
    // vocabulary: each becomes a duty, closable by proof or acceptance.
    o.say('NOTICE: no obligation could be derived from this intent. Ask the HUMAN what must be proven and re-register with one --requirement "<part>" per part — do NOT let --kind alone paper over the ambiguity. A candidate for this task freezes these kinds as its authority; un-derived intent stays visible here.');
  }
  return 0;
}

/**
 * Write what Canary just executed, as bytes — argv, cwd, runtime, candidate,
 * raw streams (capped files + full-byte digests), exit codes, derived
 * observation counts. BEST-EFFORT: evidence plumbing must never crash or
 * alter the harness hook, and nothing reads this back for a verdict (S4
 * doctrine extended to the whole evidence dir). Returns the bundle dir it
 * wrote, or null when nothing was written (containment refusal, any failure)
 * — so callers' `next:` lines can point at real evidence paths (review F7).
 */
/** Keys the bundle writer itself owns — `extra` may add, never overwrite. */
const BUNDLE_RESERVED = new Set(['schema', 'at', 'source', 'status', 'trustClass', 'note',
  'canaryEntry', 'runtime', 'cwd', 'candidate', 'envOverrides', 'execPolicy', 'steps', 'provenance']);

export function writeVerificationBundle(root: string, source: string, results: StepResult[], status: string, prov?: BundleProvenance, o?: {
  /** where evidence DIRS live (M7: a candidate's bundles land under the BASE's
   *  .canary/evidence — the candidate never holds Canary's authoritative bytes) */
  evidenceRoot?: string;
  /** which tree cwd/candidate identity describe (defaults to the steps' root) */
  subjectRoot?: string;
  /** additive, plainly-labeled observation fields (never read back for verdicts) */
  extra?: Record<string, unknown>;
}): string | null {
  try {
    const evidenceRoot = o?.evidenceRoot ?? root;
    const subjectRoot = o?.subjectRoot ?? root;
    if (containedRealPath(evidenceRoot, path.join(evidenceRoot, CONFIG_DIR)) === null) return null; // linked .canary: no writes through it (S3)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(evidenceRoot, CONFIG_DIR, EVIDENCE_DIR, `${stamp}-${source}`);
    if (containedRealPath(evidenceRoot, dir) === null) return null;
    fs.mkdirSync(dir, { recursive: true });
    const steps = results.map((r, i) => {
      const files: Record<'out' | 'err', string> = { out: '', err: '' };
      const raws: Record<'out' | 'err', string> = { out: r.stdout, err: r.stderr };
      (['out', 'err'] as const).forEach((stream) => {
        // kind arrives from DISK config (validConfigShape only checks isStr), so it
        // must not shape a path component — path.join collapses `../` right out of
        // the bundle dir. detectPlan kinds (typecheck/tests/build) pass unchanged.
        const safeKind = /^[a-z][a-z0-9-]{0,31}$/.test(r.kind) ? r.kind : 'step';
        const name = `${i + 1}-${safeKind}.${stream}.log`; // name is derived, never supplied
        const text = raws[stream];
        const capped = text.length > RAW_CAP
          ? `${text.slice(0, RAW_CAP / 2)}\n…TRUNCATED (${text.length} bytes total; full-byte sha256 below)…\n${text.slice(-RAW_CAP / 2)}`
          : text;
        try { writeFileAtomic(path.join(dir, name), capped); files[stream] = name; } catch { /* best-effort per stream */ }
      });
      return {
        kind: r.kind, argv: r.argv, cwd: r.cwd, ok: r.ok, exitCode: r.exitCode,
        // blocker 1: argv above is the whitelisted DISPLAY form; execArgv+exec
        // bind what actually ran — resolved path, compact digest, env policy.
        execArgv: r.execArgv, exec: r.exec,
        startedAt: r.startedAt, endedAt: r.endedAt,
        stdout: { sha256: sha256(r.stdout), bytes: Buffer.byteLength(r.stdout, 'utf8'), file: files.out || null },
        stderr: { sha256: sha256(r.stderr), bytes: Buffer.byteLength(r.stderr, 'utf8'), file: files.err || null },
        observedCounts: deriveObservedCounts(`${r.stdout}${r.stderr}`),
      };
    });
    const bundle = {
      schema: 'canary-verification/1', at: new Date().toISOString(), source, status,
      // M3: every bundle exists because Canary ran the plan — CANARY_OBSERVED
      // is not a claim this file makes, it is a fact about who wrote these bytes.
      trustClass: 'CANARY_OBSERVED',
      note: 'Written from Canary\'s OWN execution. Agent reports and printed summaries are claims, not evidence; this bundle is never read back to produce a verdict.',
      canaryEntry: CLI_ENTRY,
      runtime: { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch },
      cwd: subjectRoot, candidate: candidateIdentity(subjectRoot), envOverrides: relevantEnvNames(),
      execPolicy: ENV_POLICY, steps,
      // M4 provenance: WHICH plan/code/task this evidence belongs to, stamped
      // from trusted in-memory state at write time — never re-derived from
      // bytes read back off the evidence dir. null only if a caller has no
      // plan context to offer. Observation, not verdict input.
      provenance: prov ? { planDigest: prov.planDigest, baseline: prov.baseline, taskDigest: prov.taskDigest ?? null } : null,
      // extras add fields (plainly-labeled observations); they may never
      // shadow the bundle's own reserved keys — a caller cannot launder a
      // trustClass or status in through the side door.
      ...Object.fromEntries(Object.entries(o?.extra ?? {}).filter(([k]) => !BUNDLE_RESERVED.has(k))),
    };
    const jsonPath = path.join(dir, 'verification.json');
    writeFileAtomic(jsonPath, JSON.stringify(bundle, null, 2) + '\n');
    // M4 bundle self-hash — TAMPER-EVIDENCE only. There is no signing key in
    // this product: whoever can rewrite verification.json can rewrite this
    // file too, so it proves nothing about authenticity. It honestly binds
    // the bundle against corruption and accidental edits, and says so.
    writeFileAtomic(path.join(dir, 'verification.sha256'),
      JSON.stringify({ file: 'verification.json', sha256: sha256(fs.readFileSync(jsonPath, 'utf8')), label: 'tamper-evidence only — NOT a signature; no key exists' }, null, 2) + '\n');
    // bounded retention: newest EVIDENCE_KEEP bundles; only Canary's own
    // <stamp>-<source> dirs are eligible; anything else in evidence/ is left alone
    const parent = path.join(evidenceRoot, CONFIG_DIR, EVIDENCE_DIR);
    const mine = fs.readdirSync(parent)
      .filter((d) => /^\d{4}-\d{2}-\d{2}T[\d-]{11,}(Z)?-(setup|doctor|checkpoint|candidate|promotion)$/.test(d))
      .sort();
    for (const d of mine.slice(0, Math.max(0, mine.length - EVIDENCE_KEEP))) {
      try { fs.rmSync(path.join(parent, d), { recursive: true, force: true }); } catch { /* churn-tolerant */ }
    }
    return dir;
  } catch { /* evidence is best-effort; never crash the harness hook over it */ return null; }
}

/** The agent's latest UNTRUSTED hint — read ONLY to annotate a block Canary
 *  already decided from its own execution. Shape-checked, capped, silent null
 *  on anything odd; it can never carry authority. */
function readAgentClaim(root: string): { at: string; text: string } | null {
  try {
    const p = path.join(root, CONFIG_DIR, CLAIMS_FILE);
    if (containedRealPath(root, p) === null) return null;
    if (!fs.existsSync(p)) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    const o = v as { at?: unknown; text?: unknown };
    if (typeof o?.text !== 'string' || typeof o?.at !== 'string') return null;
    // `at` is interpolated into a block-reason annotation, so it must FULLY match
    // an ISO timestamp (end anchor included — a prefix-only gate lets up to ~21
    // bytes of agent prose ride the tail of a hand-planted file into the note).
    // cmdClaim always writes new Date().toISOString(), which passes.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(o.at)) return null;
    return { at: o.at.slice(0, 40), text: o.text.slice(0, 4000) };
  } catch { return null; }
}

function rel(root: string, p: string): string { return path.relative(root, p) || '.'; }

// ---------- friendly output ----------

export class Out {
  private json: boolean;
  private ctx: Partial<ProtocolEnvelope> = {};
  constructor(private verbose: boolean, json = false) { this.json = json; }
  /** In JSON mode the human prose goes to STDERR: stdout carries exactly one
   *  JSON object, so an agent's parser never skips past sentences. Exit codes
   *  and verdicts are identical in both modes — --json changes where the words
   *  go, never what Canary decided. */
  private line(s: string): void { if (this.json) console.error(s); else console.log(s); }
  say(s = '') { this.line(s); }
  detail(s: string) { if (this.verbose) this.line(`   ${s}`); }
  step(r: StepResult) {
    this.line(`${r.ok ? '✓' : '✗'} ${r.kind}: ${r.display}${r.exitCode === null ? ' (could not run)' : ` (exit ${r.exitCode})`}`);
    if (!r.ok && r.tail) this.line(r.tail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
  /** Facts the envelope must carry. Attach them BEFORE the verdict. */
  context(partial: Partial<ProtocolEnvelope>): void { this.ctx = { ...this.ctx, ...partial }; }
  // CONNECTED / NOT CONNECTED are the canary status (read-only) family: state
  // facts, deliberately NOT READY (only a completed plan run earns READY).
  verdict(v: 'READY' | 'NOT PROVEN' | 'CONNECTED' | 'NOT CONNECTED' | 'NEEDS ATTENTION' | 'UNSUPPORTED', why: string, next?: string) {
    this.line('');
    this.line(v === 'READY' ? `READY — ${why}` : `${v} — ${why}`);
    if (next) this.line(`next: ${next}`);
    if (!this.json) return;
    // READY and CONNECTED are the only non-blocking verdicts; every other one
    // is a refusal, which is exit 2 across Canary's command surface.
    const exitCode = this.ctx.exitCode ?? ((v === 'READY' || v === 'CONNECTED') ? 0 : 2);
    const env: ProtocolEnvelope = {
      schema: this.ctx.schema ?? PROTOCOL_STATUS, ...this.ctx,
      command: this.ctx.command ?? 'canary', status: v, exitCode,
    };
    if (next !== undefined) env.next = next;
    emitEnvelope(env);
  }
}

export interface GlobalOpts { verbose: boolean; yes: boolean; json: boolean; fast: boolean }
export function parseGlobals(args: string[]): { opts: GlobalOpts; rest: string[] } {
  const opts: GlobalOpts = {
    verbose: args.includes('--verbose') || !!process.env.CANARY_VERBOSE,
    yes: args.includes('--yes'),
    json: args.includes('--json'),
    fast: args.includes('--fast'),
  };
  return { opts, rest: args.filter((a) => a !== '--verbose' && a !== '--yes' && a !== '--json' && a !== '--fast') };
}
/** The directory argument = first non-flag token, anywhere in the args. Never mistake --run for a path. */
export function dirArg(rest: string[]): string | undefined { return rest.find((a) => !a.startsWith('--')); }

// ---------- commands ----------

export async function cmdSetup(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'this folder is not inside a git repository.', 'cd into your project and try again'); return 2; }
  // 1.1 §12–17: the project is whatever the registered adapters declare, not
  // "a repo with a package.json". A present package.json is still validated
  // exactly as before (1.0 message, 1.0 fail-closed), but its ABSENCE is no
  // longer UNSUPPORTED by itself — the composite discovery below decides, and a
  // repo that declares nothing is UNSUPPORTED there, never guessed at here.
  const pkgFile = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgFile) ? parseJsonOrNull(pkgFile) : null;
  if (fs.existsSync(pkgFile) && !pkg) {
    o.verdict('UNSUPPORTED', 'package.json is not valid JSON — Canary cannot read your project.', 'fix package.json, then run setup again'); return 2;
  }

  // local-state integrity BEFORE any write: a tracked .canary config arrived
  // from someone else's clone (S1/S2), and a linked .canary/.claude would send
  // Canary's writes outside the repo (S3) — refuse both without touching bytes.
  if (fs.existsSync(configPath(root)) && configTracked(root) === true) {
    o.verdict('NEEDS ATTENTION', "Canary's local config (.canary/canary.local.json) is tracked in git — committed Canary state comes from a clone and cannot be trusted as this machine's own.", 'run: git rm -r --cached .canary, then run setup again'); return 2;
  }
  // one rule for every path Canary owns: never write through a link (live,
  // dangling, or inside-pointing) — lstat sees what existsSync cannot.
  for (const d of [path.join(root, CONFIG_DIR), path.join(root, '.claude')]) {
    let isLink = false;
    try { isLink = fs.lstatSync(d).isSymbolicLink(); } catch { /* absent: fine */ }
    if (isLink || (fs.existsSync(d) && containedRealPath(root, d) === null)) {
      o.verdict('NEEDS ATTENTION', `${rel(root, d)} is a link — Canary will not write through links (a committed link can send Canary's files outside the repo).`, 'replace it with a real folder inside the repo, then run setup again'); return 2;
    }
  }
  for (const f of [configPath(root), path.join(root, CONFIG_DIR, '.gitignore'), path.join(root, CONFIG_DIR, CHECKPOINT_FILE), settingsPath(root)]) {
    try {
      if (fs.lstatSync(f).isSymbolicLink()) {
        o.verdict('NEEDS ATTENTION', `${rel(root, f)} is a link — Canary will not write through links.`, 'replace it with a real file inside the repo, then run setup again'); return 2;
      }
    } catch { /* absent: fine */ }
  }

  // 1.1 §12–17 — discovery and sealing run through the project adapters: EVERY
  // ecosystem that declares checks at the repo root contributes to ONE plan.
  // A Node-only repo produces byte-identical plan/pm/seal to before (the Node
  // adapter is unchanged and its steps keep their exact 1.0 shape); the empty
  // plan stays a complete answer that becomes NEEDS ATTENTION, never READY.
  const composed = composePlan(root);
  // §B: a scope declaration Canary cannot honour stops setup. It is never
  // partially applied, and never quietly reduced to the scopes that happened to
  // be fine — the human asked for these checks, so shipping a plan without them
  // silently would be exactly the failure this feature exists to prevent.
  if (composed.problems.length) {
    o.verdict('NEEDS ATTENTION', `the nested-scope declaration (${SCOPES_FILE}) is not usable: ${composed.problems.join('; ')}.`, `fix ${SCOPES_FILE} (or delete it to go back to root-only discovery), then run setup again`);
    return 2;
  }
  if (composed.scopes.length === 0) {
    o.verdict('UNSUPPORTED', `${root} is a git repo, but Canary found no project it can model at its root (looked for package.json, pyproject.toml / setup.py / tox.ini, Cargo.toml, go.mod / go.work).`, `if your checks live in subdirectories, declare them in ${SCOPES_FILE} (e.g. { "schema": "${SCOPES_SCHEMA}", "scopes": [{ "path": "web", "ecosystem": "node" }] }), then run setup again`);
    return 2;
  }
  const rootScope = composed.scopes.find((s) => s.scope === '');
  const rootDisc = rootScope ? planForScope(root, rootScope) : null;
  // pinning happens HERE, at the human-authorized moment, and what gets sealed
  // is the absolute path — never a name that a later PATH could re-point
  const pin = pinPlanPrograms(composed.plan);
  if (pin.problems.length) {
    o.verdict('NEEDS ATTENTION', `Canary could not pin a program these checks need: ${pin.problems.join('; ')}.`, 'install it (or declare its absolute path in the project), then run setup again'); return 2;
  }
  const plan = pin.plan;
  const pm = rootDisc?.pm ?? composed.scopes[0]!.adapter.id;
  const note = rootDisc?.note ?? composed.notes.join('; ');
  let seal: PlanAuthority;
  try {
    // ONE seal over the whole composite plan. Each step is digested by what its
    // own ecosystem declared: an argv step by its exact command, a Node script
    // step by the package.json script text (unchanged M5 semantics). The
    // project's fast-path declaration is sealed HERE too, so a check may only be
    // left out on authority the project gave at setup.
    const canaryBlock = rootDisc?.source.canary as { proofs?: unknown; paths?: unknown } | undefined;
    seal = sealPlanAuthority(plan, (rootDisc?.source.scripts ?? {}) as Record<string, unknown>,
      canaryBlock?.proofs, canaryBlock?.paths);
  } catch (e) { o.say(`REFUSED — ${(e as Error).message}`); return 2; }

  o.say(`repo: ${root}`);
  o.say(`package manager: ${pm} (${note})`);
  if (!plan.length) {
    // The message names REAL accepted declarations per ecosystem; the old text
    // claimed only test/typecheck/build, which the Node detector never actually
    // honored (it also accepts bench and e2e).
    o.verdict('NEEDS ATTENTION', 'this project declares no check Canary recognizes (Node: test / typecheck / type-check / build / bench / e2e scripts; Python: pytest, tox, unittest, or mypy / pyright / ruff; Rust: a Cargo.toml; Go: a go.mod or go.work).', 'declare a check for your stack, then run setup again'); return 2;
  }
  o.say('verification plan (from what this project already declares — Canary runs only your own checks; change them in their own files):');
  for (const s of plan) o.say(`  ✓ ${s.kind}: ${stepDisplay(pm, s)}`);
  for (const e of composed.empty) o.say(`  · declared no checks — ${e}`);

  const { found, integrable } = detectHarnesses(root);
  for (const h of found) o.say(`harness: ${h.label} — ${h.action}`);
  if (!integrable) {
    o.verdict('NEEDS ATTENTION', 'no supported AI harness detected (Claude Code is supported today; others get an explicit message, not a fake integration).', 'install Claude Code (or open the project inside it), then run setup again'); return 2;
  }

  const hookCommand = buildHookCommand(CLI_ENTRY);
  if (!hookCommand) {
    o.verdict('NEEDS ATTENTION', 'the Canary installation path contains characters that cannot be safely embedded in a hook command.', 'reinstall Canary to a plain path (no double quotes) and run setup again'); return 2;
  }

  // read prior config (self-heal: reuse recorded hook commands for dedupe)
  const prev = readConfig(root);
  if (prev === 'corrupt') o.detail('previous .canary config was unreadable — it will be rewritten');
  // only THIS installation's own record may seed hook-command dedupe — a cloned
  // config must never teach setup which user entries to strip (S1)
  const prevUsable = !!prev && prev !== 'corrupt' && !untrustedConfigReason(root, prev);
  const priorCommands = new Set<string>(prevUsable ? [...(prev as CanaryConfig).hookCommands, (prev as CanaryConfig).hookCommand] : []);
  const backupsDir = path.join(root, CONFIG_DIR, 'backups');
  try { ensureCanarySelfIgnore(root); } catch { /* writeConfig below reports a real failure; the stamp just measures what it can */ }

  const res = installStopHook(root, hookCommand, priorCommands, backupsDir);
  if (!res.ok) { o.verdict('NEEDS ATTENTION', `could not configure Claude Code safely: ${res.problem}`, 'fix that file, then run setup again'); return 2; }
  // v1.3 §C: the same agent should be able to ASK Canary instead of guessing. This is what turns
  // "the gate speaks at the end" into "the agent can check while it works", with the same write
  // discipline as the hook above and no new authority (mcp.ts exposes only request tools).
  const priorMcp = new Set<string>(prevUsable ? ((prev as CanaryConfig).mcpArgSignatures ?? []) : []);
  const mcp = installMcpServer(root, CLI_ENTRY, priorMcp, backupsDir);
  if (!mcp.ok) { o.verdict('NEEDS ATTENTION', `could not register Canary's tools for your agent safely: ${mcp.problem}`, 'fix that file, then run setup again'); return 2; }
  // M4 baseline: stamped NOW by Canary's own probes. Honest label — "state when
  // Canary was wired", not a claim about the agent's past. `dirty` measures
  // WORKER residue, so the one file Canary itself just wrote (its managed
  // settings entry) is excluded from THIS stamp: setup's own wiring must not
  // permanently blind the repo to blame for later uncommitted deletions — M6
  // attribution relies on a clean baseline actually being reachable. candidate-
  // Identity itself stays untouched (M4-pinned semantics for bundles).
  const baselineId = candidateIdentity(root);
  const ownSettings = rel(root, settingsPath(root)).split(path.sep).join('/');
  const ownMcp = rel(root, mcpConfigPath(root)).split(path.sep).join('/');
  const baselineStatus = gitWithinRoot(root, ['status', '--porcelain', '--', '.', `:(exclude)${ownSettings}`, `:(exclude)${ownMcp}`]);
  // M5: whatever plan and script texts are on disk RIGHT NOW are what the
  // setup run is now sealing — they become the sealed authority.

  // A re-setup under byte-identical authority keeps the ORIGINAL stamps:
  // installedAt and planAuthority.at record WHEN THESE BYTES WERE LAST
  // GENUINELY RE-SEALED by a setup run,
  // not when the command was last typed — so re-running setup on a connected
  // repo is CORE-state idempotent (no spurious config churn for re-entry).
  // Any real change (plan shape, script text, HEAD) re-stamps honestly, which
  // is what a genuine re-seal means. prevUsable already proved this config is
  // this installation's own trust, so reusing its fields is self-reference,
  // never a clone's word.
  const prevCfg = prevUsable && prev ? prev as CanaryConfig : null;
  const prevAuth = prevCfg?.planAuthority;
  const reuse = prevCfg && prevAuth && prevCfg.pm === pm
    && prevAuth.planDigest === seal.planDigest
    && JSON.stringify(prevAuth.scriptDigests) === JSON.stringify(seal.scriptDigests)
    && JSON.stringify(prevAuth.proofBindings ?? {}) === JSON.stringify(seal.proofBindings ?? {})
    && prevCfg.baseline?.head === baselineId.head ? prevCfg : null;
  const cfg: CanaryConfig = {
    version: 'product-0.1', installedAt: reuse?.installedAt ?? new Date().toISOString(), pm, plan,
    baseline: {
      at: reuse?.baseline?.at ?? new Date().toISOString(), ...baselineId,
      dirty: baselineStatus === null ? baselineId.dirty : baselineStatus.trim().length > 0,
    },
    planAuthority: reuse?.planAuthority ?? seal,
    cliPath: CLI_ENTRY, hookCommand,
    hookCommands: [...new Set([hookCommand, ...priorCommands])],
    mcpArgSignatures: [...new Set([mcpArgSignature(mcpServerArgs(CLI_ENTRY)), ...priorMcp])],
    touched: [res.touched!, mcp.touched!],
  };
  // 1.1 P0 — the authority gets a SEALED COPY outside the repo before any repo
  // write of this run lands: a store that cannot mint means no config, so the
  // project is never left with in-repo-only authority that silently looks
  // sealed. Every setup re-seals (the store's seq ledger advances); the in-repo
  // bytes stay byte-identical to v1.0 — the store is a mirror that DETECTS
  // divergence, and probeTrustLevel says its level honestly below.
  const store = storeFromEnv();
  const projectId = projectIdForRoot(root);
  try {
    sealRecord(store, { projectId, kind: 'registration', canaryVersion: CANARY_VERSION, payload: { root: fs.realpathSync(root), pm, adapter: composed.scopes.map((s) => s.adapter.id).join('+') } });
    sealRecord(store, { projectId, kind: 'plan-seal', canaryVersion: CANARY_VERSION, payload: cfg.planAuthority });
  } catch (e) {
    o.verdict('NEEDS ATTENTION', `authority could not be sealed in the trust store (${String((e as Error).message ?? e).slice(0, 140)}) — Canary will not finish wiring a project whose sealed copy it cannot mint. The .canary config was not written.`, `fix the store at ${store.root} (writable by this user, or point CANARY_TRUST_STORE at an empty directory), then run setup again`);
    return 2;
  }
  try {
    writeConfig(root, cfg);
  } catch (e) {
    // the hook entry is installed but WITHOUT config the checkpoint stays
    // silent — this project would be wired yet unprotected. Say it plainly.
    o.verdict('NEEDS ATTENTION', `could not write the .canary config (${String(e).slice(0, 140)}) — the hook entry is installed, but Canary cannot verify anything here without its config. Nothing was half-written.`, 'close whatever holds the file, then run setup again');
    return 2;
  }
  // M9 §9.5 — a deliberate setup re-run IS the clearing act. A caught
  // in-window tampering quarantines the base (verify/promote refuse until
  // re-seal); a fresh writeConfig + re-installed hook means these bytes were
  // deliberately re-sealed, so the marker's debt is paid. Cleared only on success: if the
  // config write threw above, quarantine stands (fail-closed).
  try { fs.rmSync(path.join(root, CONFIG_DIR, QUARANTINE_FILE), { force: true }); } catch { /* absent is the common case */ }
  o.say(`Claude Code will run Canary automatically when the agent finishes a turn here.${prev && prev !== 'corrupt' ? ' (re-run: existing Canary hook refreshed, no duplicates)' : ''}`);
  // v1.3 §C: say plainly that a SECOND file was written, and what the agent gets from it. Silence
  // about a file Canary just added to someone's repository would be the wrong kind of invisible.
  o.say(`agent tools: registered in ${rel(root, mcpConfigPath(root))} — your agent can now ask Canary whether it is done, instead of guessing. Your other MCP servers are untouched; \`canary uninstall\` removes exactly this entry.`);
  // v1.3 §E, MEASURED with the real agent CLI (`claude mcp list` reports our entry as
  // "Pending approval"): the harness holds a project-scoped MCP server until a human approves it once.
  // That is one interactive step Canary cannot take for you, so it is named here rather than left to
  // look like a broken integration.
  o.say(`  Claude Code asks you to approve a project's MCP server once — run \`claude\` there and approve it; until then the server is listed but its tools are not available.`);
  o.detail('authority sealed: the plan and the exact text of every script it runs — candidate edits to the verification surface block completion until setup is deliberately re-run.');
  const level = probeTrustLevel(store);
  o.detail(`sealed authority copy: ${store.root} (project ${projectId}) — level ${level.level}: ${level.reasons.join(' ')}`);

  // smoke = run the plan for real (this is the proof the wiring works)
  const interactive = process.stdin.isTTY === true;
  if (!opts.yes && interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nRun these ${plan.length} project command(s) now as a smoke test? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (answer && answer !== 'y' && answer !== 'yes') {
      o.verdict('NEEDS ATTENTION', 'Canary is installed here but was never executed — protection is wired, NOT yet verified.', 'run: canary setup --yes (or: canary doctor — it runs the checks)'); return 2;
    }
  }
  if (!opts.yes && !interactive) {
    // This branch used to write all of setup's state, then exit 2 demanding a
    // memorized "--yes" — installed-yet-unproven, every agent re-typed the flag.
    // It guards no real authority: whoever can invoke `canary setup` can invoke
    // `canary doctor`, which runs the SAME plan unasked and unconditionally
    // (READY is earned there, not from a handshake). Running the project's own
    // sealed checks now proves the wiring instead of demanding consent that the
    // command invocation already gave. A TTY is still asked first, above.
    o.detail('unattended (no TTY, no --yes): running the smoke test directly — wiring without execution would prove nothing.');
  }
  o.say('\nsmoke test (running your own project scripts):');
  let allOk = true;
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  for (const s of plan) {
    // A pm that cannot be resolved in the TRUSTED environment is an
    // environment truth, not a project failure — report it as a step that
    // could not run (exitCode null) instead of crashing the whole setup.
    let r: StepResult;
    try { r = runPlanStep(root, pm, s); } catch (e) { r = unresolvedStep(root, pm, s, e); }
    ran.push(r);
    o.step(r);
    if (!r.ok) { allOk = false; failed.push(r); }
  }
  writeVerificationBundle(root, 'setup', ran, allOk ? 'pass' : 'fail', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
  writeCheckpoint(root, allOk ? 'pass' : 'fail', failed.map((f) => f.kind), 'setup');
  if (allOk) {
    /**
     * A GREEN PLAN IS NOT A PROVEN TASK — DO NOT SAY READY WHILE A REGISTERED REQUIREMENT IS UNBOUND.
     *
     * MEASURED friction this closes (v1.2 recon): `setup` never evaluated obligations, so it could
     * print READY on a repository where `doctor` — seconds later, same bytes — printed NOT PROVEN.
     * An operator reading READY reasonably concludes the task is covered, and the contradiction is
     * then discovered at the END of a worker's session, which is where the measured 1.5-1.85M-token
     * loops came from.
     *
     * The honest ending depends on what is registered: with no outstanding duty the wiring really is
     * fresh and READY is right; with requirements that no sealed check measures, saying so HERE costs
     * one sentence and saves the whole loop. Exit stays 0 — this IS a successful setup, and the
     * requirement state is reported rather than turned into a failure.
     */
    const unbound = unboundRequirements(root, cfg);
    if (unbound.unbound.length > 0 && !unbound.subjective) {
      o.say(`note: ${unbound.unbound.length} registered requirement(s) have NO sealed proof, so the checks above cannot measure them.`);
      for (const req of unbound.unbound) o.say(`  unbound: ${req.digest}`);
      o.say(`  sealed plan script(s) available to bind: ${unbound.planScripts.length > 0 ? unbound.planScripts.join(', ') : '(none)'}`);
      o.say('  the wiring here is ready, but the TASK is not: bind each digest (package.json "canary" proofs) and re-run setup. Until then `canary doctor` will say NOT PROVEN — that is the same fact, not a second problem.');
    }
    o.verdict('READY', 'Canary is active here: it will run these checks whenever the AI agent says it is done, and will interrupt the human only when something needs them.', `try it: break a test on purpose and let the agent finish — Canary will say so. doctor: canary doctor`);
    return 0;
  }
  o.verdict('NEEDS ATTENTION', `Canary is wired here, but your project's own checks did not pass${failed.length ? ` (${failed.map((f) => f.kind).join(', ')})` : ''}. ${failed.some((f) => f.exitCode === null) ? 'Some commands could not run at all.' : 'That is your project talking, not Canary.'}`, 'fix the failing checks (ask the agent), then: canary doctor');
  return 2;
}

function writeCheckpoint(root: string, status: string, failed: string[], source: string): void {
  try {
    // never write evidence through a committed link pointing outside the repo (S3)
    const p = path.join(root, CONFIG_DIR, CHECKPOINT_FILE);
    if (containedRealPath(root, fs.existsSync(p) ? p : path.join(root, CONFIG_DIR)) === null) return;
    fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
    // assertPlainTarget lives inside writeFileAtomic — a dangling link that passed
    // the ancestor walk is refused there rather than CREATED outside via the write.
    writeFileAtomic(p, JSON.stringify({ at: new Date().toISOString(), status, failed, source }, null, 2) + '\n');
  } catch { /* evidence is best-effort; never crash the harness hook over it */ }
}

// The config-trust checks doctor performs BEFORE it spends anything on a plan
// run. Extracted verbatim (single owner) so `canary status` can answer "is
// this repo's wiring sound?" with zero PROJECT commands executed and zero
// writes (a couple of read-only git metadata probes are still made — that is
// the honest measured shape; see the usage text).
// livePmProbe=false (status) SKIPS the pm liveness check entirely: it is a
// statement about state, and liveness is only worth a spawn to whoever is
// about to EXECUTE (doctor). The probe that doctor does make is the SAME
// hardened resolution+environment the plan itself will run under — never a
// PATH lookup the old inherited-env `--version` allowed to be a liar shim.
function readOnlyProblems(root: string, cfg: CanaryConfig, livePmProbe: boolean): string[] {
  const problems: string[] = [];
  if (!Array.isArray(cfg.plan) || cfg.plan.length === 0) problems.push('the verification plan is empty — Canary would have nothing to check (a pass here would be fake)');
  // 1.1 §12–17 — each step is answered for by its OWN adapter in its OWN scope,
  // so a Python step is never judged against package.json. For a 1.0 config
  // every step resolves to the Node adapter and this yields the same list.
  const envSeen = new Set<string>();
  for (const step of cfg.plan) {
    const stepAdapter = adapterForStep(cfg, step);
    const runner = step.argv !== undefined ? stepAdapter.id : (step.pm ?? cfg.pm);
    const key = `${stepAdapter.id}:${runner}`;
    if (envSeen.has(key)) continue;
    envSeen.add(key);
    const envProblem = stepAdapter.validateEnvironment(runner);
    if (envProblem) problems.push(envProblem);
  }
  if (livePmProbe) {
    // A script step is proved live exactly as the plan will run it (resolved
    // package manager, one hardened spawn). An explicit step is proved live by
    // its sealed ABSOLUTE program existing. Neither is a PATH lookup.
    const legacyRunners = new Set(cfg.plan.filter((s) => s.argv === undefined).map((s) => s.pm ?? cfg.pm));
    for (const runner of legacyRunners) {
      const resolved = resolvePm(runner);
      const probe = resolved ? spawnHardened(resolved, ['--version'], root, 30_000) : null;
      if (probe === null || probe.status !== 0) {
        problems.push(`package manager "${runner}" is not runnable in Canary's trusted environment (running Node's install dir, corepack, or OS-managed dirs only — the calling PATH is deliberately ignored)`);
      }
    }
    for (const step of cfg.plan) {
      if (step.argv === undefined) continue;
      const program = step.argv[0] as string;
      if (!path.isAbsolute(program)) {
        problems.push(`the sealed check "${step.script}" names "${program}" instead of an absolute path — re-run setup so the toolchain is pinned (Canary never resolves a verification program through PATH)`);
      } else if (!fs.existsSync(program)) {
        problems.push(`the sealed program for "${step.script}" is missing here: ${program} — install it, or re-run setup`);
      }
    }
  }
  // 1.1 §1 — the plan-existence and authority-drift questions are adapter
  // questions (same strings, live-disk reads; a swapped manifest between the
  // two reads can only ever ADD problems, never certify).
  problems.push(...planProblemsForConfig(root, cfg, cfg.plan));
  // M5: a sealed authority that drifted is a problem REGARDLESS of whether the
  // current commands pass — doctor must not certify READY on proof it never sealed.
  const drift = planAuthorityDrift(root, cfg);
  if (drift) problems.push(`verification authority changed since setup — ${drift}; restore the sealed checks, or re-run setup to re-seal deliberately`);
  if (!fs.existsSync(cfg.cliPath)) problems.push('the Canary command files moved or were removed — reinstall, then re-run setup');
  for (const t of cfg.touched) {
    if (!fs.existsSync(t.path)) { problems.push(`${rel(root, t.path)} is missing — the harness hook is NOT registered, so nothing runs automatically`); continue; }
    const doc = parseJsonOrNull(t.path);
    if (!doc) { problems.push(`${rel(root, t.path)} is not valid JSON — fix it`); continue; }
    // v1.3 §C: an MCP entry is ours by argv signature, not by a command string; a file that is fine
    // for the hook check is not evidence about the server entry, so each kind asks its own question.
    const present = t.kind === 'mcp'
      ? hasMcpEntry(doc, new Set(cfg.mcpArgSignatures ?? []))
      : hasCanaryEntry(doc, new Set(cfg.hookCommands));
    if (!present) {
      problems.push(t.kind === 'mcp'
        ? `Canary's agent tools are no longer registered in ${rel(root, t.path)} — the agent cannot ask Canary whether it is done; re-run: canary setup`
        : `Canary's hook is no longer registered in ${rel(root, t.path)} — nothing will run automatically; re-run: canary setup`);
    }
  }
  return problems;
}

/**
 * 1.1 P0 — the sealed-copy report, for `status` and `doctor` (verbose detail
 * lines). READ-ONLY and REPORT-ONLY by design: no verdict in this build
 * consumes it, so v1.0 outcomes are unchanged (gate K) — but a human who asks
 * "is what the repo claims also what the store sealed?" gets the measured
 * truth, including "there is no sealed copy yet" for legacy projects.
 */
/**
 * 1.1 §5/§21 — the measured custody level and the real harness capability, as
 * data. Both are REPORTED, never inferred: `probeTrustLevel` measures whether
 * this process can write the store (a same-uid writer means LOCAL, and
 * HARDENED is unreachable without a broker of a different identity), and a
 * harness that cannot gate is reported as not gating rather than as protection.
 */
export function securityCapability(): { level: 'HARDENED' | 'LOCAL' | 'ADVISORY' | 'UNSUPPORTED'; reasons: string[] } {
  try {
    // READ-ONLY: this feeds `status`, `result` and `agents`, all of which promise
    // to write nothing. The write-measuring probe belongs to setup/doctor, where
    // writing is already part of the job.
    const store = storeFromEnv();
    // v1.1 Phase 3 / v1.2 Mission 3: when a provider is CONFIGURED, the level is
    // the MEASURED one — HARDENED becomes reachable exactly when every boundary
    // control is derived from a fresh, signed, complete confined-caller
    // deployment measurement, and never because a provider is merely present.
    // With no provider installed this branch is skipped entirely, so the ordinary
    // answer stays byte-identical and costs no extra process spawns.
    if (providerConfigured(store)) {
      const status = providerStatus(store);
      const measured = measuredCapabilities(status.boundary);
      if (measured.level === 'HARDENED') {
        return {
          level: 'HARDENED',
          reasons: [
            `a confined-caller deployment was measured on ${status.boundary.platform} and every boundary control is present: `
            + `package ${status.confinement?.kind === 'win32-appcontainer-restricted-low' ? status.confinement.package : 'n/a'}, measured ${status.confinement?.kind === 'win32-appcontainer-restricted-low' ? status.confinement.measuredAt : 'n/a'}, `
            + `custody signature verified, all six controls with an unrestricted positive control and a real restricted attack`,
          ],
        };
      }
      return { level: measured.level, reasons: status.unavailable };
    }
    return probeTrustLevelReadOnly(store);
  } catch (e) {
    return { level: 'UNSUPPORTED', reasons: [`the trust store could not be examined: ${String((e as Error).message ?? e)}`] };
  }
}

/** Which harnesses are present here, and whether each can actually gate an
 *  agent's completion. `gated: false` is a fact an agent must not misread. */
export function agentCapability(root: string): { harnesses: Array<{ id: string; label: string; gated: boolean; reason: string }>; hooked: boolean } {
  const { found, integrable } = detectHarnesses(root);
  return {
    harnesses: found.map((h) => ({ id: h.name, label: h.label, gated: h.supported, reason: h.action })),
    // v1.3, slice 1: `hooked` means A HOOK IS INSTALLED HERE — not "an agent we could hook is present".
    // Detection is a different question and it was answering this one; see gatingHookInstalled.
    hooked: integrable !== null && gatingHookInstalled(root),
  };
}

/**
 * v1.3, slice 1 — IS THE COMPLETION HOOK ACTUALLY INSTALLED IN THIS REPOSITORY?
 *
 * MEASURED (tooling/probes/v13-journey-baseline.mjs): on a repository whose `.claude/` directory held
 * nothing but a skill file — no `settings.json`, no hook — `canary agents` printed
 * "CONNECTED — Claude Code can gate completions here." and exited 0, while `canary status` on the
 * SAME bytes said "NOT CONNECTED … no config, no hooks, no proof" and exited 2. Two commands
 * contradicted each other, and the optimistic one was the successful one.
 *
 * The cause is a question substitution: detection answers "is this agent present?", for which
 * `.claude/` existing is enough — and on any machine with Claude Code installed, `~/.claude` exists,
 * so it is effectively always true — while the verdict was phrased as a claim that a completion can be
 * BLOCKED. Only the second question is a protection claim, and it has a definite answer that
 * `status`/`readOnlyProblems` already compute from the config and the settings files.
 *
 * This is that same evidence, exposed for the callers that phrase a verdict. It is READ-ONLY: no
 * spawn, no write, no verdict of its own — it reports whether Canary's own hook entry is present in a
 * settings file Canary manages, under a config Canary still trusts.
 */
export function gatingHookInstalled(root: string): boolean {
  const cfg = readConfig(root);
  if (cfg === null || cfg === 'corrupt') return false;
  if (untrustedConfigReason(root, cfg)) return false;
  return cfg.touched.some((t) => {
    // v1.3 §C: an MCP server entry is not a completion hook; asking the hook question of that file
    // would be a category error, and the answer would be a false negative.
    if (t.kind === 'mcp') return false;
    if (!fs.existsSync(t.path)) return false;
    const doc = parseJsonOrNull(t.path);
    return doc !== null && hasCanaryEntry(doc, new Set(cfg.hookCommands));
  });
}

/** The checks as an agent needs them: what, which ecosystem, where, and the
 *  exact command. Never throws — a legacy step reports the command shape that
 *  will actually be built for it. */
export function protocolChecks(cfg: CanaryConfig): Array<{ kind: string; script: string; adapter: string; scope: string; argv: string[] }> {
  return cfg.plan.map((s) => ({
    kind: s.kind,
    script: s.script,
    adapter: s.adapter ?? cfg.project ?? 'node',
    scope: s.scope ?? '',
    argv: s.argv ?? [s.pm ?? cfg.pm, 'run', s.script],
  }));
}

function sealedCopyReport(root: string, cfg: CanaryConfig): string {
  const store = storeFromEnv();
  let projectId: string, tail: string, level: string;
  try {
    projectId = projectIdForRoot(root);
    level = probeTrustLevelReadOnly(store).level;
    tail = ` (store ${store.root}, level ${level})`;
  } catch (e) {
    return `sealed copy: unreadable store — ${(e as Error).message}`;
  }
  const open = openSealed(store, { projectId, kind: 'plan-seal' });
  if (open.status === 'missing') return `sealed copy: none yet — this repo predates sealing or was set up elsewhere; run setup to seal it${tail}`;
  if (open.status !== 'valid') return `sealed copy: ${open.status.toUpperCase()} — ${open.reason}${tail}`;
  const same = !!cfg.planAuthority && canonicalJson(open.envelope!.payload) === canonicalJson(cfg.planAuthority);
  return same
    ? `sealed copy: store seq ${open.envelope!.seq} matches this config's sealed authority${tail}`
    : `sealed copy: MISMATCH — the .canary config and the sealed record disagree; run setup to re-seal deliberately${tail}`;
}

/**
 * canary status — the Lazy-Connect read surface: "Canary already recognizes
 * this environment; what is its state?" Answers from config and wiring bytes
 * on disk only — ZERO project commands executed, ZERO writes: the only
 * subprocesses are a few read-only git metadata probes (tracked-file and
 * toplevel checks under Canary's hardened git), so a full status run leaves
 * the repo byte-identical. Every line is a fact about state, never a claim
 * that the project passes; the checkpoint is reported as history, not health.
 */
export function cmdStatus(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'status' });
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('NOT CONNECTED', 'not inside a git repository — Canary has nothing to attach to here.', 'cd into your project, then: canary setup --yes'); return 2; }
  o.context({ root });
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NOT CONNECTED', "Canary's local config (.canary/canary.local.json) is unreadable.", 'run: canary setup --yes (rewrites it; your other settings are untouched)'); return 2; }
  if (!cfg) { o.verdict('NOT CONNECTED', `${root} is a git repository but Canary was never set up here — no config, no hooks, no proof.`, 'when you want protection here: canary setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NOT CONNECTED', `Canary found a local config it does not trust (${distrust}) — it will not run plans from it.`, "run: canary setup --yes (rewrites it as this machine's own)"); return 2; }
  const problems = readOnlyProblems(root, cfg, false); // state only — no liveness spawn
  if (problems.length) {
    o.context({ problems });
    o.verdict('NEEDS ATTENTION', `Canary is set up in ${root}, but its wiring is not sound:`, '');
    for (const p of problems) o.say(`  - ${p}`);
    o.say('next: canary setup --yes repairs the above; canary doctor proves the checks actually run');
    return 2;
  }
  o.context({
    checks: protocolChecks(cfg),
    security: securityCapability(),
    agent: agentCapability(root),
  });
  o.say(`repo: ${root}`);
  o.say(`plan: ${cfg.plan.length} step(s): ${cfg.plan.map((s) => `${s.kind}:${s.script}`).join(', ')} — sealed authority intact`);
  o.detail(sealedCopyReport(root, cfg));
  const task = readTaskRecord(root);
  o.say(`task: ${task ? `${task.kinds.join('+')} (${task.requirementCount} requirement(s))` : 'none registered — verify will demand a frozen task before any PASS'}`);
  let candidates: string[] = [];
  try { candidates = fs.readdirSync(path.join(root, CONFIG_DIR, 'candidates')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { /* no registry yet = none */ } // 'candidates' must match CANDIDATES_SUBDIR in candidate.ts
  o.say(`candidates: ${candidates.length ? candidates.join(', ') : 'none'}`);
  const cp = parseJsonOrNull(path.join(root, CONFIG_DIR, CHECKPOINT_FILE));
  o.say(`last checkpoint: ${cp ? `${cp.status} (${cp.source}) at ${cp.at} — a past run, NOT a claim about now` : 'none'}`);
  o.verdict('CONNECTED', 'Canary recognizes this repo: trusted config, wiring intact, sealed authority un-drifted. No project command was executed to answer this — only a few read-only git metadata reads — this is a statement about state, not about your code passing.', 'to run the checks: canary doctor');
  return 0;
}

export function cmdDoctor(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'doctor' });
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository.', 'cd into your project'); return 2; }
  o.context({ root });
  // 1.1: the "no package.json → UNSUPPORTED" gate is gone. Doctor's question is
  // "is Canary actually protecting this repo?", and the config answers it for
  // every ecosystem; a repo that was never set up says so below.
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Canary's local config (.canary/canary.local.json) is unreadable.", 'run: canary setup (rewrites it; your other settings are untouched)'); return 2; }
  if (!cfg) {
    // "Never set up" and "nothing here to set up" are different facts, and only
    // the first one is about wiring. A directory with no recognizable project
    // has nothing Canary could protect, so it is UNSUPPORTED — which also keeps
    // the answer honest when findRepoRoot lands on an unrelated ancestor repo
    // (a stray .git above a temp dir is a real thing to hit).
    const composed = composePlan(root);
    if (composed.problems.length) {
      o.verdict('NEEDS ATTENTION', `the nested-scope declaration (${SCOPES_FILE}) is not usable: ${composed.problems.join('; ')}.`, `fix ${SCOPES_FILE} (or delete it to go back to root-only discovery), then run: canary setup --yes`);
      return 2;
    }
    if (composed.scopes.length === 0) {
      o.verdict('UNSUPPORTED', `${root} has no project Canary can model at its root (no package.json, pyproject.toml / setup.py / tox.ini, Cargo.toml, go.mod / go.work).`, `if your checks live in subdirectories, declare them in ${SCOPES_FILE}, then: canary setup --yes`);
      return 2;
    }
    o.verdict('NEEDS ATTENTION', 'Canary is NOT fully active yet — this repo was never set up.', 'run: canary setup --yes'); return 2;
  }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Canary found a local config it does not trust (${distrust}) — it will not run plans from it.`, 'run: canary setup --yes (rewrites it as this machine\'s own)'); return 2; }

  const problems = readOnlyProblems(root, cfg, true); // doctor is about to execute — liveness is its question
  if (problems.length) {
    o.context({ problems });
    o.verdict('NEEDS ATTENTION', 'Canary is NOT fully active here:', '');
    for (const p of problems) o.say(`  - ${p}`);
    o.say('next: canary setup --yes repairs the above without touching your other settings');
    return 2;
  }
  // Facts every later verdict in this command needs: the sealed checks, the
  // MEASURED custody level, and which harnesses can actually gate an agent.
  o.context({ checks: protocolChecks(cfg), security: securityCapability(), agent: agentCapability(root) });
  // READY is earned HERE, now — the plan runs in every doctor invocation, so a
  // hand-written or stale checkpoint can never produce READY on its own (S4).
  // --run is accepted but no longer changes behavior.
  // 1.1 §23 — the OPT-IN fast path. It is off unless `--fast` is asked for, and
  // it can only leave out a step the PROJECT declared paths for, whose declared
  // paths the change provably missed. An undeclared check always runs, an empty
  // change set runs everything, and every skip is printed AND carried in the
  // envelope: a skip is not a pass, and a run that was not the full plan must not
  // be readable as one.
  const changedTouched = opts.fast ? collectDiffSignals(root, cfg).touched : [];
  const decision = opts.fast ? decideFastPath(cfg.plan, cfg.planAuthority?.stepPaths ?? {}, changedTouched) : null;
  if (decision !== null && decision.usedFastPath) {
    o.context({ skipped: decision.skipped.map((s) => ({ step: s.key, reason: s.reason })) });
    o.say('FAST PATH — sealed declarations justify leaving out these checks (a skip is NOT a pass):');
    for (const s of decision.skipped) o.say(`  ~ skipped ${s.step.kind}: ${s.step.script} — ${s.reason}`);
  }
  const stepsToRun = decision === null ? cfg.plan : decision.run;
  o.say('running the verification plan:');
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  const refused: string[] = [];
  for (const s of stepsToRun) {
    let r: StepResult;
    try { r = runPlanStep(root, cfg.pm, s); }
    catch (e) { refused.push(`plan step "${s.script}" refused: ${(e as Error).message}`); continue; }
    ran.push(r); o.step(r); if (!r.ok) failed.push(r);
  }
  if (refused.length) {
    // a script name Canary will not execute is a config problem, not a test
    // result — honest NEEDS ATTENTION, no checkpoint, no fake run.
    writeVerificationBundle(root, 'doctor', ran, 'blocked', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
    o.context({ problems: refused });
    o.verdict('NEEDS ATTENTION', 'the config names a script Canary will not execute — doctor cannot certify this plan:', '');
    for (const p of refused) o.say(`  - ${p}`);
    o.say('next: canary setup --yes reseals from the package.json scripts');
    return 2;
  }
  writeVerificationBundle(root, 'doctor', ran, failed.length ? 'fail' : 'pass', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
  writeCheckpoint(root, failed.length ? 'fail' : 'pass', failed.map((f) => f.kind), 'doctor');
  if (failed.length) {
    o.context({ problems: failed.map((f) => `${f.kind} failed: ${f.display}`) });
    o.verdict('NEEDS ATTENTION', `wiring is good, but the checks just failed (${failed.map((f) => f.kind).join(', ')}) — your code is talking, not Canary.`, 'fix the failing checks (ask the agent), then: canary doctor');
    return 2;
  }
  // M6: the same obligation read a checkpoint makes, for humans (no hook stdin
  // here, so only the registered task hint participates; unattributable states
  // say UNPROVEN rather than pretending to a verdict).
  const task = readTaskRecord(root);
  const obligations = obligationsFor(task?.kinds ?? [], collectDiffSignals(root, cfg), new Set(cfg.plan.map((s) => s.kind)), task?.requirementCount ?? 0, 'setup', task, cfg);
  // Measured, not inferred: is the sealed plan SENSITIVE to this change at all? When the
  // measurement exists it supersedes the declared-kind heuristic (see cmdCheckpoint).
  const regression = discriminationObligation(root, cfg);
  if (regression !== null) {
    for (let i = obligations.length - 1; i >= 0; i -= 1) {
      if (obligations[i]!.id === regression.id) obligations.splice(i, 1);
    }
    obligations.push(regression);
  }
  const unmet = obligations.filter((x) => x.status === 'unmet');
  const unproven = obligations.filter((x) => x.status === 'unproven');
  const objectiveOpen = unproven.filter((x) => x.mode === 'objective');
  const subjectiveOpen = unproven.filter((x) => x.mode !== 'objective');
  if (unmet.length > 0) {
    o.context({ problems: unmet.map((x) => x.note) });
    o.verdict('NEEDS ATTENTION', `the sealed checks pass, but a proof obligation is objectively violated — ${unmet.map((x) => x.note).join('; ')}`, 'restore the deleted verification files (git checkout -- <path>) — or a human reviews this deletion; then: canary doctor');
    return 2;
  }
  /**
   * FAIL CLOSED, scoped to what was AUTHORIZED. The product invariant: Canary must never issue
   * PASS/READY merely because the configured tests are green while authorized requirements are not
   * independently covered, and missing or ambiguous proof must never degrade to PASS.
   *
   * Two classes, deliberately treated differently:
   *   - OBJECTIVE obligations (regression evidence, lost coverage, an unbound sealed target) always
   *     refuse READY;
   *   - NON-OBJECTIVE ones refuse READY only when a TASK was registered, because then a human
   *     authorized a requirement that needs their acceptance. Without a task record they are
   *     Canary's own inference from the diff (e.g. "a lockfile changed"), and refusing READY for
   *     that would fail the documented journeys: a green Rust crate whose first `cargo check`
   *     created `Cargo.lock` would be reported NOT PROVEN (measured — that is exactly what the
   *     rust/go end-to-end probes caught).
   */
  const authorized = task !== null;
  const refuse = objectiveOpen.length > 0 || (authorized && subjectiveOpen.length > 0);
  if (refuse) {
    o.context({ problems: unproven.map((x) => `UNPROVEN: ${x.note}`) });
    const because = objectiveOpen.length > 0
      ? `${objectiveOpen.length} objective obligation(s) have no adequate proof`
      : `${subjectiveOpen.length} authorized requirement(s) need a human's explicit acceptance`;
    o.verdict('NOT PROVEN',
      `the checks passed, but the task is not proven: ${because} — a green plan is not a proven deliverable (NO PROOF, NO DONE).`,
      objectiveOpen.length > 0
        ? 'close it with a sealed check: bind the requirement to a matching script in package.json canary.proofs and re-run canary setup — or take the work through a candidate (canary work <name> … → canary finish <name>) and have a human accept it there'
        // MEASURED dead end this replaces: the base-repo path has NO candidate, so "canary accept
        // <candidate>" alone was a command that could only fail. Both real paths are named instead.
        : 'bind each requirement to a sealed check (package.json canary.proofs + canary setup), or take the work through a candidate and have a human accept it there: canary work <name> "<intent>" → canary finish <name> → canary accept <candidate> in a terminal');
    for (const ob of unproven) o.say(`  - UNPROVEN [${ob.id}] (${ob.mode}): ${ob.note}`);
    return 2;
  }
  o.verdict('READY', 'wiring verified; the checks just ran and passed, and no proof obligation is open.', 'nothing to do — the agent finishes, Canary checks');
  if (unproven.length > 0) {
    // Nothing was authorized, so these are Canary's own observations about the diff. They are said
    // plainly — READY here means "your checks passed", never "your change is proven".
    o.say(`note: ${unproven.length} observation(s) about this diff are UNPROVEN and are not covered by any authorized requirement — the plan passing does not prove them (NO PROOF, NO DONE).`);
  }
  for (const ob of obligations) o.detail(`obligation [${ob.id}] ${ob.status.toUpperCase()} (${ob.mode}): ${ob.note}`);
  // M3 (verbose-only — trust classes are evidence internals, not default UX):
  o.detail('trust: this READY is CANARY_OBSERVED — Canary executed the checks in this very invocation. Agent words are AGENT_REPORTED and never sufficient for a PASS; no class is promoted by copying bytes into a Canary-owned file (evidence is never read back for verdicts).');
  if (cfg.planAuthority) o.detail('authority: every command that just ran is one setup sealed — script-text drift is blocked before execution, not excused after it passes.');
  o.detail(sealedCopyReport(root, cfg));
  return 0;
}

export function cmdUninstall(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository.', 'cd into the project you set up'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Canary's local config is unreadable, so Canary cannot tell which settings entries it owns.", 'run: canary setup (recreates the config), then canary uninstall'); return 2; }
  if (!cfg) { o.say('Canary is not installed in this repo — nothing to remove.'); return 0; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Canary will not remove settings based on a config it does not trust (${distrust}) — it cannot prove which entries are its own.`, 'run: canary setup --yes (recreates the record as this machine\'s own), then canary uninstall'); return 2; }
  // M9 additive: BOTH refusal checks run BEFORE any hook is touched. An
  // uninstall that ends up refusing must not leave a repo with its hooks
  // stripped while the config stays live — that is a modified verification
  // authority (the pre-execution containment gate in candidate.ts blocks on
  // exactly that state), and a refusal should never manufacture it. These are
  // preconditions of the teardown, not after-the-fact exceptions.
  if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) {
    o.verdict('NEEDS ATTENTION', '.canary resolves outside the repository (a link?) — Canary will not delete through it.', 'replace it with a real folder, then re-run: canary uninstall'); return 2;
  }
  // M7: .canary/candidates holds the registry and (by default) the candidate
  // worktrees themselves. Removing .canary wholesale would orphan a worker's
  // tree and erase the records proving it belongs to this repo (guarantee 11).
  try {
    if (fs.readdirSync(path.join(root, CONFIG_DIR, 'candidates')).length > 0) { // must match CANDIDATES_SUBDIR in candidate.ts
      o.verdict('NEEDS ATTENTION', "candidates are still registered under .canary/candidates — uninstall would remove Canary's registry while the worktrees (and the worker's edits in them) remain.", 'canary isolate --list, then --remove each (or --discard), then re-run: canary uninstall'); return 2;
    }
  } catch { /* absent or empty: nothing to protect */ }
  const { removed, problems } = uninstallHooks(root, cfg);
  if (problems.length) {
    // keep .canary: it is the ownership record the advertised retry needs (S6)
    o.verdict('NEEDS ATTENTION', `Canary removed ${removed} of its hook entries but ${problems.length} file(s) could not be cleaned completely; its ownership record (.canary) is kept so a retry can finish the job:`, 'fix the listed files, then re-run: canary uninstall is safe to repeat');
    for (const p of problems) console.log(`  - ${p}`);
    return 2;
  }
  fs.rmSync(path.join(root, CONFIG_DIR), { recursive: true, force: true });
  o.say(`removed ${removed} Canary hook entr${removed === 1 ? 'y' : 'ies'}; every other settings entry was kept (content preserved — re-serialization may reformat whitespace).`);
  o.verdict('READY', 'Canary is fully removed from this repo.', 'to bring it back: canary setup');
  return 0;
}

/**
 * Harness entry point (Claude Code Stop hook). Contract:
 *  - stdin: hook JSON {cwd?, stop_hook_active?, task?}; stdout JSON decisions; exit 0.
 *    (`task` is M4-additive: an optional AGENT_REPORTED provenance label,
 *    stored as a digest only; old senders and unknown keys behave as before.)
 *  - all checks pass => silence (human is NOT interrupted when nothing is needed)
 *  - a check fails   => {"decision":"block", reason} => agent gets one repair turn
 *  - infra failure / unconfigured / loop guard => allow + honest systemMessage, never a fake green
 *  - corrupt local config => loud honest UNVERIFIED (GLM F-1) — absence is silent,
 *    damaged authority is NOT
 */
export async function cmdCheckpoint(): Promise<number> {
  let input: { cwd?: string; stop_hook_active?: boolean; task?: string } = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) as typeof input; } catch { /* interactive invocation or empty stdin */ }
  // M4: optional task/intent label from the hook — DIGEST only, raw prose is
  // never stored or echoed, so provenance cannot become a smuggling channel
  // for agent-authored text. AGENT_REPORTED by nature: a label on evidence,
  // zero verdict authority either way.
  const taskDigest = typeof input.task === 'string' && input.task.trim()
    ? sha256(input.task.trim().slice(0, 4000)) : undefined;
  const root = findRepoRoot(input.cwd ?? process.cwd());
  const cfg = root ? readConfig(root) : null;
  const emit = (obj: Record<string, unknown>) => { console.log(JSON.stringify(obj)); return 0; };
  if (!root || cfg === null) return 0; // nothing wired here — stay out of the way
  // GLM F-1: a config file that EXISTS but cannot be read is NOT "nothing wired
  // here" — treating it as absence is a silent allow through damaged authority.
  // Honest UNVERIFIED (allow + systemMessage, same posture as S2/empty-plan):
  // never a fake green, never a fake block on evidence we could not examine.
  if (cfg === 'corrupt') {
    return emit({ systemMessage: 'Canary could not verify this task because its local config (.canary/canary.local.json) is unreadable — nothing was verified; this completion is UNVERIFIED, not a pass. Run: canary setup' });
  }
  // A config this installation did not write (bogus cliPath) or that arrived
  // from a clone (tracked in git) must never drive execution (S2) — say so
  // loudly instead of silently laundering an attacker's plan into "pass".
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) return emit({ systemMessage: `Canary found local config it does not trust (${distrust}) — nothing was verified; this completion is UNVERIFIED. Run: canary setup` });
  if (!Array.isArray(cfg.plan) || cfg.plan.length === 0) {
    // degenerate/hand-edited config: executing zero checks is NOT a pass — say so, don't fake green
    return emit({ systemMessage: 'Canary: the verification plan is empty, so nothing was checked — this completion is UNVERIFIED, not a pass. Run: canary doctor' });
  }
  // M5: check the SEALED AUTHORITY before executing anything — a candidate-
  // edited command must never be certified as proof, not even by failing on
  // it. Verdict authority stays Canary's own execution; this gate only
  // decides WHICH commands may run as proof at all.
  const drift = adapterFor(cfg).drift(root, cfg);
  if (drift) {
    writeCheckpoint(root, 'fail', ['authority'], 'checkpoint'); // state, not a bundle: nothing was executed
    if (input.stop_hook_active === true) {
      // same no-loop posture as a failed plan: one repair turn, then honest stop
      return emit({ systemMessage: `Canary: verification authority is still changed (${drift.slice(0, 200)}) after one repair attempt — stopping anyway; a human should look.` });
    }
    return emit({ decision: 'block', reason: `Canary blocked completion: verification authority changed by candidate — ${drift}. Canary will not certify proof commands it never sealed. Restore the sealed checks, or have a human run: canary setup (re-runs the new command under a visible smoke test and re-seals it).` });
  }

  // M4 provenance for every bundle this invocation writes — from the TRUSTED
  // in-memory config (shape-checked, non-distrusted above), never re-read from
  // the evidence dir.
  const prov: BundleProvenance = {
    planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null,
    ...(taskDigest ? { taskDigest } : {}),
  };
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  let infra = '';
  for (const s of cfg.plan) {
    let r: StepResult;
    try { r = runPlanStep(root, cfg.pm, s); } catch (e) { infra = String(e); break; }
    ran.push(r);
    if (!r.ok) failed.push(r);
  }
  if (infra) {
    writeVerificationBundle(root, 'checkpoint', ran, 'infra', prov);
    writeCheckpoint(root, 'infra', failed.map((f) => f.kind), 'checkpoint');
    return emit({ systemMessage: `Canary could not run the checks (${infra.slice(0, 160)}) — this completion is UNVERIFIED, not a pass.` });
  }
  if (failed.length === 0) {
    writeVerificationBundle(root, 'checkpoint', ran, 'pass', prov);
    writeCheckpoint(root, 'pass', [], 'checkpoint');
    // M6 (spec M5): the plan passing is the FLOOR, not the finish. Evaluate
    // this task's proof obligations against what Canary observed in THIS
    // invocation (plan outcome + contained git diff). Objective violation
    // blocks; anything unprovable rides an honest systemMessage — an allow
    // that SAYS so, never a silent fake-complete. TESTS PASSING != PROVEN.
    const task = readTaskRecord(root);
    const kinds = task && task.kinds.length > 0
      ? task.kinds
      : (typeof input.task === 'string' && input.task.trim() ? inferTaskKinds(input.task.trim().slice(0, 4000)) : []);
    const obligations = obligationsFor(kinds, collectDiffSignals(root, cfg), new Set(cfg.plan.map((s) => s.kind)), task?.requirementCount ?? 0, 'setup', task, cfg);
    /**
     * MEASUREMENT SUPERSEDES INFERENCE. `obligationsFor` decides regression evidence from the
     * DECLARED kind and the diff ("a bugfix with no test file touched is unproven"); the
     * discrimination run decides it from execution. When the measurement exists it wins — otherwise
     * a bugfix that turns an existing red check green (real regression evidence, no test file
     * touched) would be called unproven, and a test file touched for show would be called met.
     */
    const regression = discriminationObligation(root, cfg);
    if (regression !== null) {
      for (let i = obligations.length - 1; i >= 0; i -= 1) {
        if (obligations[i]!.id === regression.id) obligations.splice(i, 1);
      }
      obligations.push(regression);
    }
    const unmet = obligations.filter((x) => x.status === 'unmet');
    const unproven = obligations.filter((x) => x.status === 'unproven');
    const objectiveOpen = unproven.filter((x) => x.mode === 'objective');
    if (unmet.length > 0) {
      writeCheckpoint(root, 'fail', ['obligation'], 'checkpoint'); // state, like the authority gate: the plan DID pass — the obligation did not
      const why = unmet.map((x) => x.note).join('; ');
      if (input.stop_hook_active === true) {
        return emit({ systemMessage: `Canary: a proof obligation is still unmet (${why.slice(0, 200)}) after one repair attempt — stopping anyway; a human should look.` });
      }
      // the advice must actually fix BOTH attributable shapes: `git checkout --`
      // restores from the INDEX, which is exactly where a staged deletion lives
      // (review #3) — restore from HEAD across index and worktree instead.
      return emit({ decision: 'block', reason: `Canary blocked completion: ${why}. A green plan cannot certify checks that no longer exist. Restore them (git restore --source=HEAD --staged --worktree <path>) or have a HUMAN review this deletion — an agent claim cannot authorize it (claims are not evidence).` });
    }
    if (unproven.length > 0) {
      // FAIL CLOSED on an OBJECTIVE obligation, as the product invariant requires: an objective
      // requirement with no adequate proof must stay NOT PROVEN, and "the plan is green" is not a
      // discharge of it.
      if (objectiveOpen.length > 0) {
        writeCheckpoint(root, 'unproven', objectiveOpen.map((x) => x.id), 'checkpoint');
        /**
         * BLOCK ONLY WHAT THE WORKER CAN ACTUALLY CLOSE (v1.2, Mission 2).
         *
         * MEASURED, and this is the whole reason for the split: the block reason embeds each
         * obligation's note, and some notes describe an OPERATOR act — "bind each uncovered digest
         * in package.json canary.proofs and re-run canary setup". A worker cannot bind a frozen
         * proof; only the operator can. Blocking with that text reads to a model as an instruction it
         * must satisfy, and it complies: measured on this host, `cli-exit-codes/guarded` with seven
         * unbound requirements ran **39 turns to 537,583 tokens and still timed out**, while the same
         * fixture's plain arm finished in 18 turns. v1.1 recorded the same shape at 1.5-1.85M tokens.
         *
         * The split is the one `candidate.ts` already prints at the candidate boundary: a duty the
         * worker can discharge with evidence in the repository belongs in a BLOCK; a duty that only an
         * operator or a human can close belongs in a message that says plainly it is not the worker's
         * — the shape that already exists below for subjective duties, and that was written for
         * exactly this reason.
         *
         * NOTHING IS SOFTENED BY THIS: the checkpoint is still written `unproven`, `doctor` still
         * refuses with NOT PROVEN and exit 2, promotion is still locked, and the message still says the
         * completion is not proven. What changes is only whether the model is ordered to keep working
         * on something it cannot finish.
         */
        const workerClosable = (x: { id: string; mode: string }): boolean =>
          x.mode === 'objective' && !x.id.startsWith('target-') && x.id !== 'per-requirement';
        const byWorker = objectiveOpen.filter(workerClosable);
        const byOperator = objectiveOpen.filter((x) => !workerClosable(x));

        if (byWorker.length > 0) {
          const why = byWorker.map((x) => x.note).join(' | ');
          if (input.stop_hook_active === true) {
            return emit({ systemMessage: `Canary: NOT PROVEN (${why.slice(0, 1200)}) — after one repair attempt. Stopping anyway; a human should look, or accept it with: canary accept`.slice(0, 2000) });
          }
          return emit({ decision: 'block', reason: `Canary blocked completion: NOT PROVEN — ${why.slice(0, 1200)}`.slice(0, 1400) });
        }

        // Every open objective duty is operator-only. Say so, and let the turn end.
        const operatorWhy = byOperator.map((x) => x.note).join(' ');
        return emit({ systemMessage: `Canary: the sealed checks passed, but the work is NOT PROVEN: ${byOperator.length} duty(ies) remain open and NONE of them is yours to close — each needs the OPERATOR (bind the requirement to a check the sealed plan runs, then re-run canary setup) or a HUMAN (canary accept). This is not a failure of your change: do NOT keep working on it, do NOT edit checks to make it disappear, and do NOT report it as done. Finish now and report exactly what is still open. Details: ${operatorWhy}`.slice(0, 2000) });
      }
      // Subjective / operator-only duties: an agent cannot accept a duty for a human, and — MEASURED
      // (`bench-r9`) — an agent TOLD to close one spends enormous effort trying: two trials with five
      // registered requirements burned 1.5M and 1.7M tokens over 41 and 45 turns for work that was
      // already green, because the message read as an instruction it could satisfy. So this says
      // plainly that the duty is not the worker's, and that finishing and reporting IS the correct end.
      return emit({ systemMessage: `Canary: the sealed checks passed. ${unproven.length} duty(ies) remain OPEN, and NONE of them is yours to close — each needs an operator or a human. This is not a failure of your change: do NOT keep trying to satisfy them, do NOT edit checks to make them disappear, and do NOT report them as done. Finish now and report exactly what is still open. Details: ${unproven.map((x) => x.note).join(' ')}`.slice(0, 2000) });
    }
    /**
     * Nothing is open: the plan passed, every objective obligation is met, and the
     * regression-evidence obligation (when it could be measured at all) is met because the checks
     * demonstrably fail without the change. That is the strongest thing this gate can say, and it is
     * the only path to a silent allow.
     */
    /**
     * …EXCEPT when a MET obligation's evidence is weaker than "met" sounds. MEASURED
     * (`bench-final-constraint-hold-guarded-3`): the worker added its own check file, the plan passed,
     * and the stated rule was STILL broken — the hidden oracle found it while Canary said READY. The
     * gate cannot call that a failure (the check really does discriminate the change, and no
     * requirement was authorized to hold it to), but it must not stay silent either: an allow that
     * SAYS what the evidence is beats a READY that hides it.
     */
    const caveats = obligations.filter((x) => x.status === 'met' && x.caveat !== undefined);
    if (caveats.length > 0) {
      return emit({ systemMessage: `Canary: the sealed checks passed — with a caveat. ${caveats.map((x) => `${x.id}: ${x.caveat}`).join(' ')}`.slice(0, 2000) });
    }
    return 0; // silent even if an agent claim contradicts — claims never BLOCK, and never CREATE a pass
  }
  // The full runner output is written NEXT TO the evidence bundle and referred to by path, so
  // the model is not forced to pay for bytes it usually does not need — and does not have to
  // re-run the suite to see more. Measured before this: the block carried up to 4000 characters
  // of raw output, which is roughly a thousand tokens per failed attempt, on every attempt.
  const bundleDir = writeVerificationBundle(root, 'checkpoint', ran, 'fail', prov);
  writeCheckpoint(root, 'fail', failed.map((f) => f.kind), 'checkpoint');
  if (input.stop_hook_active === true) {
    // already one repair attempt this turn — never loop the agent; surface honestly instead
    return emit({ systemMessage: `Canary: checks still failing (${failed.map((f) => f.kind).join(', ')}) after one repair attempt — stopping anyway; a human should look.` });
  }
  // M2: an agent claim may only ANNOTATE this already-decided block, and only
  // as a truthful claim-vs-observation contrast. Verdict authority: Canary's own
  // execution (exit code). Absent/unparseable claim => no note at all.
  let claimNote = '';
  const claim = readAgentClaim(root);
  if (claim) {
    const claimed = deriveObservedCounts(claim.text);
    const observed = deriveObservedCounts(failed.map((f) => `${f.stdout}${f.stderr}`).join('\n'));
    if (claimed && observed && (claimed.passed !== observed.passed || claimed.failed !== observed.failed)) {
      claimNote = `Claim is not evidence. Agent claimed: ${claimed.passed} passed / ${claimed.failed} failed (hint recorded ${claim.at}). ` +
        `Canary observed: ${observed.passed} passed / ${observed.failed} failed, from its own run of ${JSON.stringify(failed.map((f) => f.display).join(' + '))}. ` +
        `Repair the observed failures.\n`;
    }
  }
  const reason = `${claimNote}${buildFailurePayload({
    steps: failed.map((f) => ({
      kind: f.kind, display: f.display, exitCode: f.exitCode,
      stdout: f.stdout ?? '', stderr: f.stderr ?? '',
    })),
    writeLog: (kind, text) => {
      if (typeof bundleDir !== 'string' || bundleDir === '') return null;
      const p = path.join(bundleDir, `${kind.replace(/[^A-Za-z0-9-]/g, '-')}.log`);
      try { fs.writeFileSync(p, text); return p; } catch { return null; }
    },
  })}`;
  return emit({ decision: 'block', reason });
}

/**
 * M2 claim intake: the agent records what it BELIEVED happened. The claim is
 * stored as an untrusted hint next to Canary's own evidence and can never
 * create, block, or modify a verdict — only annotate a block Canary decided
 * from checks it executed itself. (Tests passing != task proven complete;
 * agent-reported != canary-observed.)
 */
/**
 * THE OPERATOR'S BINDING ACT — `canary bind <script> --requirement "<stated requirement>"`.
 *
 * WHY IT EXISTS (MEASURED, `bench-r9`/`r9b`): a task registered with five requirements and no sealed
 * proof cost the worker 1.5M and 1.7M tokens over 41–48 turns — the work was green, but the open
 * per-requirement duty invited the agent to keep trying to discharge something only an operator can
 * close. The invariant says every objective requirement must have a FROZEN PROOF OBLIGATION or remain
 * NOT PROVEN; the second half was reachable, the first was not, because binding meant hand-editing
 * `package.json` `canary.proofs` with a 64-hex digest nobody had printed.
 *
 * This command is that act, and it is deliberately narrow: it refuses a script the sealed plan does
 * not run, it writes the DECLARATION, and — with `--reseal` — it also commits that one file and
 * re-runs the seal, so the operator's path is ONE command instead of three. It is an operator
 * command, not an agent-facing one: what a binding may point at is still decided by the plan the
 * operator already sealed.
 *
 * WHY `--reseal` ADDS STEPS SAVED AND NOT AUTHORITY (v1.2, Mission 2's last named gap). The ritual
 * was `bind` → commit → `canary setup`, and the middle step is the one that silently breaks the
 * result if forgotten: a binding that lives only in the working tree makes the sealed base dirty,
 * and a dirty base cannot establish discrimination, so the requirement stays NOT PROVEN for a reason
 * that has nothing to do with the requirement (measured; that is why the note below exists). What
 * `--reseal` does NOT change is who may seal: `canary setup` has never enforced that — it runs
 * unattended, `--yes` or not — so this flag removes two commands without minting any authority. The
 * script must already be part of the SEALED plan, which is the operator's earlier act.
 */
export async function cmdBind(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const reseal = rawArgs.includes('--reseal');
  const positional = rest.filter((a) => !a.startsWith('--'));
  const script = positional[0];
  const requirements: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    if (rawArgs[i] === '--requirement' && typeof rawArgs[i + 1] === 'string') requirements.push(rawArgs[i + 1] as string);
  }
  if (script === undefined || requirements.length === 0) {
    o.say('usage: canary bind <script> --requirement "<the exact stated requirement>" [--requirement …] [--reseal]');
    o.say('  the script must be one your SEALED plan runs; bind, then run: canary setup (or add --reseal to do both)');
    return 3;
  }
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no project to bind a requirement to.', 'cd into your project and try again'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt' || !cfg) { o.verdict('NEEDS ATTENTION', 'Canary is not set up here, so there is no sealed plan to bind to.', 'run: canary setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Canary will not write a binding into a config it does not trust (${distrust}).`, 'run: canary setup --yes'); return 2; }
  if (!cfg.plan.some((s) => s.script === script)) {
    // Fail closed with the real recovery: the plan is what proves, so a script it does not run cannot
    // be a proof. (This is the same rule setup enforces when it validates canary.proofs.)
    o.verdict('NEEDS ATTENTION', `the sealed plan does not run a script named "${safePath(script)}" — a binding to it would prove nothing.`, `add that check to your package.json scripts and run: canary setup, then bind again. Plan scripts: ${cfg.plan.map((s) => s.script).map(safePath).join(', ')}`);
    return 2;
  }
  const pkgPath = path.join(root, 'package.json');
  const manifestPath = path.join(root, 'canary.project.json');
  /**
   * WHICH DECLARATION SURFACE? A Node project carries `package.json` `canary.proofs`; every other
   * project (Python, Rust, Go, anything the universal contract covers) has no package.json at all, so
   * the binding goes into `canary.project.json` `proofs`. MEASURED: before this, a non-Node project
   * could not bind a requirement anywhere, so its only reachable end state was human acceptance.
   */
  const targetPath = fs.existsSync(manifestPath) ? manifestPath : pkgPath;
  const isNode = targetPath === pkgPath;
  const surface = isNode ? 'package.json' : 'canary.project.json';
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as Record<string, unknown>; }
  catch (e) { o.verdict('NEEDS ATTENTION', `cannot read ${surface} to record the binding (${String(e).slice(0, 120)}).`, 'fix the file, then re-run'); return 2; }
  const canarySection = isNode && isRecord(doc.canary) ? { ...(doc.canary as Record<string, unknown>) } : {};
  const existingProofs = isNode ? canarySection.proofs : doc.proofs;
  const proofs: Record<string, unknown> = isRecord(existingProofs) ? { ...existingProofs } : {};
  const written: Array<{ digest: string; text: string }> = [];
  for (const r of requirements) {
    const d = materialDigest(r);
    proofs[d] = script;
    written.push({ digest: d, text: canonicalText(r).slice(0, 90) });
  }
  const sortedProofs = Object.fromEntries(Object.entries(proofs).sort(([a], [b]) => a.localeCompare(b)));
  if (isNode) doc.canary = { ...canarySection, proofs: sortedProofs };
  else doc.proofs = sortedProofs;
  try { writeFileAtomic(targetPath, `${JSON.stringify(doc, null, 2)}\n`); }
  catch (e) { o.verdict('NEEDS ATTENTION', `could not write the binding into ${surface} (${String(e).slice(0, 120)}).`, 'close whatever holds the file, then re-run'); return 2; }
  o.say(isNode
    ? `bound ${written.length} requirement(s) to the sealed script "${safePath(script)}":`
    : `bound ${written.length} requirement(s) to the declared check "${safePath(script)}" in canary.project.json:`);
  for (const w of written) o.say(`  ${w.digest}  "${w.text}"`);

  // The one-act path (v1.2, Mission 2's last named gap): declare, commit the declaration alone, seal.
  if (reseal) return await resealAfterBind(root, targetPath, script, opts, o);

  o.say('this is a DECLARATION, not a seal: run `canary setup` to seal it into the plan authority.');
  if (isNode) o.say('until then the requirement stays UNPROVEN — a green plan does not cover an unsealed binding.');
  /**
   * THE STEP THAT IS EASY TO MISS, AND IT COSTS A CONFUSING RESULT (v1.2, Mission 2).
   *
   * The discriminator compares the candidate against the SEALED BASE. A binding that lives only in the
   * working tree makes that baseline dirty, and a dirty baseline cannot establish discrimination — so
   * `setup` after an uncommitted bind leaves the requirement NOT PROVEN for a reason that has nothing
   * to do with the requirement. The recovery was documented in a probe and nowhere the operator would
   * look.
   *
   * Saying it HERE costs one line and removes the detour. It is reported, not enforced: committing is
   * the operator's act, and `setup` must still run afterwards — or `--reseal` performs both.
   */
  if (written.length > 0) {
    const id = candidateIdentity(root);
    if (id.dirty === true) {
      o.say('NOTE: the binding is written but NOT committed, and the working tree is now dirty.');
      o.say('  commit it BEFORE re-sealing, or the sealed base is dirty and discrimination cannot be established:');
      o.say(`  git add ${safePath(path.relative(root, targetPath) || path.basename(targetPath))} && git commit -m "bind requirement(s) to ${safePath(script)}"`);
      o.say('  then: canary setup');
      o.say('  ...or re-run this bind with --reseal, which commits the declaration and re-seals in one step.');
    } else if (id.dirty === null) {
      o.say('NOTE: could not determine whether the working tree is clean. If the binding is uncommitted, commit it before re-sealing — a dirty sealed base cannot establish discrimination.');
    }
  }
  return 0;
}

/**
 * `--reseal`: commit the declaration FILE and re-run the seal, in one operator act.
 *
 * The decisions worth stating once rather than inline:
 *
 * 1. NOTHING ELSE MAY BE DIRTY. A sealed base must be exactly what the operator reviewed; a commit
 *    that swept unrelated work in would make the base something else while looking like a binding.
 *    Canary's OWN files are excluded, for the reason `setup` excludes them from its baseline:
 *    `.canary/**` is self-ignored, and the managed harness files (`settings.json`, `.mcp.json`) are
 *    written by setup itself — refusing on Canary's own act would block the command with no operator
 *    fix available. The excluded set is read from `cfg.touched`, never hard-coded.
 * 2. THE COMMIT CARRIES ONLY THE DECLARATION FILE (`git commit -- <path>`), so a staged, unrelated
 *    change stays staged and uncommitted instead of riding along.
 * 3. IF THAT FILE IS ALREADY COMMITTED, nothing is committed: re-running the act is idempotent
 *    rather than an empty-commit failure.
 * 4. THE SEAL IS THE SAME `canary setup` the operator would have run, forwarded as `--yes` (the flag
 *    IS the consent), with `--json`/`--verbose` preserved so `--json` still emits exactly ONE
 *    envelope, from the setup path.
 */
async function resealAfterBind(
  root: string, targetPath: string, script: string,
  opts: GlobalOpts, o: Out,
): Promise<number> {
  const declRel = rel(root, targetPath).split(path.sep).join('/');
  const porcelain = gitWithinRoot(root, ['status', '--porcelain']);
  if (porcelain === null) {
    o.say(`REFUSED — could not read the git working-tree state, so the declaration cannot be committed safely. It IS written to ${safePath(declRel)}: commit it yourself, then run: canary setup`);
    return 2;
  }
  const ownSettings = rel(root, settingsPath(root)).split(path.sep).join('/');
  /**
   * What counts as "unrelated work"? Not Canary's own surface.
   *
   * MEASURED while writing this: `git status --porcelain` reports an untracked directory as `dir/` —
   * NOT as each file inside it — so matching the settings PATH alone let `.claude/` through as
   * "another change" and refused every `--reseal` on a project whose harness dir is not committed.
   * The check therefore accepts the directory entry that CONTAINS a managed file.
   *
   * MEASURED AGAIN, and this is why the list is derived rather than spelled: v1.3 taught `setup` to
   * write `.mcp.json` as well, and a hard-coded settings path then refused every `--reseal` on a
   * freshly wired repository — the operator was told their working tree had "other changes" that
   * Canary itself had just made, with no fix available except committing Canary's own file. The set
   * of files Canary manages is exactly what `setup` records in `cfg.touched` (the same list it
   * already excludes from its baseline), so it is read from there and stays correct as the managed
   * surface grows.
   */
  const cfgForOwn = readConfig(root);
  const ownPaths = cfgForOwn !== null && cfgForOwn !== 'corrupt'
    ? cfgForOwn.touched.map((t) => rel(root, t.path).split(path.sep).join('/'))
    : [ownSettings];
  const isCanaryOwned = (p: string): boolean => {
    if (p === '.canary' || p.startsWith('.canary/')) return true;
    if (ownPaths.includes(p)) return true;
    return p.endsWith('/') && ownPaths.some((own) => own.startsWith(p));
  };
  const changed = porcelain.split('\n').map(porcelainPath).filter((p): p is string => p !== null);
  const others = changed.filter((p) => p !== declRel && !isCanaryOwned(p));
  if (others.length > 0) {
    o.say(`REFUSED — the working tree has ${others.length} other change(s) (${others.slice(0, 3).map(safePath).join(', ')}${others.length > 3 ? ', …' : ''}), and --reseal commits the declaration ALONE: the sealed base must be exactly what you reviewed.`);
    o.say(`  the declaration IS written to ${safePath(declRel)}: commit that file together with the rest of your work, then run: canary setup`);
    o.say('  ...or commit or stash the other changes first, then re-run this command.');
    return 2;
  }
  let committed = 'the declaration was already committed — nothing to commit';
  if (changed.includes(declRel)) {
    if (gitWithinRoot(root, ['add', '--', declRel]) === null) {
      o.say(`REFUSED — git could not stage ${safePath(declRel)}. The declaration IS written: commit it yourself, then run: canary setup`);
      return 2;
    }
    if (gitWithinRoot(root, ['commit', '-m', `bind requirement(s) to ${script}`, '--', declRel]) === null) {
      o.say('REFUSED — git would not create the commit (are user.name and user.email configured?). The declaration IS written and staged: commit it yourself, then run: canary setup');
      return 2;
    }
    const sha = (gitWithinRoot(root, ['rev-parse', '--short', 'HEAD']) ?? '').trim();
    committed = `committed ${safePath(declRel)} alone as ${sha === '' ? 'HEAD' : sha}`;
  }
  o.say(`--reseal: ${committed}.`);
  o.say('re-sealing now: `canary setup` — the same act, so the saved round trip adds no authority (the script above was already part of the sealed plan).');
  const forwarded = ['--yes'];
  if (opts.json) forwarded.push('--json');
  if (opts.verbose) forwarded.push('--verbose');
  return await cmdSetup(forwarded);
}

/** Porcelain v1 is `XY PATH`, renames as `XY OLD -> NEW`, and quotes paths containing special characters. */
function porcelainPath(line: string): string | null {
  if (line.trim() === '') return null;
  const rest = line.slice(3).trim();
  const arrow = rest.lastIndexOf(' -> ');
  const raw = arrow === -1 ? rest : rest.slice(arrow + 4);
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.split(path.sep).join('/');
}

/** Minimal record guard, local to cmdBind: a hand-edited non-object here must never crash the write. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function cmdClaim(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const text = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!text) { o.say('usage: canary claim "<what the agent believes happened>"'); return 3; }
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no project here to attach a claim to.', 'cd into your project and try again'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Canary's local config is unreadable — it will not attach claims to state it cannot read.", 'run: canary setup'); return 2; }
  if (!cfg) { o.verdict('NEEDS ATTENTION', 'Canary is not set up in this repo, so there is no verification record to attach a claim to.', 'run: canary setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Canary will not record claims against a config it does not trust (${distrust}).`, "run: canary setup --yes (rewrites it as this machine's own)"); return 2; }
  try {
    if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) {
      o.verdict('NEEDS ATTENTION', '.canary resolves outside the repository (a link?) — Canary will not write claims through it.', 'replace it with a real folder, then re-run'); return 2;
    }
    // the claims PATH (not just .canary) must stay inside: a linked claims/
    // dir would otherwise let the atomic write land outside the repo (S3)
    const claimPath = path.join(root, CONFIG_DIR, CLAIMS_FILE);
    if (containedRealPath(root, claimPath) === null) {
      o.verdict('NEEDS ATTENTION', `${rel(root, claimPath)} resolves outside the repository (a link?) — Canary will not write claims through it.`, 'replace it with a real folder inside .canary, then re-run'); return 2;
    }
    fs.mkdirSync(path.dirname(claimPath), { recursive: true });
    writeFileAtomic(claimPath, JSON.stringify({
      at: new Date().toISOString(), kind: 'agent-claim',
      // M3: the writer is the agent, so the class is AGENT_REPORTED —
      // permanently insufficient for a PASS, by the read side's design.
      trustClass: 'AGENT_REPORTED',
      authority: 'UNTRUSTED HINT — claims are not evidence; verdicts come only from checks Canary executes',
      text: text.slice(0, 4000),
    }, null, 2) + '\n');
  } catch (e) {
    o.verdict('NEEDS ATTENTION', `could not record the claim (${String(e).slice(0, 140)}).`, 'fix the file/permission, then re-run'); return 2;
  }
  o.say('claim recorded as an UNTRUSTED hint. Canary does not execute, trust, or report anything from it;');
  o.say('the next completion check re-runs the plan itself and judges only its own execution (claim ≠ evidence).');
  return 0;
}

/**
 * 1.1 §21/§26 — `canary result`: the machine-readable answer to "what does
 * Canary know about this repo right now?" for an agent that must NOT spend its
 * context parsing prose or slurping logs.
 *
 * It reports FACTS with their provenance: the sealed checks, where the state
 * lives, the MEASURED custody level, which harnesses can actually gate, the
 * last recorded completion (labelled as history, never as health), and any
 * reason the wiring is not sound. It never runs the plan — that is `doctor` —
 * so calling it is free and safe for an agent to do at any time.
 */
export function cmdResult(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'result', schema: PROTOCOL_RESULT });
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('NOT CONNECTED', 'not inside a git repository — there is no Canary state to report here.', 'cd into your project, then: canary setup --yes'); return 2; }
  o.context({ root });
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NOT CONNECTED', "Canary's local config (.canary/canary.local.json) is unreadable, so nothing here can be reported as its state.", 'run: canary setup --yes (rewrites it; your other settings are untouched)'); return 2; }
  if (!cfg) { o.verdict('NOT CONNECTED', `${root} is a git repository but Canary was never set up here — no sealed checks, no proof, no result.`, 'when you want protection here: canary setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NOT CONNECTED', `Canary found a local config it does not trust (${distrust}) — it will not report results from it.`, 'run: canary setup --yes (rewrites it as this machine\'s own)'); return 2; }
  const problems = readOnlyProblems(root, cfg, false); // state only: no commands, no liveness spawn
  const cp = parseJsonOrNull(path.join(root, CONFIG_DIR, CHECKPOINT_FILE));
  const task = readTaskRecord(root);
  o.context({
    checks: protocolChecks(cfg),
    security: securityCapability(),
    agent: agentCapability(root),
    // The full record (bundles, checkpoints, claims) lives here; the envelope
    // names it instead of pasting it, so an agent's context stays small.
    evidencePath: path.join(root, CONFIG_DIR),
    ...(task ? { next: `task registered: ${task.kinds.join('+')} (${task.requirementCount} requirement(s))` } : {}),
  });
  o.say(`repo: ${root}`);
  o.say(`checks: ${cfg.plan.map((s) => `${s.kind}:${s.script}`).join(', ')}`);
  o.say(`last checkpoint: ${cp ? `${cp.status} (${cp.source}) at ${cp.at}` : 'none — no completion has been checked here yet'}`);
  if (problems.length) {
    o.context({ problems });
    o.verdict('NEEDS ATTENTION', 'a recorded result cannot be treated as current: the wiring is not sound here.', 'run: canary setup --yes');
    for (const p of problems) o.say(`  - ${p}`);
    return 2;
  }
  o.verdict('CONNECTED',
    cp ? `last recorded completion: ${cp.status} (${cp.source}) at ${cp.at} — a past run, not a claim about now`
      : 'no completion has been checked here yet — the wiring is sound, but nothing has been proven',
    'to check the code now: canary doctor');
  return 0;
}

/**
 * 1.1 §18–21 — `canary agents`: which agents work here, what each can ACTUALLY
 * do, and install/uninstall of the ADVISORY integration where no hook can gate.
 *
 * This command exists because "we support your agent" is the kind of sentence
 * that hides a lie. Every integration is listed with its real capability: GATED
 * means a completion can be blocked; ADVISORY means the agent is told and may
 * ignore it. Nothing here pretends to gate, and nothing is installed unless the
 * user asks for it by name.
 */
export function cmdAgents(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'agents' });
  const pos = rest.filter((a) => !a.startsWith('--'));
  const mode = pos[0] === 'install' || pos[0] === 'uninstall' ? pos[0] : null;
  const id = mode ? pos[1] : undefined;
  const dirToken = mode ? pos[2] : pos[0];
  const root = findRepoRoot(dirToken ?? process.cwd());
  if (!root) { o.verdict('NOT CONNECTED', 'not inside a git repository — there is no project to integrate an agent with.', 'cd into your project, then: canary setup --yes'); return 2; }
  o.context({ root });

  const found = new Set(detectHarnesses(root).found.map((h) => h.name));
  const advisory = hasAdvisory(root);
  const integrations: ProtocolIntegration[] = AGENT_INTEGRATIONS.map((a) => ({
    id: a.id,
    label: a.label,
    gating: a.gating,
    ...(a.gatingMeasured === undefined ? {} : { gatingMeasured: a.gatingMeasured }),
    detected: a.id === 'generic' ? true : found.has(a.id),
    ...(a.gating || a.gatingMeasured === false ? {} : { advisoryInstalled: advisory }),
    summary: a.summary,
  }));
  o.context({ integrations, agent: agentCapability(root) });

  if (mode !== null) {
    const advisoryIds = AGENT_INTEGRATIONS.filter((a) => !a.gating).map((a) => a.id).join(', ');
    if (id === undefined) { o.verdict('NEEDS ATTENTION', `agents ${mode} needs an integration id.`, `advisory integrations: ${advisoryIds} (example: canary agents ${mode} codex)`); return 2; }
    const integration = AGENT_INTEGRATIONS.find((a) => a.id === id);
    if (!integration) { o.verdict('NEEDS ATTENTION', `"${id}" is not an agent integration Canary knows.`, `known: ${AGENT_INTEGRATIONS.map((a) => a.id).join(', ')}`); return 2; }
    if (integration.gating) { o.verdict('NEEDS ATTENTION', `${integration.label} is a GATING integration — it is installed by setup, not by an advisory command, so its hook keeps one owner.`, 'run: canary setup --yes'); return 2; }
    const res = mode === 'install' ? installAdvisory(root) : removeAdvisory(root);
    if (!res.ok) { o.verdict('NEEDS ATTENTION', res.problem, 'fix that file, then re-run'); return 2; }
    o.verdict('CONNECTED',
      res.changed
        ? `advisory integration ${mode === 'install' ? 'installed' : 'removed'} in ${rel(root, res.file)} — it tells the agent to consult Canary before claiming completion, and it is ADVISORY: it cannot block anything.`
        : `nothing changed — the advisory block was already ${mode === 'install' ? 'present' : 'absent'} in ${rel(root, res.file)}.`,
      mode === 'install' ? 'to confirm the checks run: canary doctor' : 'to reinstall: canary agents install codex');
    return 0;
  }

  o.say(`repo: ${root}`);
  o.say('agent integrations (GATED = can block a completion; ADVISORY = the agent is told and may ignore it):');
  // v1.3, slice 1: "detected" answers "is this agent here?", which is NOT a protection claim. A GATED
  // integration is only protection once its hook is actually installed in THIS repository, so the row
  // says which of the two it is and the verdict below is decided by wiring, not by presence.
  const wired = gatingHookInstalled(root);
  // v1.3 §C: whether the agent can also ASK is a separate, useful fact on the "am I protected?"
  // command. Reported from the same signature-matched evidence the rest of Canary uses.
  const cfgForTools = readConfig(root);
  const toolsRegistered = cfgForTools !== null && cfgForTools !== 'corrupt'
    && (() => {
      const doc = parseJsonOrNull(mcpConfigPath(root));
      return doc !== null && hasMcpEntry(doc, new Set(cfgForTools.mcpArgSignatures ?? []));
    })();
  for (const i of integrations) {
    // v1.3 §E: three states, not two. GATED (a hook is installed and can block), UNMEASURED (the
    // harness documents a mechanism this project has not reproduced — claimed as neither), ADVISORY
    // (the agent is told and may ignore it).
    const unmeasured = i.gatingMeasured === false;
    const word = i.gating ? 'GATED   ' : unmeasured ? 'UNMEASURED' : 'ADVISORY';
    const extra = i.gating
      ? ` [${wired ? 'hook installed here' : 'hook NOT installed here'}${wired && toolsRegistered ? ', agent tools registered' : ''}]`
      : unmeasured
        ? ` [Canary's completion hook is ${wired ? 'installed here' : 'NOT installed here'} — whether this harness honours it is UNMEASURED]`
        : ` [AGENTS.md block ${advisory ? 'installed' : 'not installed'}]`;
    o.say(`  ${word} ${i.label} — ${i.detected ? 'detected' : 'not detected'}${extra}`);
    o.detail(i.summary);
  }
  const gated = integrations.filter((i) => i.gating && i.detected);
  if (gated.length === 0) {
    const unmeasured = integrations.filter((i) => i.gatingMeasured === false && i.detected);
    o.verdict('NEEDS ATTENTION',
      unmeasured.length > 0
        ? `${unmeasured.map((i) => i.label).join(', ')} is installed here and documents a completion-hook mechanism Canary has NOT measured — so nothing here can be reported as gated. Detecting an agent is not protecting the repository.`
        : 'no agent here can be GATED today — a completion can be checked, but nothing can block it.',
      'any agent can use the protocol directly: canary result --json');
    return 2;
  }
  if (!wired) {
    o.verdict('NEEDS ATTENTION',
      `${gated.map((i) => i.label).join(', ')} is installed here, but Canary's completion hook is NOT — nothing runs automatically, so nothing can block a completion. Detecting the agent is not protecting the repository.`,
      'to install the hook: canary setup --yes');
    return 2;
  }
  // v1.3 §E: the tools are registered but the harness holds them at its own consent gate. Saying so
  // is the difference between a user who approves once and a user who concludes the tools are broken.
  if (toolsRegistered) {
    o.say('note: Claude Code holds a project MCP server at "pending approval" until you approve it once in an interactive session — the entry is written; the tools appear after you approve.');
  }
  o.verdict('CONNECTED', `${gated.map((i) => i.label).join(', ')} can gate completions here — the hook is installed in this repository.`, 'to confirm end to end: canary doctor');
  return 0;
}
