/**
 * M7 — UNTRUSTED CANDIDATE ISOLATION (git worktrees). Directive §7.
 *
 * The accepted tree is the TRUSTED BASE. A worker never edits it directly:
 * `canary isolate <name>` opens a detached `git worktree` checkout of the
 * base's resolved commit, the worker works there, and Canary verifies the
 * candidate from OUTSIDE it against the BASE's sealed authority. A PASS makes
 * the candidate ELIGIBLE for promotion — promotion is a separate act (M8);
 * nothing here ever applies anything, and a FAIL leaves the base untouched.
 *
 * Which guarantee lives where (the probe proves each end to end on real git):
 *   1  accepted work never edited by the worker — the worktree is the only
 *      writable place; the base is touched solely by git worktree plumbing,
 *      the registry record under .canary, and evidence bundles.
 *   2  candidate identity explicit — every bundle carries candidateIdentity
 *      (head/tree/dirty) of the candidate, plus candidateName/candidateRoot.
 *   3  baseline identity explicit — the record and bundle stamp baseRef/
 *      baseHead/baseTree from the live `git rev-parse` at isolation time.
 *   4/5 cannot impersonate / cannot inherit a parent repo — verification binds
 *      rec.root to this base by git-common-dir equality, and every git probe
 *      runs through gitWithinRoot (a parent never answers for a root).
 *   6  verifier authority outside candidate control — plan + seal are read
 *      from the BASE's config; drift is checked against the candidate's
 *      package.json BEFORE anything executes, so the candidate cannot redefine
 *      the check it is being given. pre/post lifecycle hooks around a sealed
 *      step and a candidate-side .npmrc are refused for the same reason: the
 *      seal covers only the listed script texts, and both execute outside
 *      them (npm/pnpm run hooks automatically; flags rewrite what runs).
 *   7  authoritative evidence outside candidate-writable scope — bundles land
 *      under the BASE's .canary/evidence, never inside the candidate tree.
 *   8  FAIL leaves the trusted base untouched — proven byte-for-byte in the
 *      probe (base `git status --porcelain` identical after a failing verify).
 *   9/10 unrelated work never overwritten; dirty/ambiguous bases handled
 *      honestly — refuse-on-collision everywhere, and a dirty base isolates
 *      with an explicit note that uncommitted work is NOT in the candidate.
 *   11/15 cleanup is safe and never a destructive auto-reset — remove demands
 *      a valid record, refuses a dirty candidate without --discard, and never
 *      touches an unregistered path.
 *   12/13 worktrees/submodules/spaces/Unicode — worktree plumbing is spawned
 *      as argv arrays (no shell), names and --path accept spaces and Unicode;
 *      submodules are NOT initialized (the plan would half-verify silently),
 *      so a candidate whose COMMITTED tree carries a gitlink (ls-tree mode
 *      160000) is refused at verify — renaming or deleting .gitmodules cannot
 *      hide the committed half-empty checkout from the tree itself.
 *   14 interrupted sessions recover honestly — list derives status live from
 *      git probes (LOST / IMPOSTOR / ADVANCED / DIRTY / UNREGISTERED) and
 *      repairs nothing silently; bundles are never read back for verdicts.
 *
 * ponytail — known ceilings, stated not hidden: same-UID processes can write
 * anywhere; this layout stops the ACCIDENTAL and the git-scoped edit, not a
 * determined local attacker (M4's "no key exists" honesty applies here too).
 * gitignored deps and .canary state do not ride the checkout. A candidate at
 * the DEFAULT path sits under the base, so module resolution walks up into
 * the BASE's node_modules — a pass there can mix base deps with candidate
 * code; a --path elsewhere inherits that location's own ancestors instead.
 * The verdict binds code identity, not the dependency tree (stated, not
 * fixed — a fake-green claim would be worse). Other tool configs beyond
 * .npmrc (jest/babel resolution) ride the tree the same way.
 * Gate order is message honesty: LOST before IMPOSTOR before tree probes — a
 * genuinely missing tree must not be reported as an impostor. An unsafe plan
 * script name throws before any spawn; verify catches it and blocks with a
 * bundle (ERROR exit 3 would never fake a PASS, but it wrote no evidence).
 * Each verify writes >=1 bundle, blocked attempts included; the global
 * EVIDENCE_KEEP cap is unchanged from pre-M7; bundles are never read back.
 * Obligation evaluation for the candidate diff compares against rec.baseHead
 * and lands with M10; conflating cfg.baseline here would blame the base's
 * own post-setup commits on the worker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CONFIG_DIR, Out, candidateIdentity, containedRealPath, ensureCanarySelfIgnore,
  findRepoRoot, gitWithinRoot, parseGlobals, parseJsonOrNull, planAuthorityDrift, planDigest, readConfig,
  runPlanStep, untrustedConfigReason, writeFileAtomic, writeVerificationBundle,
  type CanaryConfig, type StepResult,
} from './onboarding.js';

const CANDIDATES_SUBDIR = 'candidates';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // registry keys are filenames
const HEX_RE = /^[0-9a-f]{40,64}$/;

interface CandidateRecord {
  schema: 'canary-candidate/1';
  name: string;
  root: string;
  baseRoot: string;
  baseRef: string;
  baseHead: string;
  baseTree: string | null;
  createdAt: string;
}

const recordPath = (root: string, name: string) => path.join(root, CONFIG_DIR, CANDIDATES_SUBDIR, `${name}.json`);
const short = (sha: string | null) => (sha ? sha.slice(0, 12) : '<unresolved>');
const echoable = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 64); // log hygiene only — baseRef is a human CLI arg

function samePath(a: string, b: string): boolean {
  let x = path.resolve(a); let y = path.resolve(b);
  if (process.platform === 'win32') { x = x.toLowerCase(); y = y.toLowerCase(); }
  return x === y;
}

/** realpath'd git-common-dir of a repo ROOT, or null if any step fails. A
 *  linked worktree's is the main repo's .git — so base and candidate agree
 *  only when the candidate genuinely belongs to the base's object store. */
