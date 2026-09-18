/**
 * M7 — UNTRUSTED CANDIDATE ISOLATION (git worktrees). Directive §7.
 *
 * The accepted tree is the TRUSTED BASE. A worker never edits it directly:
 * `canary isolate <name>` opens a detached `git worktree` checkout of the
 * base's resolved commit, the worker works there, and Canary verifies the
 * candidate from OUTSIDE it against the BASE's sealed authority. A PASS makes
 * the candidate ELIGIBLE for promotion — promotion is a separate act
 * (`--promote`, implemented in this file under M8); verify itself never
 * applies anything, and a FAIL leaves the base untouched.
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
 * M9 detects (and fails closed on) in-window authority writes; a
 * change-and-revert strictly between the two fingerprint reads stays as
 * invisible as it was under M8's identity sandwich — same thread, same limit.
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
 * Each verify attempts a best-effort bundle, blocked attempts included; the global
 * EVIDENCE_KEEP cap is unchanged from pre-M7; bundles are never read back.
 *
 * M10 — proof obligations and trusted intent at the candidate boundary
 * (directive §10 + §11), both riding the gates above:
 *   - the ladder: after the plan runs green and the M9 sandwich is clean, the
 *     obligation engine judges the CANDIDATE diff (baseHead from the record —
 *     conflating cfg.baseline would blame the base's post-setup commits on the
 *     worker; the worktree started provably clean at isolation, so every
 *     deletion is attributable). Any UNMET → blocked bundle (steps included),
 *     any UNPROVEN → 'unproven' bundle + CANDIDATE NOT PROVEN — exit 2 and a
 *     null startHead, so M8 gate 1 can never launder a green-plan-unproven
 *     run into an apply. PASS only when every obligation is MET; FAIL bundles
 *     carry the obligation read as M11's repair fuel.
 *   - the intent guard: isolateCreate freezes { plan, script digests, task }
 *     into the record; before anything runs, verify refuses a candidate whose
 *     authority was weakened after isolation (dropped step, re-sealed text,
 *     shrunk task) with a blocked bundle carrying intentEvent. Increases are
 *     always allowed. Grudgeless like the pre-gate (the snapshot is frozen at
 *     record-write and the record is fingerprinted — no laundering vector).
 *
 * M9 — authority self-protection (directive §9: the candidate must never
 * control its verifier). The plan runs candidate-authored script text, so
 * in-window writes to authority are the attack — fingerprinted at both edges
 * of the execution window: BASE bytes (.canary config, harness settings, this
 * candidate's registry record, the task intent, the CLI entry), the WHOLE
 * evidence store as a tree (closing M8's "plan step can write the base
 * evidence dir" residual), the VERIFIER'S OWN CODE TREE (dist/src — the judge
 * cannot be swapped to run mutated logic next time), and the base's HEAD REF
 * as a state token (refs are shared with worktrees; a moved base ref must
 * never read to gate 6 as a past apply). The candidate-side seal checks
 * (plan-text, lifecycle hooks, .npmrc) run at BOTH edges too: npm re-reads
 * package.json per spawn, so step 1 rewriting step 2's sealed text executes
 * unsealed words INSIDE the window without touching a single fingerprinted
 * base byte. Measured fact (tooling/probes/m9-lock-facts.mjs): this runtime
 * offers no mandatory locks — so M9 claims NO prevention and enforces
 * DETECTION AT BOTH EDGES, fail-closed: any drift forces CANARY BLOCKED
 * COMPLETION (the PASS path is structurally never reached), a pre-execution
 * containment gate catches a harness entry stripped BEFORE the window, and
 * every event lands in a blocked bundle with both state tokens. A
 * during/after-execution mandate additionally STAMPS A QUARANTINE marker:
 * verify and promote then refuse the base outright until a HUMAN re-runs
 * setup (the re-seal is the clearing act) — otherwise the same byte-
 * idempotent mutation re-baselines clean in the next window and launders a
 * PASS over tampered authority. The pre-gate stays grudgeless (restore =
 * recovery, proven in the probe).
 *
 * M8 — promotion (NO PASS, NO APPLY; the apply act lives in isolatePromote):
 * a PASS only makes a candidate ELIGIBLE; `--promote` re-verifies LIVE
 * against the sealed plan and is the sole authority — stored bundles are
 * never read back, so old or forged evidence cannot authorize anything. The
 * act moves the base ONLY by `git merge --ff-only` onto the exact verified
 * commit, sandwiched by identity checks, and post-proves the applied tree
 * byte-for-byte. ponytail ceiling, stated not hidden: an edit-then-revert
 * strictly inside one plan run cannot be seen by a same-thread sandwich; the
 * fresh bundle's own step outputs are the human-visible record (M19/persist).
 */
import fs from 'node:fs';
import path from 'node:path';
import { controllerExecution } from './provider/execution.js';
import { digest, canonicalTask, taskWeakening, subjectDigest, type TaskIdentity, type AuthorizationSubject } from './authorization.js';

import {
  ACCEPTANCE_SUBDIR, CLI_ENTRY, CONFIG_DIR, ENV_POLICY, EVIDENCE_DIR, Out, candidateDiffSignals, candidateIdentity, containedRealPath, configPath, ensureCanarySelfIgnore,
  discriminationObligation, execDigest, findRepoRoot, gitCommand, gitExe, gitWithinRoot, hasCanaryEntry, obligationsFor, parseGlobals, parseJsonOrNull, planAuthorityDrift, planDigest, readAcceptance, readConfig,
  readTaskRecord, runPlanStep, settingsPath, TASK_FILE, untrustedConfigReason, writeAcceptance, writeFileAtomic, writeVerificationBundle,
  type AcceptanceRecord, type CanaryConfig, type GitResult, type PlanStep, type StepResult, type TaskKind,
} from './onboarding.js';
import { authorityDrift, quarantineInfo, QUARANTINE_FILE, shortState, snapshotAuthority, snapshotTree, stampQuarantine, treeDrift, type AuthorityChange } from './authority.js';
import {
  brokerRoutingRequired, refusalText,
  reservePromotionThroughBroker, submitAcceptanceThroughBroker,
} from './provider/routing.js';
import { projectIdForRoot, storeFromEnv } from './trust-store.js';

const CANDIDATES_SUBDIR = 'candidates';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // registry keys are filenames
const HEX_RE = /^[0-9a-f]{40,64}$/;

/**
 * M10 (directive §11) — the verification intent FROZEN at isolation: which
 * plan steps and which sealed script texts the candidate was opened against,
 * plus the registered task's shape. The snapshot is the ONLY place task
 * AUTHORITY can come from (M10.2, after the GLM re-audit of M10.1): a record
 * with no `intent` — whether it predates M10 or the field was deleted — is
 * NOT legacy-compatible-PASS material, it has no frozen authority and
 * verifies NOT PROVEN until re-isolated. The snapshot also exists so
 * authority weakened AFTER isolation cannot launder an old candidate: the
 * worker may add proof obligations, never silently shrink them. It is frozen
 * at record-write (never re-baselined at window edges). Trust boundary,
 * stated precisely: the record is inside M9's fingerprint set for the
 * DURATION of a verification window — in-window tamper is detected and
 * quarantined — but between windows this file is agent-writable bytes, so
 * its SHAPE (present/absent, edited) is never trusted as evidence of
 * anything; only the fact that a FRESH isolation wrote it counts.
 */
interface CandidateIntent {
  at: string;
  plan: PlanStep[];
  /** planAuthority.scriptDigests at isolation, or null (pre-M5 config) */
  seal: Record<string, string> | null;
  task: TaskIdentity | null;
  proofBindings?: Record<string, string>;
}

