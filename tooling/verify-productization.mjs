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
 *   4. empty-plan checkpoint probe (degenerate config never fakes green)
 *   5. M2 real-git probe (candidate binds to actual HEAD/dirty; digest binds to
 *      retained bytes; outward-linked evidence dir is never written through)
 *   6. clean-room lazy-vibecoder acceptance (one-command full journey)
 *   7. HTG inline-interpreter corpus (real hook autonomy: 0 routine prompts,
 *      every dangerous case still gated) — classification only, nothing runs
 *   8. packed-artifact clean room (tooling/pack.mjs -> npm pack -> install the
 *      exact .tgz into a spaces-path temp repo; full vibecoder journey through
 *      the installed bundle; tarball audited: no monorepo, no secrets)
 * Brief items 5-7 (setup twice, partial repair, uninstall/reinstall, harness
 * preservation, quoting) are asserted inside steps 2 and 6.
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
  ['probe: empty-plan checkpoint', process.execPath, ['tooling/probes/checkpoint-empty-plan.mjs'], {}],
  ['probe: M2 claims-not-evidence (real git)', process.execPath, ['tooling/probes/m2-claims-not-evidence.mjs'], {}],
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
