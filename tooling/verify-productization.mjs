#!/usr/bin/env node
/**
 * THE productization verification entrypoint (approval-free workflow rule):
 * the agent calls ONE known command — `npm run verify:productization` — instead
 * of dynamically constructing shell programs. Every step is a build, a
 * node --test run over compiled tests, or a first-class probe script under
 * tooling/probes/ — no inline interpreters anywhere in this chain.
 *
 * Coverage (productization surface):
 *   1. clean build               (tsc -b — including the onboarding tests)
 *   2. onboarding contract tests (setup/doctor/uninstall/checkpoint + S1-S7 pins)
 *   3. M2 claims-not-evidence contract tests (verification bundles are written
 *      from Canary's own execution and never read back; agent claims are
 *      UNTRUSTED hints that can neither create PASS nor BLOCK — at most they
 *      annotate an already-decided block with a claim-vs-observed contrast)
 *   4. M3 trust-class contract tests (bundles are CANARY_OBSERVED, claims are
 *      AGENT_REPORTED, EXTERNALLY_VERIFIED has no producer; self-declared or
 *      copied class labels are inert — no promotion by writing bytes into a
 *      Canary-owned file; class prose is verbose-only)
 *   5. M4 provenance contract tests (bundle answers plan/code/task/where/when
 *      via planDigest, baseline, candidate tree, per-step stamps; task is a
 *      digest with zero verdict authority, prose never stored; companion hash
 *      is tamper-evidence only — labeled as such, never a signature; pre-M4
 *      configs get baseline:null, not an invented past)
 *   6. M5 trusted-plan contract tests (setup seals plan + verbatim script
 *      texts; the "vitest -> echo all good" swap is blocked BEFORE execution
 *      though it exits 0; config-side plan edits and malformed seals fail
 *      closed; re-seal only via a setup smoke; pre-M5 configs verify as before)
 *   7. M6 proof-orchestration contract tests (task kinds can only ADD proof
 *      obligations on top of the sealed plan — never lift it; attributable
 *      test deletions are UNMET, unattributable UNPROVEN; the engine is pure
 *      over injected diff signals; canary task is AGENT_REPORTED digest-only
 *      with zero authority; malformed records collapse to pre-M6 silence; a
 *      fake-git (unresolvable) diff never upgrades an obligation to met)
 *   8. M7 candidate-isolation contract tests (fake-git ceiling: the CLI surface,
 *      trusted-base gate, registry shape-validation, impersonation guard before
 *      any identity read, LOST -> honest BLOCKED bundle with every M2-M4 field
 *      intact, uninstall refusing to delete .canary while candidates are
 *      registered, Windows reserved device names at parse, and PASS is
 *      UNREACHABLE under fake git — the positive path is proven only by probe 14)
 *  8b. M8 promotion contract tests (the apply act under the fake-git ceiling:
 *      --promote needs one mode + a valid name and --discard stays --remove-only
 *      (misuse 3); record-level refusals DELEGATE to the live re-verification —
 *      promote carries no separate, impersonatable record gate; the canonical
 *      impersonation guard answers for a forged baseRoot; fake git can never
 *      reach the apply: BLOCKED only, no PROMOTED/ACCEPTED line, no promotion
 *      bundle, and a forged stored PASS changes nothing; promotion bundles obey
 *      the same bounded retention as every other evidence source)
 *   9. empty-plan checkpoint probe (degenerate config never fakes green)
 *  10. M2 real-git probe (candidate binds to actual HEAD/dirty; digest binds to
 *      retained bytes; outward-linked evidence dir is never written through)
 *  11. M3 real-git probe (copy-to-promote attack end to end: a forged
 *      CANARY_OBSERVED pass bundle blocks neither checkpoint nor doctor)
 *  12. M4 real-git probe (real head+tree bytes; baseline holds while the
 *      candidate moves; task digest over the real wire; companion hash binds
 *      and catches a byte flip that stays behaviorally inert)
 *  13. M5 real-git probe (the swap really exits 0 yet blocks; git-restore
 *      returns silent verification; re-setup re-seals under its smoke; the
 *      candidate's edit is visible in git status — M7's future surface)
 *  14. M7 real-git probe (§7 guarantees end to end on real git: worktree bound
 *      to the exact base commit; sealed plan executes INSIDE the candidate with
 *      evidence in the BASE; FAIL/BLOCK leave the base byte-identical; every
 *      pre-execution block writes a zero-step blocked bundle — script swap
 *      (marker-absence + positive control), worker-added pre/post lifecycle
 *      hook, candidate-side .npmrc (absent-from-base and changed-vs-base),
 *      committed gitlink with no .gitmodules, empty plan; dirty/LOST/IMPOSTOR/
 *      ADVANCED/UNREGISTERED recover honestly (registered names never listed
 *      UNREGISTERED); spaces+Unicode --path AND an outside-base --path that
 *      registers, verifies, and clean-removes without --discard; remove refuses
 *      dirty without --discard)
 *  14b. M8 real-git promotion probe (§8 end to end on real git: live re-verify
 *      is the SOLE authority — a stored PASS bundle is never read back, a forged
 *      one stays inert bytes; ff-only apply binds the base to exactly the
 *      verified commit and the post-proof re-derives base head+tree against the
 *      pinned candidate identity; idempotent re-promote lands ALREADY APPLIED
 *      with no second act; divergence, TRACKED-dirty base, untracked collision
 *      (git's own refusal, stray bytes preserved), detached base, candidate
 *      HEAD moved mid-plan (the identity-sandwich catch, plus honest recovery:
 *      a stable second promote applies the new head), dirty candidate after a
 *      PASS — every refusal leaves the base byte-identical and writes a blocked
 *      bundle; candidate-planted local config + a git shim on PATH cannot edit
 *      the sealed authority the plan actually ran; malformed record delegates;
 *      the former M8-scope residual — a plan step writing the base evidence
 *      dir — is now CLOSED by M9's whole-tree evidence fingerprint, step 14c)
 *  14c. M9 real-git authority probe (§9 end to end: a sealed plan step that
 *      touches ANY authority byte — config, harness settings (rewrite +
 *      drop), registry record, task intent, the evidence store (forged PASS
 *      bundle planted, observed bundle edited, whole dir wiped), the
 *      VERIFIER'S OWN dist/src code tree, or the base HEAD ref — is caught by
 *      the fingerprint sandwich at both window edges: the §9 mandate, exit 2,
 *      a zero-step blocked bundle carrying authorityEvent; the PASS path is
 *      structurally never reached. Review hardening, all proven here: the
 *      sealed-plan checks re-run AFTER the window (a step rewriting a later
 *      step's script text executes unsealed words yet cannot PASS — the
 *      after-execution mandate catches it with on-disk proof the swap ran);
 *      a during/after catch QUARANTINES the base — re-verify and promote
 *      refuse before judging, writing no bundle, until a human setup re-seal
 *      clears it (a byte-idempotent tampering can no longer re-baseline into
 *      innocence, and gate 6 can never read an attacker-moved base ref as
 *      ALREADY APPLIED); the containment pre-gate stays grudgeless (restore
 *      recovers PASS with no marker). Untouched authority still passes (the
 *      guard must not shout at innocence); prevention is honestly
 *      detection-at-edges — no kernel lock exists to claim (m9-lock-facts),
 *      the ref really moved under S13, and a same-UID hand can delete the
 *      marker by hand (what quarantine closes is the automated laundering))
 *  14d. M10 real-git obligations+intent probe (§10/§11 end to end: the sealed
 *      plan passing is the FLOOR, not the finish — a green plan with a missing
 *      proof obligation (or with NO obligations at all: M10.1/GLM F4 — zero
 *      registered task kinds means NO task-obligation authority, so Canary
 *      refuses to claim completion it cannot judge; see step 14e) is
 *      CANDIDATE NOT PROVEN (exit 2, honest 'unproven'
 *      bundle that still carries the executed steps) and promotion stays
 *      locked; an objectively violated obligation (committed test deletion)
 *      is CANDIDATE BLOCKED with the obligation named and restore advice
 *      printed; a red plan stays CANDIDATE FAIL and its bundle carries the
 *      obligation read (M11 repair fuel); closing an obligation is REAL WORK —
 *      adding the test / restoring the file recovers PASS. §11: the record
 *      freezes plan+sealed texts+task at isolation; weakening that authority
 *      afterwards (drop a step or re-seal a script's text via re-setup,
 *      shrink the registered task) blocks BEFORE anything runs — zero-step
 *      bundle carrying intentEvent, refuse on promote, NO quarantine stamp
 *      (grudgeless: the snapshot itself rides M9's fingerprint set), record
 *      NOT re-baselined by refusal; restoring the bytes IS the recovery,
 *      growth is always allowed. M10.2 (GLM re-audit, F4-GATE-2) corrected
 *      what a no-snapshot record does: it FAILS SAFE to NOT PROVEN — the
 *      record is agent-writable bytes between windows, so absence is never
 *      read as "pre-M10, PASS-compatible"; the recovery is register +
 *      re-isolate (see step 14f). Review-round gates: a
 *      lying index (--assume-unchanged/--skip-worktree) reads dirty so gate 2
 *      refuses; a test renamed out of the test DIRECTORY is coverage loss
 *      even keeping the .test.js suffix; obligation signals are frozen
 *      BEFORE the execution window (a step writing its own test mid-window
 *      mints no evidence); and isolate ROLLS BACK when the fresh worktree is
 *      not provably clean at birth (post-checkout hook) — no registration,
 *      no half-created candidate; its lying-index premise — --assume-unchanged
 *      prints lowercase and --skip-worktree prints 'S' in git ls-files -v,
 *      both invisible to git status — is pinned by the lsfiles-letters probe)
 *  14e. M10.1 F4 taskless-bypass repro (the GLM audit's strongest agent move
 *      — register NOTHING — run end to end and pinned CLOSED: a taskless
 *      candidate with a green sealed plan is CANDIDATE NOT PROVEN (exit 2,
 *      obligation [task-authority] UNPROVEN naming the missing authority),
 *      promotion is locked with zero promotion bundles and the base HEAD
 *      byte-unchanged; a pre-fix run of this same probe logged the bypass
 *      OPEN in docs/night-evidence. Positive control in the same probe: the
 *      honest path (registered bugfix + committed regression test) still
 *      lands PASS → PROMOTED → ACCEPTED — the gate blocks laundering, not
 *      work.)
 *  14f. M10.2 adversarial authority battery (real git, real CLI — the GLM
 *      re-audit's two CONFIRMED bypasses plus every neighbouring agent move,
 *      cases A–L: A taskless-at-isolation and B post-isolation refactor
 *      self-mint (F4-GATE-1) stay NOT PROVEN — registering later ADDS duties,
 *      it never mints the frozen authority; C no other kind mints it either;
 *      D/H register + RE-ISOLATE is the only recovery and task churn cannot
 *      move a frozen verdict; E/F/G deleting or spoofing rec.intent —
 *      backdated legacy dressing included — fail safe, there is no pre-M10
 *      interpretation and unreadable shapes refuse as malformed; I env vars
 *      and invented flags are inert; J planted and stale PASS bundles are
 *      inert because promotion live-re-verifies; K precedence holds exactly
 *      (fail > unmet > unproven > pass); L positive control — an honest
 *      pre-isolation bugfix with a committed regression test lands PASS →
 *      ACCEPTED. Every blocked case: exit 2, zero promotion bundles, base
 *      HEAD byte-unchanged.)
 *  15. M6 real-git probe (a CLEAN setup baseline really can attribute blame;
 *      a green plan + deleted test = BLOCK — worktree, STAGED, or committed —
 *      and the printed restore advice unmutes; renames out of (and staying
 *      inside) test paths; a NON-ASCII test name cannot defeat the -z gate
 *      (review #1/#8); Canary's own backup of a tracked settings.json stays
 *      invisible to the stamp (review #2); a committed lockfile ADDS the
 *      dependency obligation with no declaration; a registered task never
 *      lifts the sealed authority; the dirty-at-setup mirror keeps staged +
 *      worktree deletions UNPROVEN with an honest premise)
 *  16. clean-room lazy-vibecoder acceptance (one-command full journey)
 *  17. HTG inline-interpreter corpus (real hook autonomy: 0 routine prompts,
 *      every dangerous case still gated) — classification only, nothing runs.
 *      R2 host-neutrality: the wrapper under test defaults to the TRACKED
 *      canonical bytes (not a personal live-hook path); the engine resolves
 *      via env or the real npm-global layouts and is labeled by source,
 *      package version and sha256; a layer that cannot reproduce on this
 *      host exits 3 with explicit SKIP lines — counted as SKIP here, never
 *      as a PASS, never as a module-not-found crash.
 *  18. packed-artifact clean room (tooling/pack.mjs -> npm pack -> install the
 *      exact .tgz into a spaces-path temp repo; full vibecoder journey through
 *      the installed bundle; tarball audited: no monorepo, no secrets)
 *  19. 1.1 P0 trust-boundary (the Astra merge): the sealed authority store's
 *      custody refusals (linked/hard-linked key material, mismatched keypair
 *      halves, reserved device names, lost/corrupt ledgers, CAS conflicts, a
 *      held lock that is never stolen), the LOCAL authorization kernel
 *      (verifier+reviewer receipts bound to run/project/domain/duties, a
 *      promotion window that cannot be cached) and the platform capability
 *      contracts — plus a behavioral mutation battery over those compiled
 *      modules: unsound control fails, every mutant dies on a node:test
 *      assertion, and no mutant survives on a crash or module error.
 * Brief items 5-7 (setup twice, partial repair, uninstall/reinstall, harness
 * preservation, quoting) are asserted inside steps 2 and 16.
 *
 * Exit code: 0 only when every step passed OR ended in an explicit,
 * listed host-bound SKIP (headline then says PASS WITH HOST-BOUND SKIP —
 * a skip is never counted into a 25/25-style pass claim); 1 on any FAIL or
 * an aborted chain. NO PROOF, NO DONE.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CANARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = process.platform === 'win32';
// 1.1 P0 isolation: every step spawns the CLI (directly or through a probe),
// and every such spawn inherits/spreads this process's env — pointing it at
// ONE fresh temp trust store keeps all verification sealing out of the real
// per-user store, which is exactly what it is NOT for.
process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-oracle-'));
const STEPS = [
  ['build (tsc -b)', 'npm', ['run', 'build'], {}],
  ['full unit suite', 'npm', ['test'], {}],
  ['onboarding contract tests', process.execPath, ['--test', 'apps/cli/dist/test/onboarding.test.js'], {}],
  ['M2 claims-not-evidence contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m2-claims-not-evidence.test.js'], {}],
  ['M3 trust-classes contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m3-trust-classes.test.js'], {}],
  ['M4 provenance contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m4-provenance.test.js'], {}],
  ['M5 trusted-plan contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m5-proof-plan.test.js'], {}],
  ['M6 proof-orchestration contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m6-proof-orchestration.test.js'], {}],
  ['M7 candidate-isolation contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m7-candidate-isolation.test.js'], {}],
  ['M8 promotion contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m8-promotion.test.js'], {}],
  ['M9 authority contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m9-authority.test.js'], {}],
  ['M10 obligations contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m10-obligations.test.js'], {}],
  ['1.1 §1 project-adapter contract tests', process.execPath, ['--test', 'apps/cli/dist/test/project-adapter.test.js'], {}],
  ['1.1 P0 trust-store sealing contract tests', process.execPath, ['--test', 'apps/cli/dist/test/trust-store.test.js'], {}],
  ['1.1 P0 trust-store wiring tests', process.execPath, ['--test', 'apps/cli/dist/test/trust-wiring.test.js'], {}],
  ['1.1 §21 machine-readable protocol tests', process.execPath, ['--test', 'apps/cli/dist/test/protocol.test.js'], {}],
  ['1.1 §18-21 agent capability + advisory integration tests', process.execPath, ['--test', 'apps/cli/dist/test/agents.test.js'], {}],
  ['1.1 §14 real-Python end-to-end (no package.json)', process.execPath, ['--test', 'apps/cli/dist/test/python-e2e.test.js'], {}],
  ['1.1 §35 metrics record (off by default, never changes a verdict)', process.execPath, ['--test', 'apps/cli/dist/test/metrics.test.js'], {}],
  ['1.1 §22 workflow (work -> finish) tests', process.execPath, ['--test', 'apps/cli/dist/test/orchestrate.test.js'], {}],
  ['1.1 §23 fast-path decision tests (fail-closed rules)', process.execPath, ['--test', 'apps/cli/dist/test/fastpath.test.js'], {}],
  ['1.1 §23 fast-path WIRED (sealed declaration, opt-in skipping)', process.execPath, ['--test', 'apps/cli/dist/test/fastpath-cli.test.js'], {}],
  ['1.1 P0 trust-store attack contract tests', process.execPath, ['--test', 'apps/cli/dist/test/trust-store-attacks.test.js'], {}],
  ['1.1 P0 broker authorization contract tests', process.execPath, ['--test', 'apps/cli/dist/test/broker.test.js'], {}],
  ['1.1 P0 platform-boundary contract tests', process.execPath, ['--test', 'apps/cli/dist/test/platform-boundary.test.js'], {}],
  ['probe: empty-plan checkpoint', process.execPath, ['tooling/probes/checkpoint-empty-plan.mjs'], {}],
  ['probe: M2 claims-not-evidence (real git)', process.execPath, ['tooling/probes/m2-claims-not-evidence.mjs'], {}],
  ['probe: M3 trust-classes (real git)', process.execPath, ['tooling/probes/m3-trust-classes.mjs'], {}],
  ['probe: M4 provenance (real git)', process.execPath, ['tooling/probes/m4-provenance.mjs'], {}],
  ['probe: M5 trusted plan (real git)', process.execPath, ['tooling/probes/m5-proof-plan.mjs'], {}],
  ['probe: M6 proof orchestration (real git)', process.execPath, ['tooling/probes/m6-proof-orchestration.mjs'], {}],
  ['probe: M7 candidate isolation (real git)', process.execPath, ['tooling/probes/m7-candidate-isolation.mjs'], {}],
  ['probe: M8 promotion (real git)', process.execPath, ['tooling/probes/m8-promotion.mjs'], {}],
  ['probe: M9 authority guard (real git)', process.execPath, ['tooling/probes/m9-authority.mjs'], {}],
  ['probe: M10 obligations + intent (real git)', process.execPath, ['tooling/probes/m10-obligations.mjs'], {}],
  ['probe: M10.1 F4 taskless-bypass repro (real git)', process.execPath, ['tooling/probes/m10-f4-bypass-repro.mjs'], {}],
  ['probe: M10.2 adversarial authority battery (real git)', process.execPath, ['tooling/probes/m10-2-adversarial.mjs'], {}],
  ['probe: M10 lying-index letters (git premise)', process.execPath, ['tooling/probes/m10-lsfiles-letters.mjs'], {}],
  ['probe: Lazy-Connect status contract (real git)', process.execPath, ['tooling/probes/lazy-connect-status.mjs'], {}],
  ['probe: master-pass split-verdict subjectivity battery (real git)', process.execPath, ['tooling/probes/master-pass-subjectivity.mjs'], {}],
  ['probe: pre-1.0 execution-environment authority battery (real git, poisoned env)', process.execPath, ['tooling/probes/pre10-env-authority.mjs'], {}],
  ['probe: pre-1.0 human-acceptance battery (real git + pty)', process.execPath, ['tooling/probes/pre10-acceptance.mjs'], {}],
  ['probe: master-pass mutation battery (built dist)', process.execPath, ['tooling/probes/master-pass-mutations.mjs'], {}],
  ['probe: 1.1 P0 trust-boundary mutations (scratch builds)', process.execPath, ['tooling/probes/p0-trust-boundary-mutations.mjs'], {}],
  ['probe: acceptance growth (real git + pty)', process.execPath, ['tooling/probes/f3-acceptance-growth.mjs'], {}],
  ['probe: architecture closure matrix', process.execPath, ['tooling/probes/architecture-closure.mjs'], {}],
  ['probe: architecture closure mutations (scratch builds)', process.execPath, ['tooling/probes/architecture-closure-mutations.mjs'], {}],
  ['probe: architecture metrics and zero-write status', process.execPath, ['tooling/probes/architecture-metrics.mjs'], {}],
  ['probe: clean-room lazy vibecoder', process.execPath, ['tooling/probes/cleanroom-lazy-vibecoder.mjs'], {}],
  ['probe: HTG inline-interpreter corpus', process.execPath, ['tooling/probes/htg-inline-interpreter-corpus.mjs'], {}],
  ['probe: packed-artifact clean room (spaces path)', process.execPath, ['tooling/probes/cleanroom-packed-artifact.mjs'], {}],
  ['probe: documented examples (Node + Python, real CLI)', process.execPath, ['tooling/probes/examples-smoke.mjs'], {}],
  ['probe: packed architecture matrix', process.execPath, ['tooling/probes/packed-architecture.mjs'], {}],
];

// R4 honest evidence: three per-step states, never collapsed. A probe may
// signal exit 3 = "passed what THIS host could run, with explicit host-bound
// SKIP lines" (see htg-inline-interpreter-corpus.mjs) — that is NOT a PASS
// and is never counted as one; the SKIP lines are echoed into the summary.
// Exit code contract: 0 = zero failures (all PASS, or PASS + listed
// host-bound SKIPs — the headline distinguishes); 1 = any FAIL or a step
// aborted mid-chain so later steps judged stale bytes.
const SKIP_AWARE = new Set([
  'probe: HTG inline-interpreter corpus',
  'probe: documented examples (Node + Python, real CLI)',
  // The two acceptance batteries need a REAL pty. Where the host has no
  // drivable pty (measured: win32 here — see tooling/probes/tty-capability.mjs)
  // they drive the same product gate through the repo's in-process terminal
  // driver, run EVERY product assertion, print an explicit SKIP naming what the
  // platform could not prove, and exit 3. SKIP is never counted as PASS.
  'probe: pre-1.0 human-acceptance battery (real git + pty)',
  'probe: acceptance growth (real git + pty)',
]);
const results = []; // [label, 'PASS'|'SKIP'|'FAIL', note]
for (const [label, cmd, args] of STEPS) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, { cwd: CANARY, encoding: 'utf8', shell: SH && cmd === 'npm', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
  console.log(tail);
  const skipLines = SKIP_AWARE.has(label)
    ? out.split(/\r?\n/).filter((l) => l.startsWith('SKIP')).map((l) => l.slice(0, 140))
    : [];
  const verdict = r.status === 0 ? 'PASS' : (SKIP_AWARE.has(label) && r.status === 3 ? 'SKIP' : 'FAIL');
  // M10.2 Fix 6: a SKIP that EXECUTED checks is a different fact from one that
  // ran zero because the environment is absent — the note must distinguish
  // them. Neither kind is ever counted as a PASS. The count is any `PASS <case>`
  // / `FAIL <case>` line, so it also measures the acceptance batteries, whose
  // cases are not prefixed `L` like the HTG corpus layers.
  const ran = SKIP_AWARE.has(label) ? out.split(/\r?\n/).filter((l) => /^(?:PASS|FAIL)\s+\S/.test(l)).length : 0;
  const skipNote = `host-bound: ${ran} check(s) EXECUTED, ${skipLines.length} explicit SKIP(s) — SKIP never counts as PASS` +
    (ran === 0 ? '; nothing here was accepted by execution' : '');
  results.push([label, verdict, verdict === 'SKIP' ? skipNote : (verdict === 'FAIL' ? `(exit ${r.status}${r.error ? `: ${r.error.message}` : ''})` : '')]);
  if (verdict === 'FAIL' && label.startsWith('build')) break; // later steps judge stale bytes — stop honestly
}

console.log('\n=== VERIFY-PRODUCTIZATION SUMMARY ===');
for (const [label, verdict, note] of results) console.log(`${verdict}  ${label}${note ? `  — ${note}` : ''}`);
const failed = results.filter(([, v]) => v === 'FAIL').length;
const skipped = results.filter(([, v]) => v === 'SKIP').length;
const passed = results.filter(([, v]) => v === 'PASS').length;
const incomplete = results.length < STEPS.length && !failed; // build aborted early
if (failed || incomplete) {
  console.log(`VERIFY-PRODUCTIZATION: FAIL (${failed} step(s) failed${incomplete ? '; chain aborted before all steps ran' : ''} of ${STEPS.length})`);
} else if (skipped) {
  const zeroExec = results.filter(([, v, n]) => v === 'SKIP' && /^host-bound: 0 check\(s\) EXECUTED/.test(n)).length;
  console.log(`VERIFY-PRODUCTIZATION: PASS WITH HOST-BOUND SKIP (${passed} PASS, ${skipped} SKIP — NOT full ${STEPS.length}/${STEPS.length} acceptance on this host; the SKIP lines above name what was not reproducible here${zeroExec ? `; ${zeroExec} SKIP step(s) EXECUTED ZERO checks — environment absent, accepted as nothing` : ''})`);
} else {
  console.log(`VERIFY-PRODUCTIZATION: PASS (${passed}/${STEPS.length} steps green)`);
}
process.exit(failed || incomplete ? 1 : 0);