interface CandidateRecord {
  schema: 'canary-candidate/1';
  name: string;
  root: string;
  baseRoot: string;
  baseRef: string;
  baseHead: string;
  baseTree: string | null;
  createdAt: string;
  intent?: CandidateIntent;
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

/** F4: the base's HEAD as a sandwich token. Refs are SHARED with every
 *  worktree, so a sealed step CAN move the base branch out from under
 *  promotion — gate 6's idempotent arm must never read an attacker-moved ref
 *  as proof of a past apply. Non-hex (no git at all, mid-write lock file)
 *  reads UNREADABLE on both edges → a non-git root never false-blocks on a
 *  token that cannot change; a legitimate base commit INSIDE the window reads
 *  as drift → false-BLOCK, never false-PASS (same posture as a concurrent
 *  canary invocation). */
function headToken(root: string): string {
  const out = gitWithinRoot(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  const sha = out?.trim() ?? '';
  return HEX_RE.test(sha) ? sha : 'UNREADABLE';
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
    if (v.intent !== undefined) { // optional (pre-M10 records), but if present it must be shape-proved — an intent a guard cannot read is worse than no intent
      const it = v.intent as Partial<CandidateIntent> | null;
      if (!it || typeof it !== 'object' || Array.isArray(it) || typeof it.at !== 'string') return 'invalid';
      if (!Array.isArray(it.plan) || !it.plan.every((s) => !!s && typeof s === 'object' && typeof s.script === 'string' && typeof s.kind === 'string')) return 'invalid';
      if (!(it.seal === null || (it.seal && typeof it.seal === 'object' && !Array.isArray(it.seal)
        && Object.values(it.seal).every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))))) return 'invalid';
      if (it.task !== null && it.task !== undefined) {
        const t = it.task as Partial<{ kinds: unknown; requirementCount: unknown }>;
        if (!t || typeof t !== 'object' || !Array.isArray(t.kinds)
          || !t.kinds.every((k) => typeof k === 'string')
          || typeof t.requirementCount !== 'number' || !Number.isInteger(t.requirementCount) || t.requirementCount < 0) return 'invalid';
      }
    }
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
  // worktree add via argv (no shell, hardened env + trusted git binary —
  // blocker 1): spaces and Unicode paths are plain data; the caller's
  // PATH/GIT_* environment can neither pick the git nor forge its view.
  const add: GitResult = gitCommand(root, ['worktree', 'add', '--detach', target, sha], 120_000)
    ?? { status: null, stdout: '', stderr: "git is not resolvable in Canary's trusted environment" };
  if (add.status !== 0) {
    o.say(`isolate: git worktree add failed — nothing was registered:`);
    for (const l of (add.stderr || add.stdout || String(add.error?.message ?? '')).trim().split(/\r?\n/).slice(-4)) o.say(`  ${l}`);
    return 2;
  }
  // post-check: what git checked out must BE the resolved commit AND be
  // provably clean, or the attempt is rolled back — a half-created candidate
  // is worse than none. The clean assert is not ceremony: every M10
  // attribution ("every deletion here is the candidate's") rests on the
  // worktree starting at exactly baseHead, and a post-checkout hook, a weird
  // core.fileMode, or a lying index would poison that premise at birth.
  const cid = candidateIdentity(target);
  if (!cid.resolved || cid.head !== sha || cid.dirty) {
    const rb = gitCommand(root, ['worktree', 'remove', '--force', target], 120_000);
    gitCommand(root, ['worktree', 'prune'], 60_000);
    o.say(rb !== null && rb.status === 0
      ? 'isolate: the worktree does not match the resolved commit or is not provably clean — attempt rolled back'
      : `isolate: the worktree does not match the resolved commit AND could not be auto-removed — nothing was registered; remove it manually: git -C "${root}" worktree remove --force "${target}"`);
    return 2;
  }
  const rp = recordPath(root, name);
  if (containedRealPath(root, rp) === null) { o.say('isolate: the candidate registry path escapes the repo (linked .canary?) — refusing to register; remove the worktree manually'); return 2; }
  const rec: CandidateRecord = {
    schema: 'canary-candidate/1', name, root: target, baseRoot: root,
    baseRef, baseHead: sha, baseTree, createdAt: new Date().toISOString(),
    // M10 §11 — freeze the authority this candidate was opened against.
    intent: {
      at: new Date().toISOString(),
      plan: cfg.plan.map((s) => ({ kind: s.kind, script: s.script })),
      seal: cfg.planAuthority ? { ...cfg.planAuthority.scriptDigests } : null,
      task: readTaskRecord(root),
      proofBindings: { ...cfg.planAuthority?.proofBindings },
    },
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

/** Verify outcome: exit code plus the identity the verdict was earned on.
 *  M8 promotion consumes startHead/rec; verify's own caller ignores them. */
interface VerifyOutcome { code: number; startHead: string | null; rec: CandidateRecord | null }

function verifyCandidate(root: string, cfg: CanaryConfig, o: Out, name: string): VerifyOutcome {
  // F2 (quarantine) — BEFORE any record read: a tampering caught in a past
  // Canary window means the bytes this run would baseline on are exactly the
  // bytes under suspicion. The mechanical laundering vector is byte-
  // idempotence: the persisted mutation re-baselines clean in the NEXT window
  // (pre/post now read the same mutated bytes), so a second verify PASSes and
  // promotion applies over tampered authority. This refusal closes it. No
  // bundle is written here: the refusal is about the BASE's integrity, and a
  // marker the candidate can forge would make bundles a second copy anyway —
  // the marker itself is the evidence. cmdSetup clears it: a human re-seal is
  // the only act that says "these bytes are mine now."
  const q = quarantineInfo(path.join(root, CONFIG_DIR, QUARANTINE_FILE));
  if (q) {
    o.say('CANARY QUARANTINED — a verification-authority tampering was caught in an earlier Canary window.');
    o.say(`  ${typeof q === 'string' ? 'the marker is present but unreadable — fail-closed: a file Canary cannot parse still stands as a marker' : `stamped ${q.when} at ${q.at} — ${q.changes} fingerprinted change(s) recorded in the mandate bundle`}`);
    o.say('next: a HUMAN restores the authority bytes deliberately and re-runs `canary setup` — the re-seal is the clearing act. Same-UID code can delete the marker by hand; that is the byte-restore/change-and-revert ceiling, stated — what this refusal closes is the AUTOMATED re-run laundering, not a determined hand.');
    return { code: 2, startHead: null, rec: null };
  }
  const rec = loadRecord(root, name);
  if (rec === 'missing') { o.say(`isolate: no candidate "${name}" registered here — see: canary isolate --list`); return { code: 2, startHead: null, rec: null }; }
  if (rec === 'invalid') { o.say(`isolate: registry record "${name}" is malformed (hand-edited?) — refusing to verify from it; fix or remove .canary/${CANDIDATES_SUBDIR}/${name}.json`); return { code: 2, startHead: null, rec: null }; }
  if (!samePath(rec.baseRoot, root)) { o.say(`isolate: record "${name}" claims a different base (${echoable(path.basename(rec.baseRoot))}) — refusing (impersonation guard)`); return { code: 2, startHead: null, rec }; }
  const prov = { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null };
  const extra = {
    candidateName: rec.name, candidateRoot: rec.root,
    isolatedFrom: { ref: rec.baseRef, head: rec.baseHead, tree: rec.baseTree, at: rec.createdAt },
  };
  const blocked = (why: string, next?: string, ev?: Record<string, unknown>): VerifyOutcome => {
    // the BLOCK itself is evidence, written under the base's authority dir.
    writeVerificationBundle(root, 'candidate', [], 'blocked', prov, { evidenceRoot: root, subjectRoot: rec.root, extra: ev ? { ...extra, ...ev } : extra });
    o.say(`BLOCKED — ${why}`);
    if (next) o.say(`next: ${next}`);
    return { code: 2, startHead: null, rec };
  };
  // M9 §9 — the mandated verdict for an authority touch: three lines, the
  // event recorded in a blocked bundle with both state tokens, exit 2.
  // startHead stays null: an authority-blocked verify hands promotion NO
  // identity to apply, so the M8 sandwich cannot be laundered around it.
  const authorityBlock = (when: string, changes: AuthorityChange[]): VerifyOutcome => {
    // F2: a during/after-execution mandate is caught INSIDE the judged run —
    // persist the state so the next run cannot re-baseline on the same
    // mutated bytes and read them as innocence. The containment pre-gate
    // ('before execution') stays deliberately grudgeless: its restore path is
    // writing the promised bytes back (S7), not a re-seal ceremony, and a
    // quarantine it stamps would turn honest recovery into a setup ritual.
    if (when !== 'before execution') stampQuarantine(path.join(root, CONFIG_DIR, QUARANTINE_FILE), when, changes);
    const dir = writeVerificationBundle(root, 'candidate', [], 'blocked', prov, {
      evidenceRoot: root, subjectRoot: rec.root,
      extra: { ...extra, authorityEvent: { when, changes } },
    });
    o.say('CANARY BLOCKED COMPLETION — Verification authority was modified by the candidate.');
    if (when !== 'before execution') o.say('CANARY QUARANTINED — verify and promote refuse this base until canary setup is re-run at the terminal; re-running the same tampering cannot re-baseline it into innocence.');
    // a wholesale evidence wipe turns EVERY file into a change — print a cap,
    // the bundle carries the complete list (evidence stays the full record).
    for (const c of changes.slice(0, 8)) o.say(`  ${c.file}: ${shortState(c.before)} → ${shortState(c.after)} (${when})`);
    if (changes.length > 8) o.say(`  …and ${changes.length - 8} more change(s) — all listed in the bundle`);
    o.say('Do not allow candidate-modified Canary to judge its own mutation.');
    o.say(`next: the change is proven inside Canary's window but not attributable to a specific writer (same-user code is the honest ceiling) — restore the bytes deliberately (setup can re-seal), evidence: ${dir ?? path.join(root, CONFIG_DIR, 'evidence')}`);
    return { code: 2, startHead: null, rec };
  };
  // M9 §9 containment, BEFORE execution: a harness hook entry that setup
  // promised for this base must still be there. A strip that happened
  // outside the window is exactly what the fingerprint sandwich cannot see.
  const settings = settingsPath(root);
  if (cfg.touched.some((t) => samePath(t.path, settings))) {
    const doc = parseJsonOrNull(settings);
    if (!doc || !hasCanaryEntry(doc, new Set(cfg.hookCommands))) {
      return authorityBlock('before execution', [{ file: settings, before: 'hook entry promised by setup', after: doc ? 'entry missing' : 'unreadable' }]);
    }
  }
  // M10 §11 — the trusted intent, checked against the snapshot frozen at
  // isolation. The worker may ADD proof obligations (a growing plan, a
  // richer task); it may not silently shrink the request it was opened with:
  // drop a plan step, re-seal a step's script to easier text, delete task
  // kinds or registered requirements. Re-running setup is exactly how an
  // agent-friendly-looking "revision" arrives mechanically — the snapshot
  // makes it visible. This block is grudgeless like the pre-gate: the
  // snapshot is frozen at record-write (never re-baselined at window edges)
  // and the record itself is inside M9's fingerprint set, so no quarantine
  // is needed to stop laundering — restoring the authority bytes IS the
  // recovery, and a legitimate revision needs the human's re-isolation.
  // Honest ceiling (adversary review F1, same-UID): a worker may hollow the
  // BASE's authority and open a NEW candidate against the weaker one — no
  // CLI-side check survives an actor who owns every command and every byte
  // (M9 conceded this for hand-edited markers). What this guard closes is
  // laundering an EXISTING promise past a quietly-weakened authority; the
  // positive answer — original-request identity and USER-APPROVED revisions
  // persisted as trusted bytes — is directive §16-§18 territory: M15/M16.
  if (rec.intent) {
    const events: string[] = [];
    const curScripts = new Set(cfg.plan.map((s) => s.script));
    for (const s of rec.intent.plan) if (!curScripts.has(s.script)) events.push(`verification step "${s.script}" present at isolation is no longer in the plan`);
    if (rec.intent.seal) {
      if (!cfg.planAuthority) events.push('the sealed script texts at isolation have no seal in the current config (the authority was re-created without one)');
      else for (const [script, digest] of Object.entries(rec.intent.seal)) {
        if (cfg.planAuthority.scriptDigests[script] !== digest) events.push(`the sealed text of "${script}" changed since isolation (re-sealed to different commands)`);
      }
    }
    const t0 = canonicalTask(rec.intent.task);
    if (t0) events.push(...taskWeakening(t0, readTaskRecord(root)));
    else if (rec.intent.task?.kinds.length) events.push('frozen task identity is incomplete or malformed — re-register and re-isolate');
    for (const [d, script] of Object.entries(rec.intent.proofBindings ?? {})) {
      if (cfg.planAuthority?.proofBindings?.[d] !== script) events.push('frozen proof binding changed — re-isolate');
    }
    if (events.length) return blocked(
      'the verification intent was weakened after isolation — the candidate was opened against a stronger authority than the one now on disk: ' + events.join('; '),
      'legitimate revision is a deliberate local act (directive §11): restore the plan/task this candidate was isolated under, or re-isolate against the new authority. Canary will not verify an old promise against a quietly-shrunk one.',
      { intentEvent: { snapshotAt: rec.intent.at, events } });
  }
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
  // Guarantee 6 (directive §9), checked at BOTH edges (review F3): the
  // human-sealed authority must hold over the candidate's package.json. The
  // seal covers only the listed scripts' texts — pre/post lifecycle hooks run
  // automatically under the same command, .npmrc flags rewrite what the
  // package manager fetches and executes, and npm re-reads the on-disk
  // package.json at EVERY spawn: a candidate-side step can rewrite a LATER
  // step's sealed text mid-window and the base's fingerprinted bytes never
  // move (the candidate's package.json is its own workspace — deliberately
  // outside the authority set). So these candidate-side checks run before
  // anything executes AND again after the window; a post-window hit is an
  // authority event, not a step verdict — the mandate, never a FAIL the
  // candidate gets to size. (Candidate-only rules: a base that ships pretest
  // was sealed as-is at setup — and setup --yes seals whatever ran it.)
  // One package.json read per seal check. The pre-window and post-window
  // checks each stay a LIVE disk read on purpose — sharing a parsed copy
  // across them would hide an in-window rewrite, which is exactly what the
  // F3 post-window check exists to catch.
  const sealViolation = (timing: string): { file: string; why: string; next?: string } | null => {
    const pkg = parseJsonOrNull(path.join(rec.root, 'package.json'));
    const drift = planAuthorityDrift(rec.root, cfg, pkg);
    if (drift) return { file: path.join(rec.root, 'package.json'), why: `sealed verification authority drifted ${timing}: ${drift}`, next: `restore package.json in the candidate to the sealed text (git -C "${rec.root}" checkout -- package.json), or deliberately re-run canary setup` };
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null && !Array.isArray(pkg.scripts) ? pkg.scripts as Record<string, unknown> : null;
    if (scripts) for (const s of cfg.plan) {
      if (Object.hasOwn(scripts, `pre${s.script}`) || Object.hasOwn(scripts, `post${s.script}`)) {
        return { file: path.join(rec.root, 'package.json'), why: `the candidate defines a lifecycle hook around sealed step "${s.script}" (pre${s.script}/post${s.script}) — the package manager runs it automatically and the seal does not cover it`, next: `remove the pre${s.script}/post${s.script} entry from the candidate's package.json` };
      }
    }
    if (fs.existsSync(path.join(rec.root, '.npmrc'))) {
      const npmrc = path.join(rec.root, '.npmrc');
      const baseNpmrc = gitWithinRoot(rec.root, ['show', `${rec.baseHead}:.npmrc`]);
      if (baseNpmrc === null) return { file: npmrc, why: '.npmrc exists in the candidate but not in the isolated base — npm/pnpm flags rewrite what the sealed steps execute', next: 'delete the candidate-side .npmrc (if the BASE needs one, that is a setup-time human decision)' };
      const changed = gitWithinRoot(rec.root, ['diff', '--name-only', '--end-of-options', rec.baseHead, '--', '.npmrc']);
      if (changed === null) return { file: npmrc, why: '.npmrc cannot be compared against the isolated base — Canary does not guess past a flag-bearing config file', next: 'restore the worktree or re-isolate' };
      if (changed.trim() !== '') return { file: npmrc, why: '.npmrc changed in the candidate vs the isolated base — npm/pnpm flags there rewrite what the sealed steps execute', next: `git -C "${rec.root}" checkout -- .npmrc` };
    }
    return null;
  };
  const preSeal = sealViolation('before anything ran');
  if (preSeal) return blocked(preSeal.why, preSeal.next);
  // The obligation ladder reads the diff the VERDICT BINDS — captured BEFORE
  // the execution window, the same edge cid.head (and therefore startHead,
  // and therefore what promotion applies) is read at. A step that writes a
  // test file inside its own window must not mint regression evidence for
  // the verdict that judges it: that write lands untracked, invisible to the
  // committed bytes a PASS would promote. Post-window collection had the
  // mirror defect — obligations describing bytes that never existed at
  // startHead (correctness review #4b/#1).
  const sig = candidateDiffSignals(rec.root, rec.baseHead);
  // M9 §9 sandwich: fingerprint the authority bytes AND the evidence tree,
  // run the sealed plan, re-fingerprint. ANY difference forces BLOCKED —
  // mutated bytes can judge nothing, a planted PASS bundle authorizes nothing
  // it did not earn, and the PASS/FAIL path below is structurally never
  // reached. The throw arm checks too: an earlier step may have run before
  // the guard fired. Canary's own writes land OUTSIDE the window (see
  // authority.ts); a concurrent canary invocation can only ever add a false
  // BLOCK, never a false PASS.
  const authority = [configPath(root), settings, recordPath(root, name), path.join(root, CONFIG_DIR, TASK_FILE), CLI_ENTRY];
  const evidenceDir = path.join(root, CONFIG_DIR, EVIDENCE_DIR);
  const cliDir = path.dirname(CLI_ENTRY); // the verifier's OWN code tree (dist/src) — F1
  const preAuth = snapshotAuthority(authority);
  const preEvidence = snapshotTree(evidenceDir);
  const preCli = snapshotTree(cliDir);
  const preHead = headToken(root);
  const inWindowDrift = (): AuthorityChange[] => {
    const postHead = headToken(root);
    return [
      ...authorityDrift(preAuth, authority),
      ...treeDrift(preEvidence, evidenceDir).map((c) => ({ ...c, file: path.join(evidenceDir, c.file) })), // absolute, like the other entries
      ...treeDrift(preCli, cliDir).map((c) => ({ ...c, file: path.join(cliDir, c.file) })), // F1: §9's "must never control its verifier" includes the verifier's bytes — an in-window write is inert THIS run (modules loaded at start) and executes NEXT run (promote's fresh re-verify included), so "the judge at verdict time" demands binding them. @canary-rn workspace imports resolve outside dist/src: that slice stays the stated dep-tree ceiling.
      ...(postHead !== preHead ? [{ file: `${root}: base HEAD ref`, before: preHead, after: postHead }] : []), // F4: shared ref store — a moved base ref is moved promotion authority
    ];
  };
  let results: StepResult[];
  let regression: ReturnType<typeof discriminationObligation> = null;
  try {
    results = cfg.plan.map((step) => runPlanStep(rec.root, cfg.pm, step));
    // Both executions stay inside the authority sandwich. The comparison uses
    // the frozen isolation base, never setup's possibly older baseline.
    if (results.every((r) => r.ok)) regression = discriminationObligation(rec.root, cfg, 600_000, rec.baseHead);
  }
  catch (e) {
    const threwDrift = inWindowDrift();
    if (threwDrift.length) return authorityBlock('during execution', threwDrift);
    const threwSeal = sealViolation('during execution');
    if (threwSeal) return authorityBlock('during execution', [{ file: threwSeal.file, before: 'sealed at setup — held when the window opened', after: threwSeal.why }]);
    return blocked(`plan step refused: ${(e as Error).message} — execution stopped before any step ran`, 'the base plan names a script Canary will not execute; fix the plan via canary setup');
  }
  const authDrift = inWindowDrift();
  if (authDrift.length) return authorityBlock('during execution', authDrift);
  for (const r of results) o.step(r); // printed FIRST — the operator sees the step verdicts the tampered run claimed before the post-window check flips them
  // F3 post-window edge: the seal re-checked after execution, before the
  // verdict is read. A step that rewrote its sibling's script text executed
  // unsealed words inside a "sealed" window; green output on tampered plan
  // text is a CANARY-BLOCKED-COMPLETION, never a CANDIDATE PASS. The
  // during/after stamp also sets the quarantine — the next window starts
  // refused, so the mutated plan surface cannot re-baseline to a PASS.
  const postSeal = sealViolation('after execution');
  if (postSeal) return authorityBlock('after execution', [{ file: postSeal.file, before: 'sealed at setup — held when the window opened', after: postSeal.why }]);
  // M10 §10 — the obligation ladder over the CANDIDATE diff (baseHead frozen
  // in the record; the worktree started provably clean at isolation, so every
  // deletion here is the candidate's). The sealed plan passing is the FLOOR,
  // not the finish: TESTS PASSING != TASK PROVEN COMPLETE. Duties here derive
  // from the LIVE registered record (no hook stdin — the doctor posture);
  // AUTHORITY to judge at all derives only from the FROZEN snapshot (below).
  const task = readTaskRecord(root);
  const obligations = obligationsFor(task?.kinds ?? [], sig,
    new Set(cfg.plan.map((s) => s.kind)), task?.requirementCount ?? 0, 'isolation', task, cfg);
  if (regression !== null) {
    for (let i = obligations.length - 1; i >= 0; i -= 1) {
      if (obligations[i]!.id === regression.id) obligations.splice(i, 1);
    }
    obligations.push(regression);
  }
  // M10.2 (GLM re-audit of M10.1, F4-GATE-1/2) — the task-obligation
  // AUTHORITY is FROZEN AT ISOLATION and only the frozen snapshot can
  // discharge it. obligationsFor derives proof duties from LIVE registered
  // kinds; a candidate that registers nothing derived nothing and walked
  // through §10 on the sealed-plan floor alone. The M10.1 gate closed that
  // but read its authority from bytes an agent can write AFTER the fact:
  // registering a task post-isolation minted it (F4-GATE-1), and deleting
  // `intent` from the record made the gate conditional on an agent-writable
  // field, returning the taskless bypass (F4-GATE-2). Law now:
  //  - authority = kinds frozen in THIS candidate's own intent snapshot.
  //    No snapshot, null/missing task, or empty frozen kinds → the duty
  //    stands UNPROVEN, exit 2, promotion locked. Absence is never
  //    interpreted as "pre-M10 legacy, PASS-compatible" — the record is
  //    agent-writable between windows, so its shape proves nothing about
  //    its age; it fails safe;
  //  - registration AFTER isolation is growth (always allowed): it ADDS
  //    duties via the live ladder above, but can never retroactively mint
  //    the frozen authority. The recovery is register the work, then
  //    RE-ISOLATE — the fresh snapshot carries the honest task;
  //  - shrink of frozen kinds vs the live record is blocked earlier by the
  //    §11 guard; forged NON-EMPTY frozen kinds plus matching live
  //    registration is byte-equivalent to a real re-isolation — that is the
  //    documented same-UID ceiling (file header), not a gap in this gate;
  //  - no flag, env var, or compatibility escape hatch exists (F4-F);
  //  - precedence stays fail > unmet > unproven > pass: this rides as an
  //    'unproven' and can never outrank an objective violation or a FAIL.
  const frozenTask = rec.intent?.task ?? null;
  const frozenKinds = frozenTask && Array.isArray(frozenTask.kinds) ? frozenTask.kinds : [];
  if (!frozenKinds.length || !canonicalTask(frozenTask)) {
    obligations.unshift({ id: 'task-authority', mode: 'objective', status: 'unproven',
      note: rec.intent
        ? 'NO task-obligation authority FROZEN at isolation: no task was registered when this candidate was opened. Registering afterwards is growth — it adds duties, it cannot mint this authority retroactively. Register the work (canary task "..." --kind ...) and RE-ISOLATE, then verify the new candidate; omitting registration is not a way through §10, it is exactly what makes §10 unprovable.'
        : 'NO task-obligation authority: this record carries no intent snapshot — it either predates task authority or the snapshot was removed, and the record is agent-writable bytes between windows, so absence proves nothing and fails safe. Register the work (canary task "..." --kind ...) and RE-ISOLATE so a fresh snapshot freezes the authority; there is no pre-M10 PASS path.' });
  }
  // blocker 3 — ACCEPTANCE FROM AN INTERACTIVE TERMINAL is consumed HERE and
  // nowhere else. It can close ONLY non-objective duties standing UNPROVEN (an
  // objective proof is never acceptance-material), and only while its binding
  // is FRESH: the exact base HEAD, the exact candidate commit the judgment was
  // typed over, the exact frozen task state, AND — GLM F-3 — the exact
  // acceptance-eligible duty set as it stood at signing, recomputed NOW from
  // the LIVE registration. A terminal acceptance authorizes exactly the
  // subjective duties that existed when it was given; if the duty set grew,
  // shrank, or a requirement's identity changed since, the old acceptance is
  // STALE and the duties reopen (with named advice) — a given-once acceptance
  // can never outlive what it was given for. No acceptance ⇒ nothing changes;
  // NO PROOF, NO DONE is the same law it always was, now with an honest
  // completion path. (Promotion is covered for free: isolatePromote's gate 1
  // is a LIVE verifyCandidate, which runs this same check again.)
  let acceptanceStale = false;
  const acc = readAcceptance(root, name);
  if (acc !== null) {
    const openSubjective = obligations.filter((x) => x.mode === 'non-objective' && x.status === 'unproven');
    if (openSubjective.length) {
      const context = authorizationContext(root, name);
      const fresh = typeof context !== 'string' && acc.subjectDigest === subjectDigest(context.subject);
      if (fresh) {
        for (const x of openSubjective) {
          x.status = 'met';
          x.note = `accepted from an interactive terminal on ${acc.at} — exact clean commit/tree, frozen authority, material task, requirements and subjective duties. This is judgment, not technical proof.`;
        }
      } else acceptanceStale = true;
    }
  }
  const obList = obligations.map((x) => ({ id: x.id, mode: x.mode, status: x.status, note: x.note }));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    // FAIL stays FAIL — but the bundle now carries the obligation read too
    // (M11 repair fuel: the worker sees WHAT proof is missing, not only which
    // command went red).
    writeVerificationBundle(root, 'candidate', results, 'fail', prov, { evidenceRoot: root, subjectRoot: rec.root, extra: { ...extra, obligations: obList } });
    if (cid.dirty) o.detail('candidate working tree is dirty — verification ran on the checked-out files, not a committed state');
    o.say(`CANDIDATE FAIL — ${failed.length}/${results.length} step(s) not green; the trusted base was not touched. Evidence: ${path.join(root, CONFIG_DIR, 'evidence')}`);
    return { code: 2, startHead: cid.head, rec };
  }
  const unmet = obligations.filter((x) => x.status === 'unmet');
  if (unmet.length) {
    writeVerificationBundle(root, 'candidate', results, 'blocked', prov, { evidenceRoot: root, subjectRoot: rec.root, extra: { ...extra, obligations: obList } });
    if (cid.dirty) o.detail('candidate working tree is dirty — verification ran on the checked-out files, not a committed state');
    o.say('CANDIDATE BLOCKED — the sealed plan passed, but a required proof obligation is objectively violated:');
    for (const x of unmet) o.say(`  obligation [${x.id}] UNMET (${x.mode}): ${x.note}`);
    o.say(`next: restore the deleted verification files (git -C "${rec.root}" restore --source=${rec.baseHead} --staged --worktree <path>), or — if removing them IS the human's intent — let the HUMAN commit that removal on the base and RE-ISOLATE against it. An agent claim cannot authorize coverage loss, and acceptance never closes this duty (it is objective).`);
    return { code: 2, startHead: null, rec }; // no identity to promote onto
  }
  const unproven = obligations.filter((x) => x.status === 'unproven');
  if (unproven.length) {
    // NOT PROVEN is never PASS and never promotable: exit 2 and a null
    // startHead so M8 gate 1 cannot launder a green-plan-but-unproven run
    // into an apply. Closing an obligation is real work (a test, a sealed
    // bench step) — not a bytes edit.
    writeVerificationBundle(root, 'candidate', results, 'unproven', prov, { evidenceRoot: root, subjectRoot: rec.root, extra: { ...extra, obligations: obList } });
    if (cid.dirty) o.detail('candidate working tree is dirty — verification ran on the checked-out files, not a committed state');
    const met = obligations.filter((x) => x.status === 'met');
    // PART II split semantics: when EVERY open obligation is one only an
    // interactive-terminal acceptance can close (non-objective: ui/
    // performance/dependency duties), the
    // technical evidence is genuinely complete — saying so is honesty, not a
    // softer verdict. Objective duties still unmet stay the plain mixed message.
    if (unproven.every((x) => x.mode === 'non-objective')) {
      o.say(`CANDIDATE NOT PROVEN — the sealed plan is green and every technical duty is met; what remains can only be closed by acceptance from an interactive terminal (NO PROOF, NO DONE still binds):`);
      o.say('  TECHNICAL EVIDENCE: PROVEN (sealed plan green; objective duties met)');
      o.say('  SUBJECTIVE ACCEPTANCE: USER JUDGMENT REQUIRED');
      o.say(`  OVERALL COMPLETION: NOT PROVEN — promotion stays locked until acceptance from an interactive terminal: canary accept ${echoable(name)}`);
    } else {
      o.say('CANDIDATE NOT PROVEN — the sealed plan is green, but proof obligations for this task are UNPROVEN (NO PROOF, NO DONE):');
    }
    // stdout lists what is MISSING; the full MET/UNPROVEN ledger stays in the
    // evidence bundle (obligations: obList below) — printing met duties here
    // was pure token tax on the agent that must read this.
    for (const x of unproven) o.say(`  obligation [${x.id}] UNPROVEN (${x.mode}): ${x.note}`);
    if (acceptanceStale) o.say(`  note: an acceptance for "${name}" EXISTS but is STALE — the candidate commit, its base, the frozen task, or the acceptance-eligible duty set changed since it was signed (a terminal acceptance authorizes ONLY the subjective duties that existed at signing), so the duties reopened. Re-run from an interactive terminal: canary accept ${echoable(name)}`);
    if (met.length) o.say(`  obligations: ${met.length}/${obligations.length} MET — full list in the evidence bundle.`);
    /**
     * WHO can close what — stated instead of implied.
     *
     * MEASURED (`bench-r12b`, workflow arm, 2 trials): the previous single `next:` line said "close
     * each UNPROVEN obligation with its actual proof (objective ones), or accept the subjective ones
     * …", which reads as an instruction a worker can carry out. It cannot: binding a requirement to a
     * sealed check is an operator act (`canary bind` + `canary setup`, re-sealing authority) and an
     * acceptance needs a terminal. The worker therefore spent 53 turns / 23 minutes / 1.85M tokens
     * re-reading Canary's own help and re-trying, while the outcome was fixed from the start.
     *
     * So the two classes are now separated in the output, and the second one says plainly that no
     * further work in this session can change it.
     */
    const WORKER_CLOSABLE = new Set(['regression-evidence', 'tests-green', 'coverage-loss']);
    const byWorker = unproven.filter((x) => WORKER_CLOSABLE.has(x.id) || (x.mode === 'objective' && !x.id.startsWith('target-')));
    const byOperator = unproven.filter((x) => !byWorker.includes(x));
    if (byWorker.length > 0) {
      o.say(`next: YOU can close ${byWorker.length} of these, with evidence in the candidate: ${byWorker.map((x) => x.id).join(', ')} — make it real (a check that fails without your change), commit in the candidate, then run finish again.`);
    }
    if (byOperator.length > 0) {
      o.say(`next: these are NOT CLOSABLE FROM THIS SESSION (no amount of further work changes it): ${byOperator.map((x) => x.id).join(', ')}.`);
      o.say(`  an OPERATOR closes them by binding each requirement to a check the sealed plan runs (canary bind <script> --requirement "…", then canary setup), or a HUMAN accepts them in a terminal: canary accept ${echoable(name)}.`);
      o.say('  Do not keep working on them and do not edit checks to make them disappear. Report exactly this state and stop — the trusted base was not touched and promotion stays locked.');
    }
    return { code: 2, startHead: null, rec };
  }
  const postIdentity = candidateIdentity(rec.root);
  if (cid.dirty !== false || !postIdentity.resolved || postIdentity.dirty !== false || postIdentity.head !== cid.head || postIdentity.tree !== cid.tree) return blocked('candidate is dirty / UNCOMMITTED or changed during verification — no promotable PASS for an unstable subject', 'commit the intended state and re-verify');
  const evidence = writeVerificationBundle(root, 'candidate', results, 'pass', prov, { evidenceRoot: root, subjectRoot: rec.root, extra: { ...extra, obligations: obList } });
  if (!evidence) o.say('Evidence storage unavailable — this verdict comes from live checks; no durable bundle is guaranteed.');
  if (cid.dirty) o.detail('candidate working tree is dirty — verification ran on the checked-out files, not a committed state');
  if (obligations.length) o.detail(`obligations: ${obligations.length}/${obligations.length} MET — the sealed plan plus this task's proof obligations are all satisfied (directive §10).`);
  const cnt = gitWithinRoot(rec.root, ['rev-list', '--count', '--end-of-options', `${rec.baseHead}..HEAD`]);
  const advanced = cnt !== null && /^\d+$/.test(cnt.trim()) && Number(cnt) > 0 ? ` (${cnt.trim()} commit(s) beyond the isolated base)` : '';
  o.say(`CANDIDATE PASS — "${name}" @ ${short(cid.head)}${advanced} verified against the sealed plan. ELIGIBLE for promotion — nothing applied; promotion is a separate act.`);
  return { code: 0, startHead: cid.head, rec };
}

function isolateVerify(root: string, cfg: CanaryConfig, o: Out, name: string): number {
  return verifyCandidate(root, cfg, o, name).code;
}

/** ONE derivation of the reviewed subject. Every read is live; presentation and
 * timestamps are excluded. Exact restoration may become fresh again. */
function authorizationContext(root: string, name: string): {
  rec: CandidateRecord; subject: AuthorizationSubject; task: TaskIdentity;
  obligations: ReturnType<typeof obligationsFor>;
} | string {
  const cfg = readConfig(root);
  if (!cfg || cfg === 'corrupt' || untrustedConfigReason(root, cfg)) return 'untrusted or unreadable base configuration; run canary setup';
  if (quarantineInfo(path.join(root, CONFIG_DIR, QUARANTINE_FILE))) return 'base authority is quarantined; restore it and run setup';
  const rec = loadRecord(root, name);
  if (rec === 'missing' || rec === 'invalid' || !samePath(rec.baseRoot, root)) return 'candidate record missing, malformed or bound to a different base';
  const frozen = canonicalTask(rec.intent?.task);
  const task = readTaskRecord(root);
  if (!frozen || !frozen.kinds.length) return 'NO frozen task authority; register the work and RE-ISOLATE';
  if (!task) return 'material task identity missing or malformed; register and RE-ISOLATE';
  const weakening = taskWeakening(frozen, task);
  if (weakening.length) return weakening.join('; ');
  const cd = commonDir(root);
  if (!cd || commonDir(rec.root) !== cd) return 'candidate no longer belongs to the expected Git store';
  // Recheck toplevel explicitly: git discovery must not fall back to a parent.
  const top = gitCommand(rec.root, ['rev-parse', '--show-toplevel']);
  if (!top || top.status !== 0 || !samePath(fs.realpathSync(top.stdout.trim()), fs.realpathSync(rec.root))) return 'candidate repository identity changed';
  const cid = candidateIdentity(rec.root);
  if (!cid.resolved || !cid.head || !cid.tree || cid.dirty !== false) return 'candidate is not a clean committed state; commit the exact state you want reviewed, then run canary accept again';
  const baseTree = gitWithinRoot(root, ['rev-parse', '--verify', `${rec.baseHead}^{tree}`])?.trim();
  if (!baseTree || baseTree !== rec.baseTree) return 'frozen base tree cannot be verified';
  if (!cfg.planAuthority || planAuthorityDrift(rec.root, cfg)) return 'sealed authority missing or drifted; restore it before acceptance';
  for (const step of rec.intent!.plan) if (!cfg.plan.some(s => s.kind === step.kind && s.script === step.script)) return 'frozen plan weakened; re-isolate';
  for (const [k,v] of Object.entries(rec.intent!.seal ?? {})) if (cfg.planAuthority.scriptDigests[k] !== v) return 'frozen script authority changed; re-isolate';
  for (const [k,v] of Object.entries(rec.intent!.proofBindings ?? {})) if (cfg.planAuthority.proofBindings?.[k] !== v) return 'frozen proof binding changed; re-isolate';
  const obligations = obligationsFor(task.kinds, candidateDiffSignals(rec.root, rec.baseHead), new Set(cfg.plan.map(s => s.kind)), task.requirementCount, 'isolation', task, cfg);
  const pairs = (v: Record<string, unknown>) => Object.entries(v).sort(([a],[b]) => a.localeCompare(b));
  const authority = { store: cd, pm: cfg.pm, plan: [...cfg.plan].sort((a,b) => a.script.localeCompare(b.script)),
    scripts: pairs(cfg.planAuthority.scriptDigests), proofs: pairs(cfg.planAuthority.proofBindings ?? {}),
    frozenPlan: [...rec.intent!.plan].sort((a,b) => a.script.localeCompare(b.script)), frozenSeal: pairs(rec.intent!.seal ?? {}) };
  const subject: AuthorizationSubject = {
    candidate: name, candidateCommit: cid.head, candidateTree: cid.tree,
    baseHead: rec.baseHead, baseTree, baseAuthorityIdentity: digest(JSON.stringify(authority)),
    frozenTask: frozen, liveTask: task,
    /**
     * WHAT THE SIGNATURE COVERS, AND WHY THE STATUS FILTER MATTERS (v1.2 fix).
     *
     * This used to be every `non-objective` duty REGARDLESS OF STATUS, so a set that was already
     * `met` still entered the subject — and `dependency-change` is non-objective by construction,
     * which is how a candidate with no subjective duty open still produced a non-empty set.
     * MEASURED consequence: `accept` printed "duties this signature covers: none currently open"
     * and then wrote a record whose subjectDigest bound a coverage set that corresponded to no open
     * duty at all. A human signature is the one act Canary cannot verify, so it must authorise
     * exactly the duties that are genuinely open and nothing else.
     */
    subjectiveDuties: obligations.filter(o => o.mode === 'non-objective' && o.status === 'unproven').map(o => o.id).sort(),
  };
  return { rec, subject, task, obligations };
}

/**
 * blocker 3 — `canary accept <candidate>`: the human completion path for
 * SUBJECTIVE duties. The claim, stated exactly as enforced: the SUPPORTED
 * acceptance flow requires an interactive terminal on BOTH stdin and stdout —
 * the normal non-interactive coding-agent path is refused, and there is
 * deliberately NO --yes, NO env escape, NO config toggle: skipping the
 * terminal check would be the laundering vector this command exists to close.
 * A TTY is NOT cryptographic human identity: a same-UID process that can
 * drive a PTY (e.g. `script -qec`) or hand-write this record (every field is
 * derivable from local state) remains inside Canary's documented local
 * forgery ceiling (M2). This is a policy/friction boundary on the USUAL agent
 * path, not an OS security boundary — SECURITY.md carries the full model.
 * One canonical AuthorizationSubject binds the clean committed candidate,
 * frozen base and sealed authority, full frozen/live declarations, and the
 * subjective duty set. authorizationContext reconstructs it before and after
 * confirmation and when verification consumes acceptance. Changed scope or
 * bytes reopen consent; replacing frozen declarations requires re-isolation.
 * Objective shortfalls remain independent of the acceptance record.
 */
export async function cmdAccept(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
  const name = rest[0] ?? '';
  if (rest.length !== 1 || !name) { o.say('usage: canary accept <candidate> — typed in an interactive terminal; no flags escape the terminal check'); return 3; }
  if (!NAME_RE.test(name)) { o.say(`candidate name must match ${NAME_RE}`); return 3; }
  const root = findRepoRoot(process.cwd());
  if (!root) { o.say('not inside a git repository — there is no candidate registry here to accept from'); return 2; }
  // PROVIDER-ONLY ROUTING (v1.1 item 4): when a provider is configured, the
  // review statement is minted by the broker or it is not minted at all. This is
  // checked BEFORE the interactive prompt, because a terminal confirmation that
  // could not be honoured would be theatre.
  const store = storeFromEnv();
  const providerOnly = brokerRoutingRequired(store);
  /**
   * IF YOU ARE DEBUGGING A FAILING "case C" AND THIS CONDITION READS `if (false)` IN `dist`:
   * the compiled artifact is MUTATED, not the gate removed on purpose.
   * `tooling/probes/master-pass-mutations.mjs` writes exactly that form for its "TTY gate removable"
   * case, mutating `dist` and restoring it afterwards; an interrupted battery leaves it behind, and
   * then `pre10-acceptance` case C fails against an artifact this source never produced. Rebuild with
   * `npx tsc -b apps/cli --force`. The tripwire `tooling/probes/v12-dist-tripwire.mjs` now runs first
   * in the productization chain and names this state explicitly.
   */
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    o.say('REFUSED — the supported acceptance flow requires an interactive terminal on both streams; this session has none, so the non-interactive path is refused. (No flag or env var escapes this. A terminal is friction, not cryptographic human identity — see SECURITY.md.) To accept, run canary accept <candidate> yourself from a real terminal.');
    return 2;
  }
  const before = authorizationContext(root, name);
  if (typeof before === 'string') { o.say(`REFUSED — ${before}`); return 2; }
  const { rec, subject, task } = before;
  const subjective = subject.subjectiveDuties;
  const rc = task.requirementCount;
  /**
   * AN ACCEPTANCE MUST COVER SOMETHING (v1.2 fix).
   *
   * MEASURED, found by the v1.2 acceptance probe: `accept` was willing to sign an acceptance whose
   * covered duty set was EMPTY — it printed "duties this signature covers: none currently open" and
   * wrote the record anyway. That is the opposite of what a fail-closed act should do, and it is
   * dangerous rather than merely untidy: an acceptance is bound to a subject digest that includes
   * the subjective duty-id SET, so a signature over an empty set is a standing authorisation that
   * can be re-read later, and the message even warned that "any duty that later joins this set will
   * NOT be covered" — a warning is not a gate.
   *
   * A human signature is the one act Canary cannot verify, so it is the one that must be narrowest.
   * With nothing acceptance-eligible, there is nothing to accept: refuse, and say what actually
   * closes the open duties instead.
   */
  if (subjective.length === 0) {
    o.say(`REFUSED — candidate "${name}" has NO subjective duty open, so there is nothing for a human to accept. An acceptance that covers nothing is not a signature over the work.`);    o.say('  If the work looks unfinished, the open duties are OBJECTIVE and only a measurement closes them: run `canary isolate --verify ' + name + '` to see exactly which ones, then make the proof hold (or have the OPERATOR bind the requirement to a check the sealed plan runs).');
    return 2;
  }
  const baseToken = headToken(root);
  o.say(`ACCEPTING the SUBJECTIVE duties of candidate "${name}" — live registration [${(task?.kinds ?? []).join(', ') || 'no kinds'}]${rc ? ` + ${rc} requirement(s)` : ''}`);
  o.say(`  base ${short(rec.baseHead)} → candidate ${short(subject.candidateCommit)}  (tree ${short(subject.candidateTree)})`);
  o.say(`  duties this signature covers: ${subjective.length ? subjective.join(', ') : 'none currently open (any duty that later joins this set will NOT be covered — the record goes STALE)'}`);
  o.say('  A terminal acceptance authorizes EXACTLY the duties above as registered now — never duties that appear after it.');
  o.say('  Objective proofs are NEVER closed by this: a green plan and every objective duty must already hold (verify first: canary isolate --verify <name>).');
  o.say('  Read the evidence before signing: .canary/evidence/*-candidate/verification.json');
  fs.writeSync(1, `Accepting from this interactive terminal. Type the candidate name exactly ("${name}") to accept, or anything else to refuse: `);
  const buf = Buffer.alloc(160);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { n = 0; }
  const answer = buf.subarray(0, n).toString('utf8').trimEnd();
  if (answer !== name) { o.say('NOT ACCEPTED — the typed name did not match exactly. Nothing was written; the base is untouched.'); return 2; }
  const after = authorizationContext(root, name);
  if (typeof after === 'string' || headToken(root) !== baseToken || subjectDigest(after.subject) !== subjectDigest(subject)) {
    o.say('REFUSED — review identity changed during confirmation (STALE / RACED). Nothing accepted; review the committed state again.');
    return 2;
  }
  const acc: AcceptanceRecord = {
    schema: 'canary-acceptance/3', at: new Date().toISOString(), candidate: name,
    subject, subjectDigest: subjectDigest(subject), acceptedBy: 'tty-human',
  };
  if (providerOnly) {
    // A provider is installed, so the LOCAL writable path is closed: no
    // acceptance file is written here under any circumstance. The broker — the
    // process with the reviewer key and a different identity — decides.
    const routed = await submitAcceptanceThroughBroker({ projectId: projectIdForRoot(root), candidate: name }, store);
    if (routed.routed && routed.ok) {
      o.say(`ACCEPTED by the broker: the review statement for "${name}" was minted through the provider boundary.`);
      o.say(`next: canary isolate --verify ${name} — subjective duties read MET (accepted by the broker); objective proof still has to hold on its own.`);
      return 0;
    }
    const detail = routed.routed ? refusalText(routed.code, routed.message) : 'the broker could not be consulted';
    o.say(`REFUSED — a provider is configured here, so acceptance must be minted by the broker, and it was not: ${detail}`);
    o.say('  NOTHING WAS WRITTEN. No acceptance record exists, and the local writable path is closed while a provider is installed.');
    o.say('  this is not a fallback: if the broker is unavailable or refuses, the act does not happen. Run `canary provider status` to see the boundary.');
    return 2;
  }
  if (!writeAcceptance(root, acc)) { o.say('acceptance could not be written (.canary containment refused it) — nothing accepted'); return 2; }
  o.say(`ACCEPTED from this interactive terminal: ${path.join(CONFIG_DIR, ACCEPTANCE_SUBDIR, `${name}.json`)}`);
  o.say(`next: canary isolate --verify ${name} — subjective duties read MET (accepted, and bound to these exact bytes); objective proof still has to hold on its own.`);
  return 0;
}

