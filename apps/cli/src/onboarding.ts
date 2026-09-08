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
import { fileURLToPath } from 'node:url';

// M9 §9.5 — the quarantine marker filename. authority.ts imports only node
// builtins, so this direction adds no cycle (candidate.ts already imports it).
import { QUARANTINE_FILE } from './authority.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The absolute path of the built CLI entry — what harness hooks invoke. */
export const CLI_ENTRY = path.join(HERE, 'main.js');

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
const LOCKFILES: Array<[string, string]> = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
];
/** Script names we accept into a plan; also blocks any shell-shaped name. */
export const isSafeScriptName = (s: string): boolean => /^[A-Za-z0-9_:.-]{1,64}$/.test(s);
/** Conventional script name -> plan kind. Exact names only; conservative.
 *  M6 (spec M5) adds bench/e2e: a performance or UI task is only PROVEN if a
 *  human actually put a benchmark/e2e script in the sealed plan — detection of
 *  those names is what gives the obligation its chance to reach `met`. */
const PLAN_KINDS = ['typecheck', 'tests', 'build', 'bench', 'e2e'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
const SCRIPT_KINDS: Array<[string, PlanKind]> = [
  ['typecheck', 'typecheck'], ['type-check', 'typecheck'], ['test', 'tests'], ['build', 'build'],
  ['bench', 'bench'], ['benchmark', 'bench'], ['e2e', 'e2e'], ['test:e2e', 'e2e'],
];
const PLAN_ORDER: Record<PlanKind, number> = { typecheck: 0, tests: 1, build: 2, bench: 3, e2e: 4 };

export interface PlanStep { kind: PlanKind; script: string }
export interface TouchedFile { path: string; created: boolean }
export interface CanaryConfig {
  version: string; installedAt: string; pm: string; plan: PlanStep[];
  cliPath: string; hookCommand: string;
  /** every command string ever installed here — uninstall matches exactly these */
  hookCommands: string[];
  touched: TouchedFile[];
  /** M4 baseline: repo identity stamped by Canary at setup time — "state when
   *  Canary was wired". Optional: configs written before M4 have no provable
   *  baseline, and bundles say `baseline: null` rather than invent one. */
  baseline?: BaselineStamp;
  /** M5 trusted verification plan: the plan AND the exact script TEXTS that a
   *  human set up. Verified before every execution; drift blocks. Optional:
   *  configs written before M5 have no seal and verify exactly as before. */
  planAuthority?: PlanAuthority;
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

export function detectPm(root: string): { pm: string; note: string } {
  for (const [file, pm] of LOCKFILES) {
    if (fs.existsSync(path.join(root, file))) return { pm, note: `${file} found` };
  }
  return { pm: 'npm', note: 'no lockfile found — defaulted to npm' };
}

export function detectPlan(pkgScripts: Record<string, unknown>): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const [name, kind] of SCRIPT_KINDS) {
    if (typeof pkgScripts[name] === 'string' && isSafeScriptName(name) && pkgScripts[name].trim()) {
      if (!steps.some((s) => s.kind === kind)) steps.push({ kind, script: name });
    }
  }
  return steps.sort((a, b) => PLAN_ORDER[a.kind] - PLAN_ORDER[b.kind]);
}

/** Reconstruct argv for one step. Only validated fragments ever reach here. */
export function stepArgv(pm: string, script: string): string[] {
  if (!/^(npm|pnpm|yarn|bun)$/.test(pm) || !isSafeScriptName(script)) {
    throw new Error(`refused unsafe plan step ${JSON.stringify({ pm, script })}`);
  }
  return [pm, 'run', script];
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
  const cc = found.find((h) => h.name === 'claude-code') ?? null;
  return { found, integrable: cc };
}

function hasExe(name: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', timeout: 5000 });
  return probe.status === 0;
}