function commonDir(root: string): string | null {
  const out = gitWithinRoot(root, ['rev-parse', '--git-common-dir']);
  if (out === null) return null;
  const cd = out.trim();
  if (!cd) return null;
  try { return fs.realpathSync(path.isAbsolute(cd) ? cd : path.resolve(root, cd)); } catch { return null; }
}

/** Registry reads are untrusted bytes until shape-proved (M4 discipline). */
function loadRecord(root: string, name: string): CandidateRecord | 'missing' | 'invalid' {
  const p = recordPath(root, name);
  if (containedRealPath(root, p) === null) return 'invalid';
  if (!fs.existsSync(p)) return 'missing';
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<CandidateRecord> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'invalid';
    if (v.schema !== 'canary-candidate/1' || v.name !== name || !NAME_RE.test(name)) return 'invalid';
    if (typeof v.root !== 'string' || !path.isAbsolute(v.root)) return 'invalid';
    if (typeof v.baseRoot !== 'string' || !path.isAbsolute(v.baseRoot)) return 'invalid';
    if (typeof v.baseRef !== 'string' || !v.baseRef || v.baseRef.length > 200) return 'invalid';
    if (typeof v.baseHead !== 'string' || !HEX_RE.test(v.baseHead)) return 'invalid';
    if (!(v.baseTree === null || (typeof v.baseTree === 'string' && HEX_RE.test(v.baseTree)))) return 'invalid';
    if (typeof v.createdAt !== 'string' || Number.isNaN(Date.parse(v.createdAt))) return 'invalid';
    return v as CandidateRecord;
  } catch { return 'invalid'; }
}

/** Every mode runs from a repo Canary can trust as the base: a git root with
 *  a readable, non-distrusted local config (the sealed authority source). */
