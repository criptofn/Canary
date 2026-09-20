// v1.3 §23 — HOW LONG DOES THE PROJECT'S OWN CHECK TAKE? (the number B2 assumed instead of measuring)
//
// The confined-transport analysis concluded that returning the project's own check result after each
// `implement` batch would blow the transport's 15-minute ceiling. That conclusion rested on an ASSUMPTION
// written into the probe as if it were a fact — "a suite that takes a minute" — and the assumption was
// never measured. It matters, because the fixtures' checks are small and fast, and the worker's own 36
// `exec` calls each cost a full model turn (~34 s at the recorded pace). If the check itself is cheap, the
// round trips are the expense and auto-running it costs seconds, not minutes — which would REOPEN the
// design rather than close it.
//
// So this probe measures the cost input directly: materialise the fixture the way the harness does (into
// its own directory, outside this repository, whose package.json says "type": "module" and would otherwise
// decide how the fixture's CommonJS files are parsed), then time the check the manifest declares.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(repo, 'tooling/benchmark/fixtures/stateful-replay/project');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-suite-cost-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The transport's ceiling, read from the source so it cannot drift away from this probe. */
function ceilingMs() {
  const src = fs.readFileSync(path.join(repo, 'apps/cli/src/provider/model-transport.ts'), 'utf8');
  const m = /(\d+)\s*\*\s*60000/.exec(src);
  assert(m, 'model-transport.ts no longer expresses its timeout as <n> * 60000');
  return Number(m[1]) * 60000;
}

const timeIt = (argv, cwd) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ms, status: r.status, all, tail: all.split('\n').slice(-1)[0] ?? '' };
};

try {
  // Materialise the fixture into its OWN directory, as the harness does.
  fs.cpSync(fixture, temp, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'canary.project.json'), 'utf8'));
  const declared = manifest.scopes?.[0]?.checks?.[0];
  assert(declared?.argv, 'the fixture manifest declares no check argv');

  console.log(`INFO materialised ${path.basename(fixture)} -> ${temp}`);
  console.log(`INFO declared check: ${declared.argv.join(' ')}`);

  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(timeIt(declared.argv, temp));
  for (const r of runs) console.log(`INFO   ${declared.argv.join(' ')} -> ${r.ms.toFixed(0)} ms, exit ${r.status}`);
  if (runs.some((r) => r.status !== 0)) {
    // Print the HEAD, not the tail: Node puts the cause first and the version footer last, and a probe
    // that shows only the footer reports "something failed" about a failure it could have explained.
    console.log('INFO   the failure, in full (first 12 lines):');
    for (const l of runs.at(-1).all.split('\n').slice(0, 12)) console.log(`INFO     ${l}`);
  }

  // The number that decides the design: steady-state cost of one check run.
  const steady = runs.slice(1).map((r) => r.ms);
  const perRun = steady.reduce((a, b) => a + b, 0) / steady.length;
  console.log(`INFO steady-state cost of ONE check run: ${perRun.toFixed(0)} ms`);

  const ceiling = ceilingMs();
  // The recorded long confined run, from the pilot's own record.
  const rec = JSON.parse(fs.readFileSync(path.join(repo,
    'tooling/benchmark/results/session-evidence/v13edit-stateful-replay-canary-1.json'), 'utf8'));
  const observed = rec.durationMs;
  const headroom = ceiling - observed;
  const toolRequests = rec.agentResult?.toolRequests ?? null;
  console.log(`INFO transport ceiling ${(ceiling / 60000).toFixed(0)} min; recorded run ${(observed / 60000).toFixed(2)} min; headroom ${(headroom / 1000).toFixed(0)} s`);
  console.log(`INFO tool requests in that run: ${toolRequests}`);

  const worstCase = perRun * (toolRequests ?? 0);
  console.log(`INFO worst case if the check ran after EVERY tool request (${toolRequests}): ${(worstCase / 1000).toFixed(1)} s`);
  const share = 100 * worstCase / ceiling;
  console.log(`INFO that is ${share.toFixed(1)}% of the ceiling`);

  check('A1-the-declared-check-RUNS-in-a-materialised-fixture', () => {
    // NOT "does it pass". The fixture ships UNSOLVED on purpose — `'two' !== 'one'` is the assertion the
    // worker is there to fix — so demanding exit 0 asked the fixture to be something it is not, and the
    // first version of this probe failed for that reason. The question that decides whether a timing is
    // usable is whether the check EXECUTED: a real result (pass or assertion failure) is usable; a module
    // resolution or syntax error means the fixture was materialised wrong and the timing means nothing.
    for (const r of runs) {
      for (const broken of ['ReferenceError', 'ERR_MODULE', 'Cannot find module', 'SyntaxError']) {
        assert(!r.all.includes(broken),
          `the check did not execute — ${broken} in a materialised fixture:\n${r.all.split('\n').slice(0, 6).join('\n')}`);
      }
      assert(r.status === 0 || r.all.includes('AssertionError'),
        `the check neither passed nor failed an assertion (exit ${r.status}): ${r.all.split('\n').slice(0, 6).join(' | ')}`);
    }
    const failing = runs.filter((r) => r.status !== 0).length;
    console.log(`INFO   executed cleanly on all ${runs.length} run(s); ${failing} ended in an assertion failure `
      + '(the fixture ships unsolved, which is the task)');
  });

  check('B1-the-per-batch-design-is-affordable-in-WALL-CLOCK-terms', () => {
    // THE ASSERTION THAT REOPENS OR CLOSES THE DESIGN. It fails if running the check after every request
    // would consume a meaningful slice of the ceiling — which is the claim B2 made from an assumption.
    assert(share < 50,
      `running the declared check after every one of ${toolRequests} tool requests costs ${(worstCase / 1000).toFixed(1)} s `
      + `= ${share.toFixed(1)}% of the transport ceiling. That is too much headroom to spend, so the per-batch `
      + 'design stays withdrawn');
    console.log(`INFO   affordable: ${(worstCase / 1000).toFixed(1)} s against ${(headroom / 1000).toFixed(0)} s of headroom`);
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 transport suite cost — measured, not assumed`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.log(`FAIL v1.3 transport suite cost — ${String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