/** Build the hook command; null when the CLI path cannot be safely quoted. */
export function buildHookCommand(cliPath: string): string | null {
  if (cliPath.includes('"') || cliPath.includes('\n')) return null; // cannot embed safely
  return `node "${cliPath}" checkpoint`;
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
    && Array.isArray(c.plan) && c.plan.every((s) => s && typeof s === 'object' && isStr((s as PlanStep).kind) && isStr((s as PlanStep).script))
    && Array.isArray(c.hookCommands) && c.hookCommands.every(isStr)
    && Array.isArray(c.touched) && c.touched.every((t) => t && typeof t === 'object' && isStr((t as TouchedFile).path) && typeof (t as TouchedFile).created === 'boolean');
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
export function configTracked(root: string): boolean | null {
  const r = spawnSync('git', ['-C', root, 'ls-files', '--', `${CONFIG_DIR}/${CONFIG_FILE}`], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return null;
  return r.stdout.trim().length > 0;
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

/** null = parse failure (caller must refuse, never overwrite). */
export function parseJsonOrNull(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
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

/** Remove Canary entries from every touched settings file. Returns problems[]. */
export function uninstallHooks(root: string, cfg: CanaryConfig): { removed: number; problems: string[] } {
  const owned = new Set(cfg.hookCommands.length ? cfg.hookCommands : [cfg.hookCommand]);
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
      pruned = pruneOwned(doc, owned);
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

// ---------- execution ----------

export interface StepResult {
  kind: string; display: string; ok: boolean; exitCode: number | null; secs: number; tail: string;
  /** M2 evidence fields — recorded, never consulted for a verdict */
  argv: string[]; cwd: string; stdout: string; stderr: string;
  /** M4 provenance: wall-clock stamps around the spawn, recorded, never judged */
  startedAt: string; endedAt: string;
}

export function runPlanStep(root: string, pm: string, step: PlanStep, timeoutMs = 600_000): StepResult {
  const argv = stepArgv(pm, step.script); // throws unless [pm, 'run', script] is fully whitelisted
  const display = argv.join(' ');
  const startedAt = new Date().toISOString();
  const r = spawnSync(argv[0] as string, argv.slice(1), {
    cwd: root, encoding: 'utf8', timeout: timeoutMs,
    shell: process.platform === 'win32', // npm et al. are .cmd shims on Windows; argv is whitelisted fragments only
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const out = `${stdout}${stderr}`;
  const infra = r.error !== undefined && r.status === null;
  return {
    kind: step.kind, display, ok: !infra && r.status === 0,
    exitCode: infra ? null : r.status, secs: 0,
    tail: out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'),
    argv, cwd: root, stdout, stderr,
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
export function gitWithinRoot(root: string, args: string[]): string | null {
  const run = (a: string[]): string | null => {
    // 32MB like every other spawn here: the 1MB default would turn a large
    // repo's `ls-tree -r` (M7's submodule probe) into a spurious null.
    const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const top = run(['rev-parse', '--show-toplevel']);
  if (top === null) return null; // not a repo at all (or git refuses to run)
  const rootReal = containedRealPath(root, root);
  const topReal = top.trim() ? containedRealPath(root, top.trim()) : null;
  if (rootReal === null || topReal === null || topReal !== rootReal) return null; // answered about an ancestor, not about root
  return run(args);
}

export function candidateIdentity(root: string): Identity {
  const unidentified: Identity = { resolved: false, head: null, tree: null, dirty: null };
  const head = gitWithinRoot(root, ['rev-parse', 'HEAD']);
  if (head === null || head.trim().length === 0) return unidentified;
  const tree = gitWithinRoot(root, ['rev-parse', 'HEAD^{tree}']);
  const status = gitWithinRoot(root, ['status', '--porcelain']);
  return {
    resolved: true,
    head: head.trim(),
    tree: tree?.trim() ?? null,
    dirty: status === null ? null : status.trim().length > 0,
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

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

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
/** sha256 over the canonical plan ([{kind,script}] in order). The per-step
 *  executed argv is recorded separately; this binds WHICH plan was in force. */
export function planDigest(plan: PlanStep[]): string {
  return sha256(JSON.stringify(plan.map((s) => ({ kind: s.kind, script: s.script }))));
}

/** Bundle provenance, computed by the CALLER from trusted state (config) or
 *  observation — never from file content read back off the evidence dir. */
export interface BundleProvenance {
  planDigest: string;
  baseline: BaselineStamp | null;
  /** digest of the optional task string a hook sent; raw prose is never stored */
  taskDigest?: string;
}

// ---------- M5 trusted verification plan ----------
/**
 * The worker must not redefine success after implementing its solution. The
 * plan and the script TEXTS a human approved at setup are TRUSTED authority;
 * the candidate controls only the implementation. This seal catches the
 * subtle attack the exit-code oracle cannot: `"test": "vitest"` swapped for
 * `"test": "echo all good"` still exits 0 — a "pass" of a hollowed-out check
 * certifies nothing. So the seal is verified BEFORE anything executes, and a
 * drifted command is never run as proof at all.
 *
 * Detected here (mid-task drift against the setup-time seal): plan edits
 * (cfg.plan — the test/build/typecheck script choice, kind relabels
 * included) and package-script TEXT edits. NOT claimed: any seal over the
 * tool config files a sealed command reads (vitest.config.ts, tsconfig …) —
 * editing those is the same attack class arriving through an UNSEALED door,
 * and working-tree visibility is the detection path M7 builds on; overclaim
 * it not. Containment of an agent that re-runs setup itself is likewise not
 * claimed — re-sealing is a visible act that re-smokes the new command — and
 * honest containment of candidate edits to Canary's own protected files
 * (.canary state, hooks) is M7's protected-surface work. Per-test-name
 * inventory drift (427→426) is out of scope too: M4's observedCounts record
 * the raw material; no seal over test names exists yet. A config with no
 * seal (pre-M5) verifies exactly as before — additive, and `canary setup`
 * is what creates the authority.
 */
export interface PlanAuthority {
  /** when a human ran setup and this seal was captured */
  at: string;
  planDigest: string;
  /** sha256 of the exact package.json script text, keyed by script name */
  scriptDigests: Record<string, string>;
}

/** Capture the authority a human just approved: the plan plus the verbatim
 *  text of every script it references. detectPlan guarantees plan scripts
 *  exist as non-empty strings in pkgScripts; anything else is left unsealed
 *  and the drift check fails closed on it. */
export function sealPlanAuthority(plan: PlanStep[], pkgScripts: Record<string, unknown>): PlanAuthority {
  const scriptDigests: Record<string, string> = {};
  for (const s of plan) {
    const t = pkgScripts[s.script];
    if (typeof t === 'string') scriptDigests[s.script] = sha256(t);
  }
  return { at: new Date().toISOString(), planDigest: planDigest(plan), scriptDigests };
}

/** How the current repo state deviates from the sealed verification authority
 *  — a human-readable sentence (script names sanitized; no candidate-controlled
 *  prose can ride the message), or null when there is no drift (or no seal). */
export function planAuthorityDrift(root: string, cfg: CanaryConfig): string | null {
  const seal = cfg.planAuthority;
  if (seal === undefined) return null; // pre-M5 config: nothing sealed, nothing to drift from
  if (typeof seal !== 'object' || seal === null
    || typeof seal.at !== 'string' || !/^[0-9a-f]{64}$/.test(String(seal.planDigest))
    || typeof seal.scriptDigests !== 'object' || seal.scriptDigests === null || Array.isArray(seal.scriptDigests)
    || !Object.values(seal.scriptDigests).every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))) {
    return 'the sealed verification authority in .canary/canary.local.json is malformed (hand-edited?)';
  }
  const drift: string[] = [];
  if (planDigest(cfg.plan) !== seal.planDigest) drift.push('the plan no longer matches the sealed plan');
  const pkg = parseJsonOrNull(path.join(root, 'package.json'));
  const scripts = pkg ? (pkg.scripts ?? {}) as Record<string, unknown> : null;
  if (scripts === null && cfg.plan.length > 0) drift.push('package.json cannot be read to compare the sealed scripts');
  for (const s of cfg.plan) {
    const name = isSafeScriptName(s.script) ? s.script : '<odd plan entry>'; // never echo raw config text
    if (!Object.hasOwn(seal.scriptDigests, s.script)) {
      drift.push(`script "${name}" is in the plan but was never sealed`);
      continue;
    }
    if (scripts === null) continue; // unreadable pkg already reported
    const cur = scripts[s.script];
    if (typeof cur !== 'string') drift.push(`script "${name}" no longer exists in package.json`);
    else if (sha256(cur) !== seal.scriptDigests[s.script]) drift.push(`script "${name}" changed since setup sealed it`);
  }
  return drift.length ? drift.join('; ') : null;
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
export const TASK_KINDS = ['bugfix', 'refactor', 'dependency', 'performance', 'ui', 'multi'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

const KIND_PATTERNS: Array<[RegExp, TaskKind]> = [
  [/\b(bug|fix|broken|crash|regress\w*|defect)\b/i, 'bugfix'],
  [/\b(refactor\w*|restructure|extract (a |the )?(method|function|class)|clean[- ]up)\b/i, 'refactor'],
  [/\b(dependenc\w+|lockfile|upgrade .{0,20}package|bump .{0,20}version|npm (install|update|add))\b/i, 'dependency'],
  [/\b(performance|benchmark|faster|slower|latency|throughput|speed up|slow\w* down|memory usage|optimi[sz]\w+)\b/i, 'performance'],
  [/\b(ui|interface|screen|render|component|css|button|dialog|page|browser|e2e|accessibility)\b/i, 'ui'],
  [/\b(multi[- ]?part|several requirements|requirements? (below|listed|following)|each (of the )?(parts|requirements|items))\b/i, 'multi'],
];

/** Collect every kind a prose hint suggests (union — a mislabel adds work, never removes it). */
export function inferTaskKinds(text: string): TaskKind[] {
  const found = new Set<TaskKind>();
  for (const [re, kind] of KIND_PATTERNS) if (re.test(text)) found.add(kind);
  return [...found];
}

const isTestPath = (p: string): boolean =>
  /(^|[\\/])(tests?|__tests__|spec[s]?)([\\/]|$)/i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p);
// Lockfiles ONLY: package.json edits are authority moves (script text — M5's
// sealed turf), not dependency-graph evidence, and blaming them here made
// every setup-repair story trip the dep obligation. A deps bump without a
// lockfile change is still caught one-way by `canary task --kind dependency`.
const isDepPath = (p: string): boolean => {
  const base = p.split(/[\\/]/).pop() ?? '';
  return LOCKFILES.some(([f]) => base === f);
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

/** Deletion-shaped paths: plain deletes, plus renames whose NEW side is NOT a
 *  test path (git mv tests/x.test.js docs/x.md is coverage loss; a move that
 *  keeps the file under tests/ is not). Exported for contract pins (review #5). */
export const delPaths = (entries: ChangeEntry[]): string[] =>
  entries.flatMap((e) => (e.st === 'del' ? e.paths : e.st === 'ren' && !isTestPath(e.paths[1]!) ? [e.paths[0]!] : []));

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
  const setupDirtProven = cfg.baseline?.dirty === true;
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
  const blameClean = cfg.baseline !== undefined && cfg.baseline.resolved && cfg.baseline.dirty === false;
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

export interface Obligation { id: string; mode: 'objective' | 'non-objective'; status: 'met' | 'unproven' | 'unmet'; note: string }

/** The obligation engine: pure over (kinds, signals, sealed-plan kinds, requirement count).
 *  `planKinds` comes from the SEALED plan — an obligation is only satisfiable
 *  by a command a human actually approved; Canary never executes an unsealed
 *  "benchmark" just because the task mentioned one. */
export function obligationsFor(
  kinds: TaskKind[], sig: DiffSignals, planKinds: Set<string>, requirementCount: number,
): Obligation[] {
  const out: Obligation[] = [];
  const add = (o: Obligation) => { if (!out.some((x) => x.id === o.id)) out.push(o); };
  const has = (k: string) => planKinds.has(k);

  if (kinds.includes('bugfix')) {
    const testTouched = sig.changes.some(isTestPath); // deletions are coverage LOSS, never regression evidence (review #4)
    add(testTouched
      ? { id: 'regression-evidence', mode: 'objective', status: 'met', note: 'regression evidence: test files were added/modified in the candidate diff' }
      : { id: 'regression-evidence', mode: 'objective', status: 'unproven', note: 'no test file was added or changed since setup — regression evidence UNPROVEN (an old suite can stay green while the bug survives). Add a test that reproduces the fixed bug.' });
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
    const premise = sig.setupDirtProven
      ? 'the repo was already dirty at setup'
      : "Canary cannot establish the repo's state at setup";
    add({ id: 'coverage-loss-unattributable', mode: 'objective', status: 'unproven', note: `test files are missing from the working tree but ${premise}, so the deletion cannot be attributed to this session: ${formatPaths(sig.deletedTestsUnattributable)} — whether coverage was lost is UNPROVEN` });
  } else if (kinds.includes('refactor')) {
    add(sig.resolved
      ? { id: 'coverage-loss', mode: 'objective', status: 'met', note: 'no test file was deleted in the candidate diff — verification coverage intact' }
      : { id: 'coverage-loss', mode: 'objective', status: 'unproven', note: 'candidate-vs-baseline diff unresolvable — lost verification coverage cannot be ruled out (UNPROVEN)' });
  }
  if (kinds.includes('dependency') || sig.depTouched) {
    add({ id: 'dependency-change', mode: 'non-objective', status: 'unproven', note: sig.resolved
      ? 'dependency change observed: the sealed plan re-ran against the new graph, but downstream behavior needs a trusted baseline/candidate comparison (or an acceptance criterion) — UNPROVEN'
      : 'dependency change observed against an unresolvable baseline — comparison UNPROVEN' });
  }
  if (kinds.includes('performance')) {
    add(has('bench')
      ? { id: 'performance-proof', mode: 'objective', status: 'met', note: 'the sealed benchmark ran and passed (its exit code is the threshold a human approved)' }
      : { id: 'performance-proof', mode: 'non-objective', status: 'unproven', note: 'a performance obligation needs a repeatable benchmark with a defined threshold; the sealed plan has none — UNPROVEN. A human can add a bench script and re-run: canary setup (seals + smokes it)' });
  }
  if (kinds.includes('ui')) {
    add(has('e2e')
      ? { id: 'ui-proof', mode: 'objective', status: 'met', note: 'the sealed e2e/browser proof ran and passed' }
      : { id: 'ui-proof', mode: 'non-objective', status: 'unproven', note: 'no browser/e2e/accessibility proof is available in the sealed plan — UI behavior UNPROVEN (visual truth is not pretend-deterministic)' });
  }
  if (kinds.includes('multi') || requirementCount > 0) {
    add({ id: 'per-requirement', mode: 'non-objective', status: 'unproven', note: requirementCount > 0
      ? `multi-part task: ${requirementCount} registered requirement(s) — a green plan proves the plan, NOT each part; requirements without their own check remain UNPROVEN`
      : 'multi-part task detected but requirements were never enumerated — ask the human ONCE which parts must be proven separately, or register them: canary task "..." --requirement "..." per part' });
  }
  return out;
}

/** Read the agent's registered task hint (AGENT_REPORTED — same zero-authority
 *  posture as claims). Anything malformed collapses to no-kind/no-count, which
 *  is exactly the pre-M6 posture: diff-implied obligations still apply. */
function readTaskRecord(root: string): { kinds: TaskKind[]; requirementCount: number } | null {
  try {
    const p = path.join(root, CONFIG_DIR, TASK_FILE);
    if (containedRealPath(root, p) === null) return null;
    if (!fs.existsSync(p)) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return null;
    const kinds = Array.isArray(v.kinds) ? v.kinds.filter((k): k is TaskKind => (TASK_KINDS as readonly string[]).includes(String(k))) : [];
    const rc = typeof v.requirementCount === 'number' && Number.isInteger(v.requirementCount) && v.requirementCount >= 0 && v.requirementCount <= 64
      ? v.requirementCount : 0;
    return { kinds: [...new Set(kinds)], requirementCount: rc };
  } catch { return null; }
}

/**
 * M6 task-intake: the worker registers what it was ASKED for so Canary can
 * derive that kind's proof obligations. The registration itself carries ZERO
 * authority (AGENT_REPORTED, like `canary claim`): it can only ever ADD
 * obligations — the sealed plan stays the floor no declaration lifts.
 */
export function cmdTask(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no project here to attach a task to.', 'cd into your project and try again'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Canary's local config is unreadable — it will not attach a task to state it cannot read.", 'run: canary setup'); return 2; }
  if (!cfg) { o.verdict('NEEDS ATTENTION', 'Canary is not set up in this repo, so there is no verification record to attach a task to.', 'run: canary setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Canary will not record a task against a config it does not trust (${distrust}).`, "run: canary setup --yes (rewrites it as this machine's own)"); return 2; }
  let kindFlag: string | null = null;
  const prose: string[] = [];
  let requirementCount = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--kind' && rest[i + 1] && !rest[i + 1]!.startsWith('--')) { kindFlag = rest[++i]!; continue; }
    if (a.startsWith('--kind=')) { kindFlag = a.slice(7); continue; }
    if (a === '--requirement' && rest[i + 1] && !rest[i + 1]!.startsWith('--')) { requirementCount++; i++; continue; }
    if (a.startsWith('--')) continue;
    prose.push(a);
  }
  const text = prose.join(' ').trim();
  if (!text && kindFlag === null && requirementCount === 0) { o.say('usage: canary task "<intent>" [--kind bugfix|refactor|dependency|performance|ui|multi] [--requirement "<part>"]…'); return 3; }
  let kinds: TaskKind[];
  if (kindFlag !== null) {
    if (!(TASK_KINDS as readonly string[]).includes(kindFlag)) { o.verdict('NEEDS ATTENTION', `unknown task kind "${kindFlag.slice(0, 40)}" — one of: ${TASK_KINDS.join(', ')}.`, 're-run with --kind <one of those>, or omit --kind and let Canary infer'); return 3; }
    kinds = [kindFlag as TaskKind];
  } else kinds = inferTaskKinds(text);
  if (requirementCount > 0 && !kinds.includes('multi')) kinds.push('multi');
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
      schema: 'canary-task/1', at: new Date().toISOString(),
      // M3/M4 doctrine: prose is digested, never stored — the record cannot become a smuggling channel for agent text
      taskDigest: text ? sha256(text.slice(0, 4000)) : null,
      kinds, requirementCount,
      trustClass: 'AGENT_REPORTED',
      authority: 'ZERO — registering a task can only ADD proof obligations; the sealed plan is the floor no declaration lifts',
    }, null, 2) + '\n');
  } catch (e) {
    o.verdict('NEEDS ATTENTION', `could not record the task (${String(e).slice(0, 140)}).`, 'fix the file/permission, then re-run'); return 2;
  }
  o.say(`task registered: ${kinds.length ? kinds.join(' + ') : 'no kind inferred'}${requirementCount ? ` (${requirementCount} requirement(s))` : ''}.`);
  o.say('this is an AGENT_REPORTED hint with zero authority — the next checkpoint proves the sealed plan PLUS this task\'s obligations; nothing here weakens either.');
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
  'canaryEntry', 'runtime', 'cwd', 'candidate', 'envOverrides', 'steps', 'provenance']);

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
      cwd: subjectRoot, candidate: candidateIdentity(subjectRoot), envOverrides: relevantEnvNames(), steps,
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
  constructor(private verbose: boolean) {}
  say(s = '') { console.log(s); }
  detail(s: string) { if (this.verbose) console.log(`   ${s}`); }
  step(r: StepResult) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.kind}: ${r.display}${r.exitCode === null ? ' (could not run)' : ` (exit ${r.exitCode})`}`);
    if (!r.ok && r.tail) console.log(r.tail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
  verdict(v: 'READY' | 'NEEDS ATTENTION' | 'UNSUPPORTED', why: string, next?: string) {
    console.log('');
    console.log(v === 'READY' ? `READY — ${why}` : `${v} — ${why}`);
    if (next) console.log(`next: ${next}`);
  }
}

export interface GlobalOpts { verbose: boolean; yes: boolean }
export function parseGlobals(args: string[]): { opts: GlobalOpts; rest: string[] } {
  const opts: GlobalOpts = { verbose: args.includes('--verbose') || !!process.env.CANARY_VERBOSE, yes: args.includes('--yes') };
  return { opts, rest: args.filter((a) => a !== '--verbose' && a !== '--yes') };
}
/** The directory argument = first non-flag token, anywhere in the args. Never mistake --run for a path. */
export function dirArg(rest: string[]): string | undefined { return rest.find((a) => !a.startsWith('--')); }

// ---------- commands ----------

export async function cmdSetup(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  const pkgFile = root ? path.join(root, 'package.json') : null;
  if (!root) { o.verdict('UNSUPPORTED', 'this folder is not inside a git repository.', 'cd into your project and try again'); return 2; }
  if (!pkgFile || !fs.existsSync(pkgFile)) {
    o.verdict('UNSUPPORTED', `${root} is a git repo but has no package.json — Canary's zero-config path supports Node-style projects today.`, 'add a package.json (or tell us your stack) and re-run'); return 2;
  }
  const pkg = parseJsonOrNull(pkgFile);
  if (!pkg) { o.verdict('UNSUPPORTED', 'package.json is not valid JSON — Canary cannot read your project.', 'fix package.json, then run setup again'); return 2; }

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

  const { pm, note } = detectPm(root);
  const plan = detectPlan((pkg.scripts ?? {}) as Record<string, unknown>);
  o.say(`repo: ${root}`);
  o.say(`package manager: ${pm} (${note})`);
  if (!plan.length) {
    o.verdict('NEEDS ATTENTION', 'found no test/build/typecheck script Canary recognizes (looking for "test", "typecheck", "type-check", "build").', 'add one of those scripts to package.json, then run setup again'); return 2;
  }
  o.say('verification plan (from your package.json scripts — Canary only runs scripts you already have; change them there):');
  for (const s of plan) o.say(`  ✓ ${s.kind}: ${pm} run ${s.script}`);

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
  // M4 baseline: stamped NOW by Canary's own probes. Honest label — "state when
  // Canary was wired", not a claim about the agent's past. `dirty` measures
  // WORKER residue, so the one file Canary itself just wrote (its managed
  // settings entry) is excluded from THIS stamp: setup's own wiring must not
  // permanently blind the repo to blame for later uncommitted deletions — M6
  // attribution relies on a clean baseline actually being reachable. candidate-
  // Identity itself stays untouched (M4-pinned semantics for bundles).
  const baselineId = candidateIdentity(root);
  const ownSettings = rel(root, settingsPath(root)).split(path.sep).join('/');
  const baselineStatus = gitWithinRoot(root, ['status', '--porcelain', '--', '.', `:(exclude)${ownSettings}`]);
  const cfg: CanaryConfig = {
    version: 'product-0.1', installedAt: new Date().toISOString(), pm, plan,
    baseline: {
      at: new Date().toISOString(), ...baselineId,
      dirty: baselineStatus === null ? baselineId.dirty : baselineStatus.trim().length > 0,
    },
    // M5: whatever plan and script texts are on disk RIGHT NOW are what the
    // human running setup just approved — they become the sealed authority.
    planAuthority: sealPlanAuthority(plan, (pkg.scripts ?? {}) as Record<string, unknown>),
    cliPath: CLI_ENTRY, hookCommand,
    hookCommands: [...new Set([hookCommand, ...priorCommands])],
    touched: [res.touched!],
  };
  try {
    writeConfig(root, cfg);
  } catch (e) {
    // the hook entry is installed but WITHOUT config the checkpoint stays
    // silent — this project would be wired yet unprotected. Say it plainly.
    o.verdict('NEEDS ATTENTION', `could not write the .canary config (${String(e).slice(0, 140)}) — the hook entry is installed, but Canary cannot verify anything here without its config. Nothing was half-written.`, 'close whatever holds the file, then run setup again');
    return 2;
  }
  // M9 §9.5 — the human running setup IS the clearing act. A caught in-window
  // tampering quarantines the base (verify/promote refuse until re-seal); a
  // fresh writeConfig + re-installed hook means a human re-authorized these
  // bytes, so the marker's debt is paid. Cleared only on success: if the
  // config write threw above, quarantine stands (fail-closed).
  try { fs.rmSync(path.join(root, CONFIG_DIR, QUARANTINE_FILE), { force: true }); } catch { /* absent is the common case */ }
  o.say(`Claude Code will run Canary automatically when the agent finishes a turn here.${prev && prev !== 'corrupt' ? ' (re-run: existing Canary hook refreshed, no duplicates)' : ''}`);
  o.detail('authority sealed: the plan and the exact text of every script it runs — candidate edits to the verification surface block completion until a human re-runs setup.');

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
    o.verdict('NEEDS ATTENTION', 'Canary is installed here but the smoke test could not run unattended — nothing was executed, so nothing is proven yet.', 'run: canary setup --yes'); return 2;
  }
  o.say('\nsmoke test (running your own project scripts):');
  let allOk = true;
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  for (const s of plan) {
    const r = runPlanStep(root, pm, s);
    ran.push(r);
    o.step(r);
    if (!r.ok) { allOk = false; failed.push(r); }
  }
  writeVerificationBundle(root, 'setup', ran, allOk ? 'pass' : 'fail', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
  writeCheckpoint(root, allOk ? 'pass' : 'fail', failed.map((f) => f.kind), 'setup');
  if (allOk) {
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

export function cmdDoctor(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository.', 'cd into your project'); return 2; }
  if (!fs.existsSync(path.join(root, 'package.json'))) { o.verdict('UNSUPPORTED', 'this project has no package.json — the zero-config path supports Node projects today.', ''); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Canary's local config (.canary/canary.local.json) is unreadable.", 'run: canary setup (rewrites it; your other settings are untouched)'); return 2; }
  if (!cfg) { o.verdict('NEEDS ATTENTION', 'Canary is NOT fully active yet — this repo was never set up.', 'run: canary setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Canary found a local config it does not trust (${distrust}) — it will not run plans from it.`, 'run: canary setup --yes (rewrites it as this machine\'s own)'); return 2; }

  const problems: string[] = [];
  if (!Array.isArray(cfg.plan) || cfg.plan.length === 0) problems.push('the verification plan is empty — Canary would have nothing to check (a pass here would be fake)');
  if (!/^(npm|pnpm|yarn|bun)$/.test(cfg.pm) || spawnSync(cfg.pm, ['--version'], { encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' }).status !== 0) {
    problems.push(`package manager "${cfg.pm}" is not runnable on this machine`);
  }
  let pkg: Record<string, unknown> | null = {};
  try { pkg = parseJsonOrNull(path.join(root, 'package.json')); } catch { pkg = null; }
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  for (const s of cfg.plan) {
    if (!scripts[s.script]) problems.push(`plan references script "${s.script}" which no longer exists in package.json`);
  }
  // M5: a sealed authority that drifted is a problem REGARDLESS of whether the
  // current commands pass — doctor must not certify READY on proof it never sealed.
  const drift = planAuthorityDrift(root, cfg);
  if (drift) problems.push(`verification authority changed since setup — ${drift}; restore the sealed checks, or re-run setup to re-seal deliberately`);
  if (!fs.existsSync(cfg.cliPath)) problems.push('the Canary command files moved or were removed — reinstall, then re-run setup');
  for (const t of cfg.touched) {
    if (!fs.existsSync(t.path)) { problems.push(`${rel(root, t.path)} is missing — the harness hook is NOT registered, so nothing runs automatically`); continue; }
    const doc = parseJsonOrNull(t.path);
    if (!doc) { problems.push(`${rel(root, t.path)} is not valid JSON — fix it`); continue; }
    if (!hasCanaryEntry(doc, new Set(cfg.hookCommands))) {
      problems.push(`Canary's hook is no longer registered in ${rel(root, t.path)} — nothing will run automatically; re-run: canary setup`);
    }
  }
  if (problems.length) {
    o.verdict('NEEDS ATTENTION', 'Canary is NOT fully active here:', '');
    for (const p of problems) console.log(`  - ${p}`);
    console.log('next: canary setup --yes repairs the above without touching your other settings');
    return 2;
  }
  // READY is earned HERE, now — the plan runs in every doctor invocation, so a
  // hand-written or stale checkpoint can never produce READY on its own (S4).
  // --run is accepted but no longer changes behavior.
  o.say('running the verification plan:');
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  const refused: string[] = [];
  for (const s of cfg.plan) {
    let r: StepResult;
    try { r = runPlanStep(root, cfg.pm, s); }
    catch (e) { refused.push(`plan step "${s.script}" refused: ${(e as Error).message}`); continue; }
    ran.push(r); o.step(r); if (!r.ok) failed.push(r);
  }
  if (refused.length) {
    // a script name Canary will not execute is a config problem, not a test
    // result — honest NEEDS ATTENTION, no checkpoint, no fake run.
    writeVerificationBundle(root, 'doctor', ran, 'blocked', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
    o.verdict('NEEDS ATTENTION', 'the config names a script Canary will not execute — doctor cannot certify this plan:', '');
    for (const p of refused) console.log(`  - ${p}`);
    console.log('next: canary setup --yes reseals from the package.json scripts');
    return 2;
  }
  writeVerificationBundle(root, 'doctor', ran, failed.length ? 'fail' : 'pass', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
  writeCheckpoint(root, failed.length ? 'fail' : 'pass', failed.map((f) => f.kind), 'doctor');
  if (failed.length) {
    o.verdict('NEEDS ATTENTION', `wiring is good, but the checks just failed (${failed.map((f) => f.kind).join(', ')}) — your code is talking, not Canary.`, 'fix the failing checks (ask the agent), then: canary doctor');
    return 2;
  }
  // M6: the same obligation read a checkpoint makes, for humans (no hook stdin
  // here, so only the registered task hint participates; unattributable states
  // say UNPROVEN rather than pretending to a verdict).
  const task = readTaskRecord(root);
  const obligations = obligationsFor(task?.kinds ?? [], collectDiffSignals(root, cfg), new Set(cfg.plan.map((s) => s.kind)), task?.requirementCount ?? 0);
  const unmet = obligations.filter((x) => x.status === 'unmet');
  const unproven = obligations.filter((x) => x.status === 'unproven');
  if (unmet.length > 0) {
    o.verdict('NEEDS ATTENTION', `the sealed checks pass, but a proof obligation is objectively violated — ${unmet.map((x) => x.note).join('; ')}`, 'restore the deleted verification files (git checkout -- <path>) — or a human reviews this deletion; then: canary doctor');
    return 2;
  }
  o.verdict('READY', 'wiring verified; the checks just ran and passed.', 'nothing to do — the agent finishes, Canary checks');
  if (unproven.length > 0) o.say(`proof obligations open: ${unproven.length} UNPROVEN — the plan passing does not make the task proven (NO PROOF, NO DONE).`);
  for (const ob of obligations) o.detail(`obligation [${ob.id}] ${ob.status.toUpperCase()} (${ob.mode}): ${ob.note}`);
  // M3 (verbose-only — trust classes are evidence internals, not default UX):
  o.detail('trust: this READY is CANARY_OBSERVED — Canary executed the checks in this very invocation. Agent words are AGENT_REPORTED and never sufficient for a PASS; no class is promoted by copying bytes into a Canary-owned file (evidence is never read back for verdicts).');
  if (cfg.planAuthority) o.detail('authority: every command that just ran is one setup sealed — script-text drift is blocked before execution, not excused after it passes.');
  return 0;
}

export function cmdUninstall(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
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
  const drift = planAuthorityDrift(root, cfg);
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
    const obligations = obligationsFor(kinds, collectDiffSignals(root, cfg), new Set(cfg.plan.map((s) => s.kind)), task?.requirementCount ?? 0);
    const unmet = obligations.filter((x) => x.status === 'unmet');
    const unproven = obligations.filter((x) => x.status === 'unproven');
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
      return emit({ systemMessage: `Canary: the sealed checks passed — but not every proof obligation for this task is closed: ${unproven.map((x) => x.note).join(' ')}`.slice(0, 2000) });
    }
    return 0; // silent even if an agent claim contradicts — claims never BLOCK, and never CREATE a pass
  }
  writeVerificationBundle(root, 'checkpoint', ran, 'fail', prov);
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
  const reason = `${claimNote}Canary verification failed: ${failed.map((f) => `${f.kind} (${f.display}${f.exitCode === null ? ', could not run' : `, exit ${f.exitCode}`})`).join('; ')}. Fix this before finishing. Last output:\n${failed.map((f) => f.tail).join('\n---\n').slice(0, 4000)}`;
  return emit({ decision: 'block', reason });
}

/**
 * M2 claim intake: the agent records what it BELIEVED happened. The claim is
 * stored as an untrusted hint next to Canary's own evidence and can never
 * create, block, or modify a verdict — only annotate a block Canary decided
 * from checks it executed itself. (Tests passing != task proven complete;
 * agent-reported != canary-observed.)
 */
export function cmdClaim(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
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