/**
 * M8 — NO PASS, NO APPLY (directive §8). Promotion is the ONLY act in Canary
 * that lets candidate-authored bytes enter the trusted base, so it trusts:
 *   - a LIVE re-verification against the sealed plan, this invocation, right
 *     now — stored bundles are never read back, so replayed, forged, or
 *     stale evidence cannot authorize anything (an author wanting a PASS
 *     must make the bytes pass, not write a file);
 *   - content identity: the apply fast-forwards onto exactly the commit the
 *     sandwich proved clean across the verify→apply window;
 *   - `merge --ff-only` as the race primitive: git's own ref lock refuses
 *     concurrently with "not something we can merge", so a base that moved
 *     mid-act loses the race instead of being overwritten;
 *   - post-proof: after the apply, base HEAD and tree are re-derived and must
 *     byte-match the verified commit, else the act refuses loudly with the
 *     apply honestly recorded { applied: true, proven: false }.
 * Every refusal path leaves the base byte-identical and writes a blocked
 * promotion bundle — a refusal is evidence. Idempotent replay onto a base
 * already at the verified commit ACCEPTS with no second act (no reset, ever).
 * Deliberately NOT claim-trusting: worker DONE lines, candidate-created PASS
 * files, and the ADVANCED registry status are all inert here.
 */
