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
 *      every dangerous case still gated) — classification only, nothing runs
 *  18. packed-artifact clean room (tooling/pack.mjs -> npm pack -> install the
 *      exact .tgz into a spaces-path temp repo; full vibecoder journey through
 *      the installed bundle; tarball audited: no monorepo, no secrets)
 * Brief items 5-7 (setup twice, partial repair, uninstall/reinstall, harness
 * preservation, quoting) are asserted inside steps 2 and 16.
 *
 * Exit code: 0 only when every step passed. NO PROOF, NO DONE.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CANARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = process.platform === 'win32';
const STEPS = [
  ['build (tsc -b)', 'npm', ['run', 'build'], {}],
  ['onboarding contract tests', process.execPath, ['--test', 'apps/cli/dist/test/onboarding.test.js'], {}],
  ['M2 claims-not-evidence contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m2-claims-not-evidence.test.js'], {}],
  ['M3 trust-classes contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m3-trust-classes.test.js'], {}],
  ['M4 provenance contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m4-provenance.test.js'], {}],
  ['M5 trusted-plan contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m5-proof-plan.test.js'], {}],
  ['M6 proof-orchestration contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m6-proof-orchestration.test.js'], {}],
  ['M7 candidate-isolation contract tests', process.execPath, ['--test', 'apps/cli/dist/test/m7-candidate-isolation.test.js'], {}],
  ['probe: empty-plan checkpoint', process.execPath, ['tooling/probes/checkpoint-empty-plan.mjs'], {}],
  ['probe: M2 claims-not-evidence (real git)', process.execPath, ['tooling/probes/m2-claims-not-evidence.mjs'], {}],
  ['probe: M3 trust-classes (real git)', process.execPath, ['tooling/probes/m3-trust-classes.mjs'], {}],
  ['probe: M4 provenance (real git)', process.execPath, ['tooling/probes/m4-provenance.mjs'], {}],
  ['probe: M5 trusted plan (real git)', process.execPath, ['tooling/probes/m5-proof-plan.mjs'], {}],
  ['probe: M6 proof orchestration (real git)', process.execPath, ['tooling/probes/m6-proof-orchestration.mjs'], {}],
  ['probe: M7 candidate isolation (real git)', process.execPath, ['tooling/probes/m7-candidate-isolation.mjs'], {}],
  ['probe: clean-room lazy vibecoder', process.execPath, ['tooling/probes/cleanroom-lazy-vibecoder.mjs'], {}],
  ['probe: HTG inline-interpreter corpus', process.execPath, ['tooling/probes/htg-inline-interpreter-corpus.mjs'], {}],
  ['probe: packed-artifact clean room (spaces path)', process.execPath, ['tooling/probes/cleanroom-packed-artifact.mjs'], {}],
];

const results = [];
for (const [label, cmd, args] of STEPS) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, { cwd: CANARY, encoding: 'utf8', shell: SH && cmd === 'npm', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
  console.log(tail);
  const ok = r.status === 0;
  results.push([label, ok]);
  if (!ok) console.log(`(exit ${r.status}${r.error ? `: ${r.error.message}` : ''})`);
  if (!ok && label.startsWith('build')) break; // later steps judge stale bytes — stop honestly
}

console.log('\n=== VERIFY-PRODUCTIZATION SUMMARY ===');
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `VERIFY-PRODUCTIZATION: FAIL (${failed}/${STEPS.length} steps failed or skipped after failure)` : 'VERIFY-PRODUCTIZATION: PASS (all steps green)');
process.exit(failed ? 1 : 0);
