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

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The absolute path of the built CLI entry — what harness hooks invoke. */
export const CLI_ENTRY = path.join(HERE, 'main.js');

const CONFIG_DIR = '.canary';
const CONFIG_FILE = 'canary.local.json';
const CHECKPOINT_FILE = 'last-checkpoint.json';
const EVIDENCE_DIR = 'evidence';
const CLAIMS_FILE = path.join('claims', 'latest.json');
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
  /** M4 baseline: repo identity stamped by Canary at setup time — "state when
   *  Canary was wired". Optional: configs written before M4 have no provable
   *  baseline, and bundles say `baseline: null` rather than invent one. */
  baseline?: BaselineStamp;
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
 *  evidence bundle never upgrades an unknown candidate into a known one. */
export function candidateIdentity(root: string): Identity {
  const gitOut = (args: string[]): string | null => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000 });
    return r.status === 0 ? r.stdout : null;
  };
  const head = gitOut(['rev-parse', 'HEAD']);
  const tree = gitOut(['rev-parse', 'HEAD^{tree}']);
  const status = gitOut(['status', '--porcelain']);
  return {
    resolved: head !== null && head.trim().length > 0,
    head: head?.trim() ?? null,
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

/**
 * Write what Canary just executed, as bytes — argv, cwd, runtime, candidate,
 * raw streams (capped files + full-byte digests), exit codes, derived
 * observation counts. BEST-EFFORT: evidence plumbing must never crash or
 * alter the harness hook, and nothing reads this back for a verdict (S4
 * doctrine extended to the whole evidence dir).
 */
function writeVerificationBundle(root: string, source: string, results: StepResult[], status: string, prov?: BundleProvenance): void {
  try {
    if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) return; // linked .canary: no writes through it (S3)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(root, CONFIG_DIR, EVIDENCE_DIR, `${stamp}-${source}`);
    if (containedRealPath(root, dir) === null) return;
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
      cwd: root, candidate: candidateIdentity(root), envOverrides: relevantEnvNames(), steps,
      // M4 provenance: WHICH plan/code/task this evidence belongs to, stamped
      // from trusted in-memory state at write time — never re-derived from
      // bytes read back off the evidence dir. null only if a caller has no
      // plan context to offer. Observation, not verdict input.
      provenance: prov ? { planDigest: prov.planDigest, baseline: prov.baseline, taskDigest: prov.taskDigest ?? null } : null,
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
    const parent = path.join(root, CONFIG_DIR, EVIDENCE_DIR);
    const mine = fs.readdirSync(parent)
      .filter((d) => /^\d{4}-\d{2}-\d{2}T[\d-]{11,}(Z)?-(setup|doctor|checkpoint)$/.test(d))
      .sort();
    for (const d of mine.slice(0, Math.max(0, mine.length - EVIDENCE_KEEP))) {
      try { fs.rmSync(path.join(parent, d), { recursive: true, force: true }); } catch { /* churn-tolerant */ }
    }
  } catch { /* evidence is best-effort; never crash the harness hook over it */ }
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
    // M4 baseline: stamped NOW by Canary's own probes. Honest label —
    // "state when Canary was wired", not a claim about the agent's past.
    baseline: { at: new Date().toISOString(), ...candidateIdentity(root) },
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
  for (const s of cfg.plan) { const r = runPlanStep(root, cfg.pm, s); ran.push(r); o.step(r); if (!r.ok) failed.push(r); }
  writeVerificationBundle(root, 'doctor', ran, failed.length ? 'fail' : 'pass', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
  writeCheckpoint(root, failed.length ? 'fail' : 'pass', failed.map((f) => f.kind), 'doctor');
  if (failed.length) {
    o.verdict('NEEDS ATTENTION', `wiring is good, but the checks just failed (${failed.map((f) => f.kind).join(', ')}) — your code is talking, not Canary.`, 'fix the failing checks (ask the agent), then: canary doctor');
    return 2;
  }
  o.verdict('READY', 'wiring verified; the checks just ran and passed.', 'nothing to do — the agent finishes, Canary checks');
  // M3 (verbose-only — trust classes are evidence internals, not default UX):
  o.detail('trust: this READY is CANARY_OBSERVED — Canary executed the checks in this very invocation. Agent words are AGENT_REPORTED and never sufficient for a PASS; no class is promoted by copying bytes into a Canary-owned file (evidence is never read back for verdicts).');
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
