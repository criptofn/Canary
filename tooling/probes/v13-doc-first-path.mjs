// v1.3 §19 — DO THE DOCS STILL DESCRIBE THE SIMPLER PRODUCT?
//
// The v1.3 objective ends with "docs rewritten around the simpler product", and the measurement behind
// that is blunt: the everyday shape (setup once, then work normally) cost 92.7% of a plain run, while the
// candidate ceremony (`work` -> `finish`) cost 177.8% — with identical correctness. So a document that
// presents the ceremony as the ordinary way to use Canary is not merely out of date; it steers agents
// into the shape that costs nearly twice as much.
//
// AGENTS.md is the file that matters most here, because it is the one every coding agent reads in a
// repository. It led with `canary work` / `canary finish` until v1.3 §19, which is exactly the text that
// produced the expensive shape. This probe pins the ORDER — the everyday path first — and pins the
// HONESTY — that where the expert path IS documented, its measured cost is stated beside it.
//
// This is a ratchet, not a style rule. It asserts two things a reader depends on: the first thing shown is
// the thing they should do, and the costlier path is never presented as free. It deliberately does NOT
// check prose, headings or wording, so the docs stay editable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Every fenced code block in a markdown document, in order.
 *  `\r?\n` because these files are checked out with CRLF on Windows — MEASURED: a pattern that
 *  required a bare `\n` after the fence matched NOTHING, and the probe then reported "shows no Canary
 *  command at all" about a document full of them. A probe that cannot read its input must not be
 *  mistaken for a document that says nothing. */