function trustedBase(startDir: string, o: Out): { root: string; cfg: CanaryConfig } | number {
  const root = findRepoRoot(startDir);
  if (root === null) { o.say('isolate: not inside a git repository — run from the trusted base (or pass its path)'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.say(`isolate: ${root}: local config is unreadable — nothing will be executed or removed based on it. Run: canary doctor`); return 2; }
  if (!cfg) { o.say(`isolate: ${root} has no .canary config — the trusted base must be a repo Canary verifies. Run: canary setup`); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.say(`isolate: refusing — local config is not trusted (${distrust}). Run: canary setup --yes`); return 2; }
  return { root, cfg };
}

// ---------- modes ----------

function isolateCreate(root: string, cfg: CanaryConfig, o: Out, name: string, baseRef: string, customPath: string | null): number {
  const existing = loadRecord(root, name);
  if (existing === 'invalid') { o.say(`isolate: a malformed record "${name}" blocks registration — Canary cannot tell what it points at; delete .canary/${CANDIDATES_SUBDIR}/${name}.json manually, then re-isolate`); return 2; }
  if (existing !== 'missing') { o.say(`isolate: candidate "${name}" is already registered — pick another name, or --remove it first`); return 2; }
  const target = customPath ? path.resolve(root, customPath) : path.join(root, CONFIG_DIR, CANDIDATES_SUBDIR, name);
  if (fs.existsSync(target)) { o.say(`isolate: candidate path already exists: ${target} — nothing was created`); return 2; }
  const id = candidateIdentity(root);
  if (!id.resolved) { o.say('isolate: the trusted base identity is unresolvable (broken .git?) — cannot isolate from it'); return 2; }
  // fail-closed ref resolution: rev-parse --verify answers with exactly one
  // commit or nothing; --end-of-options stops ref-looking-like-a-flag games.
  const shaOut = gitWithinRoot(root, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
  if (shaOut === null || !HEX_RE.test(shaOut.trim())) { o.say(`isolate: base ref "${echoable(baseRef)}" does not resolve to exactly one commit here`); return 2; }
  const sha = shaOut.trim();
  const treeOut = gitWithinRoot(root, ['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`]);
  const baseTree = treeOut !== null && HEX_RE.test(treeOut.trim()) ? treeOut.trim() : null;
  if (id.dirty) o.say('note: the base tree is dirty — the candidate checks out the COMMITTED base; uncommitted work is not in it');
  // worktree add via argv (no shell): spaces and Unicode paths are plain data.
  const add = spawnSync('git', ['-C', root, 'worktree', 'add', '--detach', target, sha],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (add.status !== 0) {
    o.say(`isolate: git worktree add failed — nothing was registered:`);
    for (const l of (add.stderr || add.stdout || String(add.error?.message ?? '')).trim().split(/\r?\n/).slice(-4)) o.say(`  ${l}`);
    return 2;
  }
  // post-check: what git checked out must BE the resolved commit, or the
  // attempt is rolled back — a half-created candidate is worse than none.
  const cid = candidateIdentity(target);
  if (!cid.resolved || cid.head !== sha) {
    const rb = spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', target], { encoding: 'utf8', timeout: 120_000 });
    spawnSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf8', timeout: 60_000 });
    o.say(rb.status === 0
      ? 'isolate: the worktree does not match the resolved commit — attempt rolled back'
      : `isolate: the worktree does not match the resolved commit AND could not be auto-removed — nothing was registered; remove it manually: git -C "${root}" worktree remove --force "${target}"`);
    return 2;
  }
  const rp = recordPath(root, name);
  if (containedRealPath(root, rp) === null) { o.say('isolate: the candidate registry path escapes the repo (linked .canary?) — refusing to register; remove the worktree manually'); return 2; }
  const rec: CandidateRecord = {
    schema: 'canary-candidate/1', name, root: target, baseRoot: root,
    baseRef, baseHead: sha, baseTree, createdAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(rp), { recursive: true }); // --path elsewhere never created it
    ensureCanarySelfIgnore(root); // registry dirs must never dirty the user repo
    writeFileAtomic(rp, JSON.stringify(rec, null, 2) + '\n');
  }
  catch (e) { o.say(`isolate: could not write the registry record (${(e as Error).message}) — the worktree exists but is NOT registered; remove it: git -C "${root}" worktree remove --force "${target}"`); return 2; }
  o.say(`isolated "${name}" at ${target}`);
  o.say(`  from ${baseRef} @ ${short(sha)}${baseTree ? ` (tree ${short(baseTree)})` : ''}`);
  o.say(`  worker: edit ONLY that directory. verifier: canary isolate --verify ${name}`);
  return 0;
}

function isolateVerify(root: string, cfg: CanaryConfig, o: Out, name: string): number {
  const rec = loadRecord(root, name);
  if (rec === 'missing') { o.say(`isolate: no candidate "${name}" registered here — see: canary isolate --list`); return 2; }
  if (rec === 'invalid') { o.say(`isolate: registry record "${name}" is malformed (hand-edited?) — refusing to verify from it; fix or remove .canary/${CANDIDATES_SUBDIR}/${name}.json`); return 2; }
  if (!samePath(rec.baseRoot, root)) { o.say(`isolate: record "${name}" claims a different base (${echoable(path.basename(rec.baseRoot))}) — refusing (impersonation guard)`); return 2; }
  const prov = { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null };
  const extra = {
    candidateName: rec.name, candidateRoot: rec.root,
    isolatedFrom: { ref: rec.baseRef, head: rec.baseHead, tree: rec.baseTree, at: rec.createdAt },
  };
  const blocked = (why: string, next?: string): number => {
    // the BLOCK itself is evidence, written under the base's authority dir.
    writeVerificationBundle(root, 'candidate', [], 'blocked', prov, { evidenceRoot: root, subjectRoot: rec.root, extra });
    o.say(`BLOCKED — ${why}`);
    if (next) o.say(`next: ${next}`);
    return 2;
  };
  const cid = candidateIdentity(rec.root);
  if (!cid.resolved) return blocked(`candidate "${name}" is not a resolvable git tree at ${rec.root} (moved? deleted? corrupted?) — nothing ran`, 'canary isolate --list, then --remove + re-isolate');
  const baseCd = commonDir(root); const candCd = commonDir(rec.root);
  if (baseCd === null || candCd === null || !samePath(baseCd, candCd)) {
    return blocked(`the tree at ${rec.root} does not share this repo's git store — it is not the candidate Canary isolated here`, 'restore the worktree or re-isolate under a new name');
  }
  // COMMITTED tree, not the working .gitmodules: a gitlink (mode 160000)
  // checks out an empty dir — the plan would pass over half the code. The
  // ls-tree answer comes from the candidate's own HEAD inside its store.
  const treeProbe = gitWithinRoot(rec.root, ['ls-tree', '-r', 'HEAD']);
  if (treeProbe === null) return blocked("the candidate's committed tree cannot be inspected — submodule presence is unknowable, and Canary does not guess", 'restore the worktree or re-isolate');
  if (/^160000/m.test(treeProbe)) {
    return blocked('the candidate tracks git submodules and Canary does not initialize them — the plan would half-verify silently', 'verify a submodule repo manually or flatten it into the base (a human decision)');
  }
  if (!Array.isArray(cfg.plan) || cfg.plan.length === 0) {
    return blocked('the base\'s verification plan is empty — a pass here would certify nothing', 'configure a real plan via canary setup');
  }
  // guarantee 6, BEFORE execution: the human-sealed authority must hold over
  // the candidate's package.json — the candidate cannot redefine its test.
  const drift = planAuthorityDrift(rec.root, cfg);
  if (drift) return blocked(`sealed verification authority drifted before anything ran: ${drift}`, `restore package.json in the candidate to the sealed text (git -C "${rec.root}" checkout -- package.json), or a HUMAN re-runs canary setup`);
  // The seal covers only the listed scripts' texts. pre/post hooks around a
  // sealed step run automatically under the same command, and a candidate
  // .npmrc rewrites what the package manager fetches and executes — both are
  // worker-defined execution outside the seal, refused HERE (candidate-only:
  // a base that ships pretest was human-approved at setup).
  const pkg = parseJsonOrNull(path.join(rec.root, 'package.json'));
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null && !Array.isArray(pkg.scripts) ? pkg.scripts as Record<string, unknown> : null;
  if (scripts) for (const s of cfg.plan) {
    if (Object.hasOwn(scripts, `pre${s.script}`) || Object.hasOwn(scripts, `post${s.script}`)) {
      return blocked(`the candidate defines a lifecycle hook around sealed step "${s.script}" (pre${s.script}/post${s.script}) — the package manager runs it automatically and the seal does not cover it`, `remove the pre${s.script}/post${s.script} entry from the candidate's package.json`);
    }
  }
  if (fs.existsSync(path.join(rec.root, '.npmrc'))) {
    const baseNpmrc = gitWithinRoot(rec.root, ['show', `${rec.baseHead}:.npmrc`]);
    if (baseNpmrc === null) return blocked('.npmrc exists in the candidate but not in the isolated base — npm/pnpm flags rewrite what the sealed steps execute', 'delete the candidate-side .npmrc (if the BASE needs one, that is a setup-time human decision)');
    const changed = gitWithinRoot(rec.root, ['diff', '--name-only', '--end-of-options', rec.baseHead, '--', '.npmrc']);
    if (changed === null) return blocked('.npmrc cannot be compared against the isolated base — Canary does not guess past a flag-bearing config file', 'restore the worktree or re-isolate');
    if (changed.trim() !== '') return blocked('.npmrc changed in the candidate vs the isolated base — npm/pnpm flags there rewrite what the sealed steps execute', `git -C "${rec.root}" checkout -- .npmrc`);
  }
  let results: StepResult[];
  try { results = cfg.plan.map((step) => runPlanStep(rec.root, cfg.pm, step)); }
  catch (e) { return blocked(`plan step refused: ${(e as Error).message} — execution stopped before any step ran`, 'the base plan names a script Canary will not execute; fix the plan via canary setup'); }
  for (const r of results) o.step(r);
  const failed = results.filter((r) => !r.ok);
  const status = failed.length ? 'fail' : 'pass';
  writeVerificationBundle(root, 'candidate', results, status, prov, { evidenceRoot: root, subjectRoot: rec.root, extra });
  if (cid.dirty) o.detail('candidate working tree is dirty — verification ran on the checked-out files, not a committed state');
  if (failed.length) {
    o.say(`CANDIDATE FAIL — ${failed.length}/${results.length} step(s) not green; the trusted base was not touched. Evidence: ${path.join(root, CONFIG_DIR, 'evidence')}`);
    return 2;
  }
  const cnt = gitWithinRoot(rec.root, ['rev-list', '--count', '--end-of-options', `${rec.baseHead}..HEAD`]);
  const advanced = cnt !== null && /^\d+$/.test(cnt.trim()) && Number(cnt) > 0 ? ` (${cnt.trim()} commit(s) beyond the isolated base)` : '';
  o.say(`CANDIDATE PASS — "${name}" @ ${short(cid.head)}${advanced} verified against the sealed plan. ELIGIBLE for promotion — nothing applied; promotion is a separate act.`);
  return 0;
}

function isolateList(root: string, o: Out): number {
  const dir = path.join(root, CONFIG_DIR, CANDIDATES_SUBDIR);
  let files: string[] = [];
  if (fs.existsSync(dir)) {
    if (containedRealPath(root, dir) === null) { o.say('isolate: the candidate registry dir escapes the repo (linked .canary?) — refusing to read through it'); return 2; }
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  }
  const baseCd = commonDir(root);
  const known: string[] = [root];
  if (!files.length) o.say('no candidates registered');
  for (const f of files.sort()) {
    const name = f.slice(0, -'.json'.length);
    if (!NAME_RE.test(name)) { o.say(`${echoable(name)}  INVALID name (left alone)`); continue; }
    const rec = loadRecord(root, name);
    if (rec === 'invalid' || rec === 'missing') { o.say(`${name.padEnd(16)} INVALID   unusable record (left alone)`); continue; }
    known.push(rec.root);
    const cid = candidateIdentity(rec.root);
    const cd = cid.resolved ? commonDir(rec.root) : null;
    const impostor = cid.resolved && (baseCd === null || cd === null || !samePath(baseCd, cd));
    const status = !cid.resolved ? 'LOST' : impostor ? 'IMPOSTOR' : cid.dirty ? 'DIRTY' : cid.head !== rec.baseHead ? 'ADVANCED' : 'CLEAN';
    o.say(`${name.padEnd(16)} ${status.padEnd(9)} ${short(cid.head)}  ${rec.root}`);
  }
  // worktrees git knows about that Canary never registered: report only —
  // they may be the user's own work and are never touched (guarantee 9).
  // core.quotepath=false: C-quoting would print Unicode worktree paths as
  // "…\303\251…" and defeat the samePath comparison below.
  const por = gitWithinRoot(root, ['-c', 'core.quotepath=false', 'worktree', 'list', '--porcelain']);
  if (por) for (const line of por.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    const p = line.slice('worktree '.length).trim();
    if (!p || known.some((k) => samePath(k, p))) continue;
    o.say(`UNREGISTERED     ${short(null)}  ${p} (not Canary's; left alone)`);
  }
  return 0;
}

function isolateRemove(root: string, o: Out, name: string, discard: boolean): number {
  const rec = loadRecord(root, name);
  if (rec === 'missing') { o.say(`isolate: no candidate "${name}" registered — nothing removed`); return 2; }
  if (rec === 'invalid') { o.say(`isolate: registry record "${name}" is malformed — Canary cannot tell which worktree is its own, so it removes nothing; delete the record and prune manually`); return 2; }
  if (!samePath(rec.baseRoot, root)) { o.say(`isolate: record "${name}" claims a different base — refusing to remove from here`); return 2; }
  const id = candidateIdentity(rec.root);
  if (id.resolved && id.dirty && !discard) {
    o.say(`isolate: candidate "${name}" has uncommitted work — nothing removed. Commit it inside the candidate, or pass --discard to throw it away`);
    return 2;
  }
  const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000 });
  let pruned: boolean | null = null;
  if (id.resolved) {
    // rec.root is shape-validated absolute (loadRecord), so it can never
    // parse as a flag — and `worktree remove` does not document
    // --end-of-options; relying on lenient parsing would be luck, not plumbing.
    const rm = git(['worktree', 'remove', ...(discard ? ['--force'] : []), rec.root]);
    if (rm.status !== 0) {
      o.say(`isolate: git worktree remove failed — the record stays so this can be retried:`);
      for (const l of (rm.stderr || rm.stdout || String(rm.error?.message ?? '')).trim().split(/\r?\n/).slice(-4)) o.say(`  ${l}`);
      return 2;
    }
  } else {
    pruned = git(['worktree', 'prune']).status === 0; // stale registration: directory gone; let git forget it too
  }
  try { fs.rmSync(recordPath(root, name), { force: true }); }
  catch (e) { o.say(`isolate: worktree gone but the record could not be deleted (${(e as Error).message})`); return 2; }
  o.say(`REMOVED "${name}"${id.resolved ? '' : pruned ? ' (pruned stale registration)' : ' (record removed; git worktree prune FAILED — run it manually)'} — ${rec.root}`);
  return 0;
}

// ---------- entry ----------

export function cmdIsolate(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
  const usage = 'usage: canary isolate <name> [--base <ref>] [--path <dir>] [repo-path] | --list | --verify <name> | --remove <name> [--discard]';
  const misuse = (why: string): number => { o.say(`isolate: ${why}`); o.say(usage); return 3; };
  let mode: 'create' | 'list' | 'verify' | 'remove' | null = null;
  let arg = ''; let baseRef = 'HEAD'; let baseGiven = false; let pathGiven = false;
  let customPath: string | null = null; let discard = false;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--list') { if (mode) return misuse('one mode at a time'); mode = 'list'; }
    else if (a === '--verify' || a === '--remove') {
      if (mode) return misuse('one mode at a time');
      mode = a.slice(2) as 'verify' | 'remove';
      arg = rest[++i] ?? '';
      if (!arg) return misuse(`${a} needs a candidate name`);
    } else if (a === '--base') { baseGiven = true; baseRef = rest[++i] ?? ''; if (!baseRef) return misuse('--base needs a ref'); if (baseRef.length > 200) return misuse('--base ref is too long (the record caps baseRef at 200 chars)'); }
    else if (a === '--path') { pathGiven = true; customPath = rest[++i] ?? null; if (!customPath) return misuse('--path needs a directory'); }
    else if (a === '--discard') discard = true;
    else if (a.startsWith('--')) return misuse(`unknown flag ${echoable(a)}`);
    else pos.push(a);
  }
  if (!mode) {
    if (pos.length === 0) return misuse('a candidate name or a mode is required');
    mode = 'create'; arg = pos.shift()!;
  }
  if (mode !== 'create' && (baseGiven || pathGiven)) return misuse('--base/--path apply to isolation (create) only');
  if (mode === 'create' && discard) return misuse('--discard applies to --remove only');
  // (create's name comes from pos, verify/remove's from their flag — both already non-empty; only list carries none)
  if (mode !== 'list' && !NAME_RE.test(arg)) return misuse(`candidate name must match ${NAME_RE} (no path separators, no leading punctuation)`);
  // CON.json etc. would register and then be undeletable through the device
  // namespace on Windows — reject the stem at the CLI (records elsewhere stay
  // valid so Linux-authored registries keep working here and vice versa).
  if (process.platform === 'win32' && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(arg)) return misuse(`candidate name "${arg}" is a reserved Windows device name — pick another`);
  if (pos.length > 1) return misuse('at most one repo path');
  const base = trustedBase(pos[0] ?? process.cwd(), o);
  if (typeof base === 'number') return base;
  const { root, cfg } = base;
  if (mode === 'create') return isolateCreate(root, cfg, o, arg, baseRef, customPath);
  if (mode === 'verify') return isolateVerify(root, cfg, o, arg);
  if (mode === 'remove') return isolateRemove(root, o, arg, discard);
  return isolateList(root, o);
}
