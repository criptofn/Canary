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
 *  - uninstall keeps .canary (its ownership record) until cleanup fully
 *    succeeded, so the advertised "re-run uninstall" can actually work
 *    (post-review S6).
 *  - Exit codes (same doctrine as main.ts): 0 READY/success, 2 NEEDS
 *    ATTENTION / UNSUPPORTED / execution refused, 3 misuse.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The absolute path of the built CLI entry — what harness hooks invoke. */
export const CLI_ENTRY = path.join(HERE, 'main.js');

const CONFIG_DIR = '.canary';
const CONFIG_FILE = 'canary.local.json';
const CHECKPOINT_FILE = 'last-checkpoint.json';
const LOCKFILES: Array<[string, string]> = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
];
/** Script names we accept into a plan; also blocks any shell-shaped name. */
export const isSafeScriptName = (s: string): boolean => /^[A-Za-z0-9_:.-]{1,64}$/.test(s);
/** Conventional script name -> plan kind. Exact names only; conservative. */
const SCRIPT_KINDS: Array<[string, 'typecheck' | 'tests' | 'build']> = [
  ['typecheck', 'typecheck'], ['type-check', 'typecheck'], ['test', 'tests'], ['build', 'build'],
];
const PLAN_ORDER = { typecheck: 0, tests: 1, build: 2 } as const;

export interface PlanStep { kind: 'typecheck' | 'tests' | 'build'; script: string }
export interface TouchedFile { path: string; created: boolean }
export interface CanaryConfig {
  version: string; installedAt: string; pm: string; plan: PlanStep[];
  cliPath: string; hookCommand: string;
  /** every command string ever installed here — uninstall matches exactly these */
  hookCommands: string[];
  touched: TouchedFile[];
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
function writeFileAtomic(p: string, data: string): void {
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
function parseJsonOrNull(file: string): Record<string, unknown> | null {
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

export interface StepResult { kind: string; display: string; ok: boolean; exitCode: number | null; secs: number; tail: string }

export function runPlanStep(root: string, pm: string, step: PlanStep, timeoutMs = 600_000): StepResult {
  const argv = stepArgv(pm, step.script); // throws unless [pm, 'run', script] is fully whitelisted
  const display = argv.join(' ');
  const r = spawnSync(argv[0] as string, argv.slice(1), {
    cwd: root, encoding: 'utf8', timeout: timeoutMs,
    shell: process.platform === 'win32', // npm et al. are .cmd shims on Windows; argv is whitelisted fragments only
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const infra = r.error !== undefined && r.status === null;
  return {
    kind: step.kind, display, ok: !infra && r.status === 0,
    exitCode: infra ? null : r.status, secs: 0,
    tail: out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'),
  };
}

function rel(root: string, p: string): string { return path.relative(root, p) || '.'; }

// ---------- friendly output ----------

class Out {
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

  const res = installStopHook(root, hookCommand, priorCommands, backupsDir);
  if (!res.ok) { o.verdict('NEEDS ATTENTION', `could not configure Claude Code safely: ${res.problem}`, 'fix that file, then run setup again'); return 2; }
  const cfg: CanaryConfig = {
    version: 'product-0.1', installedAt: new Date().toISOString(), pm, plan,
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
  o.say(`Claude Code will run Canary automatically when the agent finishes a turn here.${prev && prev !== 'corrupt' ? ' (re-run: existing Canary hook refreshed, no duplicates)' : ''}`);

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
  for (const s of plan) {
    const r = runPlanStep(root, pm, s);
    o.step(r);
    if (!r.ok) { allOk = false; failed.push(r); }
  }
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
  for (const s of cfg.plan) { const r = runPlanStep(root, cfg.pm, s); o.step(r); if (!r.ok) failed.push(r); }
  writeCheckpoint(root, failed.length ? 'fail' : 'pass', failed.map((f) => f.kind), 'doctor');
  if (failed.length) {
    o.verdict('NEEDS ATTENTION', `wiring is good, but the checks just failed (${failed.map((f) => f.kind).join(', ')}) — your code is talking, not Canary.`, 'fix the failing checks (ask the agent), then: canary doctor');
    return 2;
  }
  o.verdict('READY', 'wiring verified; the checks just ran and passed.', 'nothing to do — the agent finishes, Canary checks');
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
  const { removed, problems } = uninstallHooks(root, cfg);
  if (problems.length) {
    // keep .canary: it is the ownership record the advertised retry needs (S6)
    o.verdict('NEEDS ATTENTION', `Canary removed ${removed} of its hook entries but ${problems.length} file(s) could not be cleaned completely; its ownership record (.canary) is kept so a retry can finish the job:`, 'fix the listed files, then re-run: canary uninstall is safe to repeat');
    for (const p of problems) console.log(`  - ${p}`);
    return 2;
  }
  if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) {
    o.verdict('NEEDS ATTENTION', '.canary resolves outside the repository (a link?) — Canary will not delete through it.', 'replace it with a real folder, then re-run: canary uninstall'); return 2;
  }
  fs.rmSync(path.join(root, CONFIG_DIR), { recursive: true, force: true });
  o.say(`removed ${removed} Canary hook entr${removed === 1 ? 'y' : 'ies'}; every other settings entry was kept (content preserved — re-serialization may reformat whitespace).`);
  o.verdict('READY', 'Canary is fully removed from this repo.', 'to bring it back: canary setup');
  return 0;
}

/**
 * Harness entry point (Claude Code Stop hook). Contract:
 *  - stdin: hook JSON {cwd?, stop_hook_active?}; stdout JSON decisions; exit 0.
 *  - all checks pass => silence (human is NOT interrupted when nothing is needed)
 *  - a check fails   => {"decision":"block", reason} => agent gets one repair turn
 *  - infra failure / unconfigured / loop guard => allow + honest systemMessage, never a fake green
 *  - corrupt local config => loud honest UNVERIFIED (GLM F-1) — absence is silent,
 *    damaged authority is NOT
 */
export async function cmdCheckpoint(): Promise<number> {
  let input: { cwd?: string; stop_hook_active?: boolean } = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) as typeof input; } catch { /* interactive invocation or empty stdin */ }
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

  const failed: StepResult[] = [];
  let infra = '';
  for (const s of cfg.plan) {
    let r: StepResult;
    try { r = runPlanStep(root, cfg.pm, s); } catch (e) { infra = String(e); break; }
    if (!r.ok) failed.push(r);
  }
  if (infra) {
    writeCheckpoint(root, 'infra', failed.map((f) => f.kind), 'checkpoint');
    return emit({ systemMessage: `Canary could not run the checks (${infra.slice(0, 160)}) — this completion is UNVERIFIED, not a pass.` });
  }
  if (failed.length === 0) { writeCheckpoint(root, 'pass', [], 'checkpoint'); return 0; }
  writeCheckpoint(root, 'fail', failed.map((f) => f.kind), 'checkpoint');
  if (input.stop_hook_active === true) {
    // already one repair attempt this turn — never loop the agent; surface honestly instead
    return emit({ systemMessage: `Canary: checks still failing (${failed.map((f) => f.kind).join(', ')}) after one repair attempt — stopping anyway; a human should look.` });
  }
  const reason = `Canary verification failed: ${failed.map((f) => `${f.kind} (${f.display}${f.exitCode === null ? ', could not run' : `, exit ${f.exitCode}`})`).join('; ')}. Fix this before finishing. Last output:\n${failed.map((f) => f.tail).join('\n---\n').slice(0, 4000)}`;
  return emit({ decision: 'block', reason });
}