function codeBlocks(md) {
  return [...md.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
}
/** The first code block that actually DRIVES the CLI.
 *  Not merely a block containing the word "canary": the README's first such block is `npm install -g`,
 *  which legitimately comes before `setup`, and asserting on it produced a FAIL about a document that
 *  was correct. The question is which Canary SUBCOMMAND a reader is shown first. */
const firstCanaryBlock = (md) => codeBlocks(md)
  .find((b) => /\bcanary\s+(setup|work|finish|doctor|status|result|bind|task|accept)\b/.test(b)) ?? null;
/** The body of one `## heading` section, up to the next heading of the same or higher level. */
function section(md, heading) {
  const start = md.indexOf(heading);
  if (start === -1) return null;
  const rest = md.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
const agentsMd = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');

check('A1-the-agent-facing-doc-shows-the-everyday-path-FIRST', () => {
  const usage = section(agentsMd, '## How an agent should use Canary on a project it is changing');
  assert(usage, 'AGENTS.md no longer has a "How an agent should use Canary" section');
  const block = firstCanaryBlock(usage);
  assert(block, 'that section shows no Canary command at all, so an agent is told to use Canary without being shown how');
  assert(/setup/.test(block),
    `the FIRST Canary commands an agent sees do not include \`setup\`:\n${block}`);
  assert(!/canary\s+work/.test(block),
    'the FIRST Canary commands an agent sees are the candidate ceremony. That is the 177.8% shape '
    + `presented as the default:\n${block}`);
});

check('A2-the-README-shows-the-everyday-path-first-too', () => {
  const block = firstCanaryBlock(readme);
  assert(block, 'the README shows no Canary command, so a new user is never shown how to start');
  assert(/setup/.test(block), `the README's first Canary block does not include \`setup\`:\n${block}`);
  assert(!/canary\s+work/.test(block),
    `the README leads with the ceremony:\n${block}`);
});

check('A3-where-the-candidate-path-IS-documented-its-measured-cost-is-stated', () => {
  const usage = section(agentsMd, '## How an agent should use Canary on a project it is changing') ?? '';
  if (!/canary\s+work/.test(usage)) return; // not documented here at all: nothing to qualify
  assert(/177\.8|costs?\s+MORE|expert surface/i.test(usage),
    'AGENTS.md documents the candidate path without stating that it is measured to cost more than the '
    + 'everyday path (177.8% vs 92.7%). A reader would reasonably take it as the normal way to work.');
});

check('A4-the-README-labels-the-ceremony-with-its-measured-cost-too', () => {
  const expert = section(readme, '## Expert mode') ?? '';
  if (!/canary\s+work/.test(expert)) return; // the ceremony is not shown there at all
  assert(/177\.8/.test(expert),
    'the README shows the `work` -> `finish` ceremony without the measured figure (177.8% of a plain '
    + "agent's tokens, against 92.7% for the everyday shape). Without it the ceremony reads as free.");
});

// ── the block Canary itself writes into OTHER projects' AGENTS.md ──
// Same question, different file: this one is generated, so it is checked from a real install rather than
// from the text in this repository's own AGENTS.md.
// ── C: TOKEN-CLAIM HONESTY ──
// Two specific falsehoods have each been written into these documents once, and a reader cannot check
// either by inspection — one UNDERSTATED Canary's result and one would OVERSTATE it. Both are pinned.
const DOCS = ['README.md', 'AGENTS.md', 'docs/V1.3-RELEASE-AUDIT.md'];
const docs = DOCS.map((f) => ({ f, text: fs.readFileSync(path.join(repo, f), 'utf8') }));

check('C1-no-document-claims-setup-ran-for-EVERY-arm', () => {
  // SELF-TEST FIRST, because a guard that cannot fire is worse than no guard: this is the exact sentence the
  // README carried until v1.3 §28, and the patterns must reject it.
  const historical = 'Same three fixtures, same model, and `canary setup` executed for\n**every** arm '
    + '(`tooling/benchmark/run-trial.mjs`), so Canary is wired in all of them. What differs is the shape.';
  assert(/canary setup[\s\S]{0,140}?every\*{0,2}\s+arm/i.test(historical),
    'the C1 pattern no longer matches the falsehood it exists to catch — the historical README sentence '
    + 'would now pass unnoticed. Restore the pattern before trusting this check');
  assert(/wired in all of them/i.test(historical), 'the C1 "wired in all of them" pattern has gone slack');

  for (const { f, text } of docs) {
    assert(!/canary setup[\s\S]{0,140}?every\*{0,2}\s+arm/i.test(text),
      `${f} says \`canary setup\` ran for EVERY arm. It does not: run-trial.mjs:254 lists the protected arms `
      + 'and `plain` is not among them (line 803 says so again — "the plain arm HAS no Canary"). The arm map '
      + 'is therefore Canary against genuine plain, which is the STRONGER reading, and the sentence '
      + 'understated the result while being false');
    assert(!/wired in all of them/i.test(text),
      `${f} says Canary is "wired in all of them"; the plain arm has no Canary at all`);
  }
  console.log('INFO   no document claims the plain arm was wired (and the pattern provably rejects the old text)');
});

check('C2-where-a-document-mentions-the-75-target-it-says-it-was-NOT-met', () => {
  for (const { f, text } of docs) {
    if (!/75\s*%/.test(text)) continue;
    assert(/no configuration[\s\S]{0,160}?75|not (reached|met|achieved)|never reached|did not reach/i.test(text),
      `${f} mentions the 75 % token target without stating it was NOT met. The measured position is 92.7 % `
      + 'for the everyday shape and 95.3 % by median for confined mode with the per-batch check. A document '
      + 'that leaves the target looking achieved is the overclaim this repository exists to prevent');
    console.log(`INFO   ${f} states the 75 % target as not met`);
  }
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-doc-path-'));
try {
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({
    name: 'doc-path', private: true, scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2) + '\n');

  // The fixture must be its OWN git repository. This is the THIRD probe in v1.3 to learn it, and the
  // failure mode is always the same and always looks like a product bug: `findRepoRoot` WALKS UP, so a
  // bare temp directory resolves to whatever repository encloses it — here `C:\Users\Johannes`, which
  // already carried an advisory block, so the install honestly reported "nothing changed" about a
  // project the probe never created.
  const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'docs@canary.local'],
    ['config', 'user.name', 'Doc Path Probe'], ['add', '-A'], ['commit', '-m', 'base']]) {
    const r = spawnSync(git, args, { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert(r.status === 0, `fixture git ${args[0]} failed: ${r.stdout}${r.stderr}`);
  }

  // v1.4 §C — the advisory block is per-PROJECT and agent-independent, and this section measures the
  // BLOCK, so it installs it through an integration that is still advisory. It used `codex`, which
  // now has a real completion hook: `canary agents install codex` is refused on purpose (a gating
  // integration's hook has one owner — `setup`), and `v14-codex-stop-hook.mjs` measures that hook.
  const install = spawnSync(process.execPath, [cli, 'agents', 'install', 'generic'], {
    cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 300000,
  });
  const text = `${install.stdout}${install.stderr}`;
  console.log(`INFO \`canary agents install generic\` exit ${install.status}: ${text.trim().split('\n').slice(-3).join(' | ')}`);
  assert(install.status === 0, `\`canary agents install generic\` exited ${install.status}:\n${text}`);

  const target = path.join(temp, 'AGENTS.md');
  assert(fs.existsSync(target),
    `the install reported success but wrote no AGENTS.md; directory contains: `
    + `${fs.readdirSync(temp).join(', ') || '(nothing)'}`);
  const written = fs.readFileSync(target, 'utf8');
  const begin = '<!-- canary:advisory:v1';
  const block = written.slice(written.indexOf(begin), written.indexOf('<!-- /canary:advisory -->'));

  check('B1-the-advisory-block-canary-writes-does-not-teach-the-ceremony', () => {
    assert(block.length > 0, 'no marked advisory block was written');
    assert(!/canary\s+work|canary\s+finish/.test(block),
      `the block Canary installs into a project tells that project's agent to run the candidate ceremony:\n${block}`);
  });

  check('B2-the-advisory-block-carries-the-measured-instruction', () => {
    // The instruction MEASURED to produce the 92.7% shape: verification is automatic, so do not repeat a
    // check you have just run. The reliability half is deliberate (the aggressive variant, which forbade
    // self-verification outright, produced a false done AND a false green), so both halves are required.
    assert(/AUTOMATIC/i.test(block), 'the advisory block no longer says verification is automatic');
    assert(/do not repeat a check you have just run/i.test(block),
      'the advisory block no longer carries the sentence that was measured to produce the cheaper shape');
    assert(/unsure|being right matters/i.test(block),
      'the advisory block dropped the reliability half — the repository measured that forbidding '
      + 'self-verification outright produces a false done and a false green');
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 doc first path — the everyday path leads, and the costlier one is labelled`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.log(`FAIL v1.3 doc first path — ${String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
