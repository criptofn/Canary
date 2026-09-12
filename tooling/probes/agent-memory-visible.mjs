#!/usr/bin/env node
/**
 * IS THE "PLAIN" ARM ACTUALLY PLAIN? — global agent memory, measured.
 *
 * The benchmark's plain arm is the baseline the token claim is measured against, so it must not
 * carry guidance the other arm does not. `--setting-sources project,local` removes user SETTINGS
 * (hooks, plugins, the API env block, which the harness forwards explicitly), but the machine also
 * has a global `~/.claude/CLAUDE.md` — agent MEMORY, a different mechanism — and that file mentions
 * Canary and says to "avoid redundant self-verification when deterministic project tooling or
 * Canary can perform the same check independently". That is, almost word for word, the instruction
 * the `invisible` arm is supposed to be measured against.
 *
 * MEASURED evidence that this is not hypothetical: one plain-arm trial invoked `canary status`
 * (bench-r6-cross-file-refactor-plain-1), a command nothing in that fixture mentions.
 *
 * This probe asks the model itself, in a throwaway project, whether it was given project-specific
 * notes about other repositories:
 *   - run A: exactly the benchmark's environment;
 *   - run B: the same, with the CLI's config home redirected to an empty temp dir (the candidate
 *     fix — it must still authenticate from the FORWARDED env, which is what run B checks).
 * It reports whether memory surfaced, whether the redirected run works at all, and its token cost.
 *
 * MEASURED RESULT, which is why the confound is DISCLOSED rather than fixed: run A quoted the
 * machine-global memory verbatim, and run B — with HOME/USERPROFILE/HOMEDRIVE/HOMEPATH pointed at
 * an empty temp directory — quoted the SAME file. Redirection does not remove it. The one remaining
 * mechanism that does (`--bare`) also skips HOOKS, which is the protected arm's entire gate, so it
 * cannot be used here.
 *
 * What that means for the token claim, stated where it belongs: BOTH arms see this memory, so the
 * arm-to-arm comparison stays internally valid — but the "plain" arm is not a Canary-naive user.
 * It already carries "avoid redundant self-verification when deterministic project tooling or Canary
 * can perform the same check independently", i.e. a rough paraphrase of the invisible arm's own
 * instruction, and one plain trial really did invoke `canary status`. If anything that makes the
 * measured saving an UNDER-estimate of what a naive user would see, and it is reported as such.
 *
 * Usage: node tooling/probes/agent-memory-visible.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Exactly what run-trial.mjs does: the API env lives in user settings, so it is forwarded. */
function forwardedEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const keys = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    for (const [k, v] of Object.entries(s.env ?? {})) if (typeof v === 'string' && v !== '' && !env[k]) { env[k] = v; keys.push(k); }
  } catch { /* no user settings */ }
  return { env, keys };
}

const PROMPT = [
  'Before this message, were you given any project-specific notes about repositories or directories',
  'OTHER than the current working directory (for example notes naming a drive path, a worktree, a',
  'stop gate or a verification tool)? If yes, quote the relevant lines verbatim. If no, reply exactly:',
  'NONE.',
].join(' ');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-memory-'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'memory-probe', private: true }, null, 2)}\n`);
  return root;
}

function session({ redirectHome }) {
  const root = project();
  const { env, keys } = forwardedEnv();
  const childEnv = { ...env };
  if (redirectHome) {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fakehome-'));
    childEnv.HOME = fakeHome;
    childEnv.USERPROFILE = fakeHome;
    childEnv.HOMEDRIVE = path.parse(fakeHome).root.replace(/\\$/, '');
    childEnv.HOMEPATH = fakeHome.slice(path.parse(fakeHome).root.length - 1);
  }
  const r = spawnSync('claude', ['-p', PROMPT, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--setting-sources', 'project,local',
    '--allowedTools', 'Read'], { cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true, env: childEnv });
  const events = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line)); } catch { /* not the question */ }
  }
  const result = events.find((e) => e?.type === 'result') ?? null;
  const u = result?.usage ?? {};
  const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const text = String(result?.result ?? '').trim();
  fs.rmSync(root, { recursive: true, force: true });
  return { status: r.status, stderr: (r.stderr ?? '').trim(), sawResult: result !== null, tokens, text, keys };
}

const REAL_MEMORY_MARKERS = [/canary-reliability-network/i, /stop gate/i, /worktree/i, /redundant self-verification/i, /Canary/i];

console.log('run A — the benchmark environment as it is today');
const a = session({ redirectHome: false });
console.log(`  exit ${a.status}; result ${a.sawResult ? 'yes' : 'NO'}; tokens ${a.tokens}; forwarded env keys ${a.keys.length}`);
console.log(`  answer: ${a.text.slice(0, 500).replace(/\n/g, ' | ')}`);
const aHits = REAL_MEMORY_MARKERS.filter((re) => re.test(a.text)).map(String);
console.log(`  memory markers in the answer: ${aHits.length === 0 ? 'none' : aHits.join(', ')}`);

console.log('\nrun B — the same, with the CLI config home redirected to an empty temp dir');
const b = session({ redirectHome: true });
console.log(`  exit ${b.status}; result ${b.sawResult ? 'yes' : 'NO'}; tokens ${b.tokens}`);
console.log(`  answer: ${b.text.slice(0, 500).replace(/\n/g, ' | ')}`);
if (b.status !== 0 && b.stderr !== '') console.log(`  stderr: ${b.stderr.slice(0, 300)}`);
const bHits = REAL_MEMORY_MARKERS.filter((re) => re.test(b.text)).map(String);
console.log(`  memory markers in the answer: ${bHits.length === 0 ? 'none' : bHits.join(', ')}`);

check('1. the run is usable at all (a baseline cannot be measured if the arm cannot run)', () => {
  assert(a.sawResult, `run A produced no result event: ${a.stderr.slice(0, 200)}`);
});

check('2. the confound is REPORTED, whichever way it falls', () => {
  console.log(aHits.length > 0
    ? `      → MEASURED: the plain arm can see machine-global agent memory (${aHits.join(', ')}); the baseline is therefore not neutral and the token delta is measured against a baseline that already knows about Canary`
    : '      → no global memory surfaced in this run; the baseline looks clean here (one run, one model — not proof)');
});

check('3. redirecting the CLI config home changes nothing about the memory (auth still works)', () => {
  assert(b.sawResult, `the redirected run produced no result event, so it proves nothing: ${b.stderr.slice(0, 200)}`);
  assert(b.tokens > 0, 'the redirected run reported no tokens');
  // MEASURED: run B quoted the SAME `~/.claude/CLAUDE.md` sections — the CLI resolves that path
  // without consulting HOME/USERPROFILE, so redirection is NOT a fix for this confound. The probe
  // states it rather than leaving a half-fix that looks like one.
  if (bHits.length > 0) {
    console.log(`      → NOT a fix: the redirected run still quoted the machine-global memory (${bHits.join(', ')}); the confound must be disclosed, not silenced`);
  } else {
    console.log('      → the redirected run saw no memory markers on this attempt; re-run before treating redirection as a fix (one run is not proof)');
  }
});

console.log(`\n=== agent memory visibility: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