async function isolatePromote(root: string, cfg: CanaryConfig, o: Out, name: string): Promise<number> {
  const prov = { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null };
  const writeBundle = (results: StepResult[], status: 'accepted' | 'blocked', rec: CandidateRecord, promotion: Record<string, unknown>): string => {
    const dir = writeVerificationBundle(root, 'promotion', results, status, prov, {
      evidenceRoot: root, subjectRoot: rec.root,
      extra: { candidateName: rec.name, promotion },
    });
    return dir ?? 'unavailable (storage failed; live verdict only)';
  };
  const refuse = (rec: CandidateRecord | null, why: string, next?: string, promotion?: Record<string, unknown>): number => {
    // NO PASS, NO APPLY: every refusal is evidence AND leaves the base intact.
    if (rec) {
      const dir = writeBundle([], 'blocked', rec, { ...(promotion ?? {}), refusal: why });
      o.say(`  evidence: ${dir}`);
    }
    o.say(`PROMOTION REFUSED — ${why}`);
    o.say('  nothing was applied; the trusted base is untouched.');
    if (next) o.say(`next: ${next}`);
    return 2;
  };
  // Gate 1 — the SOLE authority: a live re-verification, right now. Record
  // shape, base binding, gitlink, drift, hooks, .npmrc and the plan itself
  // are all re-checked by this call; nothing stored from an earlier run is
  // trusted, so replay and forgery have no code path here.
  const v = verifyCandidate(root, cfg, o, name);
  if (v.code !== 0) return v.code;
  const rec = v.rec; const H = v.startHead;
  if (!rec || H === null) return 2; // fail-closed: a PASS without identity is not a PASS
  // Gate 2 — sandwich: the candidate must still BE the bytes that passed.
  const id = candidateIdentity(rec.root);
  if (!id.resolved) return refuse(rec, 'the candidate became unresolvable during this act — the verified bytes cannot be confirmed', 'canary isolate --list to see what happened');
  if (id.head !== H) return refuse(rec, `the candidate HEAD moved during verification (${short(H)} → ${short(id.head)}) — the bytes that passed are not what I would apply`, 'run --promote again (it re-verifies from scratch)', { from: H, to: id.head });
  if (id.dirty !== false) return refuse(rec, 'the candidate has UNCOMMITTED or unresolvable changes — promotion requires clean COMMITTED bytes', 'commit inside the candidate first', { from: H, to: H });
  // Gate 3 — pin the verified commit's tree, content-addressed (H is HEX).
  const treeOut = gitWithinRoot(rec.root, ['rev-parse', '--verify', '--end-of-options', `${H}^{tree}`]);
  const treeT = treeOut !== null && HEX_RE.test(treeOut.trim()) ? treeOut.trim() : null;
  if (treeT === null) return refuse(rec, 'the verified commit tree cannot be resolved — there is nothing to prove a promotion against', undefined, { from: H, to: H });
  // Gate 4 — the trusted target: base identity live, and TRACKED-clean.
  // Untracked base files (setup's own .claude edit among them) do not block:
  // git's own ff-merge refuses when one would be overwritten by the merge.
  const idb = candidateIdentity(root);
  if (!idb.resolved) return refuse(rec, 'the trusted base identity became unresolvable — cannot promote into a repo git cannot answer for', 'run canary doctor on the base', { from: null, to: H, tree: treeT });
  const baseTrackedDirty = gitWithinRoot(root, ['status', '--porcelain', '--untracked-files=no']);
  if (baseTrackedDirty === null) return refuse(rec, 'the trusted base working tree cannot be inspected — Canary does not guess past a git failure', 'run canary doctor on the base', { from: idb.head, to: H, tree: treeT });
  if (baseTrackedDirty.trim() !== '') return refuse(rec, 'the trusted base has UNCOMMITTED tracked changes — commit or stash the base first', 'promotion never merges into, or overwrites, uncommitted human work', { from: idb.head, to: H, tree: treeT });
  // Gate 5 — promotion fast-forwards a checked-out branch (no detached HEAD
  // rewriting, no history games — the human always keeps plain `git merge`).
  const branchRaw = gitWithinRoot(root, ['symbolic-ref', '--quiet', 'HEAD']);
  if (branchRaw === null) return refuse(rec, 'the trusted base is on a detached HEAD — promotion fast-forwards a checked-out BRANCH', `git switch <branch> in ${root} (or merge by hand; Canary never auto-merges onto detached state)`, { from: idb.head, to: H, tree: treeT });
  const branch = branchRaw.trim(); // evidence fields carry no stray newlines
  const branchShort = branch.replace(/^refs\/heads\//, '');
  // Gate 6 — idempotent replay: the base already sits ON the verified commit.
  if (idb.head === H) {
    writeBundle([], 'accepted', rec, { branch, from: H, to: H, tree: treeT, idempotent: true });
    o.say(`ALREADY APPLIED — "${name}"'s verified commit ${short(H)} is exactly where ${branchShort} already sits; the live re-verification passed.`);
    o.say('ACCEPTED — no second act was needed.');
    return 0;
  }
  // Gate 6½ — PROVIDER-ONLY ROUTING (v1.1 item 4). When a provider is configured,
  // the fast-forward is authorized by the broker or it does not happen. This is the
  // LAST gate before the only act in Canary that lets candidate bytes into the
  // trusted base, and it is deliberately placed here rather than earlier: all the
  // identity gates above must have passed for the broker to be asked about THIS
  // exact {base, candidate} pair, and the broker's answer is compared against the
  // live identities below — a broker that authorizes a different candidate, base or
  // project authorizes nothing.
  const store = storeFromEnv();
  if (brokerRoutingRequired(store) && !controllerExecution.getStore()) {
    const routed = await reservePromotionThroughBroker({ projectId: projectIdForRoot(root), candidate: name }, store);
    if (!routed.routed || !routed.ok) {
      const detail = routed.routed ? refusalText(routed.code, routed.message) : 'the broker could not be consulted';
      return refuse(rec, `a provider is configured here, so promotion must be authorized by the broker, and it was not: ${detail}`,
        'run canary provider status — with a provider installed there is no local promotion path, by design',
        { branch, from: idb.head, to: H, tree: treeT, providerOnly: true });
    }
    const window = (routed.result ?? {}) as { expectedHead?: unknown; candidateCommit?: unknown; targetId?: unknown };
    if (window.candidateCommit !== H || window.expectedHead !== idb.head) {
      return refuse(rec, 'the broker authorized a DIFFERENT promotion window than this act: '
        + `broker {base ${short(String(window.expectedHead ?? '?'))}, candidate ${short(String(window.candidateCommit ?? '?'))}} `
        + `vs local {base ${short(idb.head)}, candidate ${short(H)}} — a mismatch is a refusal, never a merge`,
        'the broker is bound to another candidate or base; re-run canary setup on this repository',
        { branch, from: idb.head, to: H, tree: treeT, providerOnly: true, brokerWindow: window });
    }
    return refuse(rec, 'the broker reserved a window but did not perform protected promotion; caller-owned apply is forbidden with a provider configured',
      'a production broker-owned verifier and promoter must be installed; reservation is not apply authority',
      { branch, from: idb.head, to: H, tree: treeT, providerOnly: true });
  }
  // Gate 7 — the apply: fast-forward only. H passed HEX_RE, so it can never
  // parse as a flag; --end-of-options is deliberately NOT used (undocumented
  // for `merge` — relying on lenient parsing would be luck, not plumbing).
  const t0 = new Date().toISOString();
  const gExe = gitExe();
  const m: GitResult = gitCommand(root, ['merge', '--ff-only', H], 120_000)
    ?? { status: null, stdout: '', stderr: "git is not resolvable in Canary's trusted environment — the fast-forward was NOT attempted" };
  const t1 = new Date().toISOString();
  const mergeStep: StepResult = {
    kind: 'promotion', display: `git -C ${root} merge --ff-only ${H}`, ok: m.status === 0, exitCode: m.status,
    secs: Math.max(0, Math.round((Date.parse(t1) - Date.parse(t0)) / 100) / 10),
    tail: `${m.stdout ?? ''}${m.stderr ?? ''}`.trim().split(/\r?\n/).filter((l) => l.trim() !== '').slice(-6).join('\n'),
    argv: ['git', '-C', root, 'merge', '--ff-only', H], cwd: root,
    execArgv: [gExe ?? '', '-C', root, 'merge', '--ff-only', H],
    exec: { file: gExe ?? '', digest: gExe === null ? null : execDigest(gExe), via: 'trusted-git', policy: ENV_POLICY },
    stdout: m.stdout ?? '', stderr: m.stderr ?? '', startedAt: t0, endedAt: t1,
  };
  if (m.status !== 0) {
    const firstLine = (m.stderr || m.stdout || String(m.error?.message ?? '')).trim().split(/\r?\n/)[0] ?? '(no message)';
    return refuse(rec, `git refused the fast-forward onto the verified commit: ${firstLine}`, 'the base moved or diverged since isolation (or an untracked file collides) — re-isolate onto the current base, or merge by hand; Canary never auto-merges or rewrites history', { branch, from: idb.head, to: H, tree: treeT });
  }
  // Gate 8 — post-proof: the applied bytes must BE the verified bytes.
  const pHeadOut = gitWithinRoot(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD']);
  const pTreeOut = gitWithinRoot(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{tree}']);
  const pHead = pHeadOut !== null && HEX_RE.test(pHeadOut.trim()) ? pHeadOut.trim() : null;
  const pTree = pTreeOut !== null && HEX_RE.test(pTreeOut.trim()) ? pTreeOut.trim() : null;
  if (pHead !== H || pTree !== treeT) {
    return refuse(rec, 'git reported success but Canary cannot re-derive the base identity to match the verified commit — INSPECT the base now', 'this arm should be unreachable on healthy git; the fast-forward WAS applied and is recorded', { branch, from: idb.head, to: H, tree: treeT, applied: true, proven: false });
  }
  const dir = writeBundle([mergeStep], 'accepted', rec, { branch, from: idb.head, to: H, tree: treeT });
  o.say(`PROMOTED "${name}" — ${branchShort} fast-forwarded ${short(idb.head)} → ${short(H)}.`);
  o.say(`POST-PROOF PASS — base tree ${short(treeT)} is byte-identical to the tree the sealed plan verified this invocation. ACCEPTED — the promotion is proven, not assumed.`);
  o.say(`  evidence: ${dir}`);
  o.say(`the candidate record and worktree remain (cleanup is a separate act: canary isolate --remove ${name}).`);
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
  const git = (args: string[]): GitResult => gitCommand(root, args, 120_000)
    ?? { status: null, stdout: '', stderr: "git is not resolvable in Canary's trusted environment" };
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

/** Called only inside a trusted controller execution scope. The OS boundary,
 * not possession of this exported function, protects the base and registry. */
export async function controllerCandidate(root: string, name: string, head: string, baseHead: string, promote: boolean): Promise<number> {
  if (!controllerExecution.getStore()) throw new Error('restricted controller execution is required');
  const o = new Out(false);
  const base = trustedBase(root, o);
  if (typeof base === 'number') return base;
  const rec = loadRecord(root, name);
  if (typeof rec !== 'object' || candidateIdentity(rec.root).head !== head || candidateIdentity(root).head !== baseHead) return 2;
  return promote ? await isolatePromote(root, base.cfg, o, name) : verifyCandidate(root, base.cfg, o, name).code;
}

export async function cmdIsolate(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose);
  const usage = 'usage: canary isolate <name> [--base <ref>] [--path <dir>] [repo-path] | --list | --verify <name> | --remove <name> [--discard] | --promote <name>';
  const misuse = (why: string): number => { o.say(`isolate: ${why}`); o.say(usage); return 3; };
  let mode: 'create' | 'list' | 'verify' | 'remove' | 'promote' | null = null;
  let arg = ''; let baseRef = 'HEAD'; let baseGiven = false; let pathGiven = false;
  let customPath: string | null = null; let discard = false;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--list') { if (mode) return misuse('one mode at a time'); mode = 'list'; }
    else if (a === '--verify' || a === '--remove' || a === '--promote') {
      if (mode) return misuse('one mode at a time');
      mode = a.slice(2) as 'verify' | 'remove' | 'promote';
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
  if (discard && mode !== 'remove') return misuse('--discard applies to --remove only');
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
  if (mode === 'promote') return await isolatePromote(root, cfg, o, arg);
  if (mode === 'remove') return isolateRemove(root, o, arg, discard);
  return isolateList(root, o);
}
