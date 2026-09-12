/**
 * THE SECRET GUARD — stored benchmark artifacts must never carry a credential.
 *
 * A live API token was printed into a session log during environment discovery. Benchmark
 * artifacts store whatever an agent writes (final messages, stdout, stderr), and a model can
 * echo an environment value into its own report, so this is not a hypothetical: it is a
 * standing risk of running agents and keeping their words. The harness redacts on the way in
 * (`redact.mjs`), and this test is the OUT-OF-BAND check that the redaction actually held —
 * it reads what is on disk and fails if any credential shape survived.
 *
 * Scan scope: the artifacts this harness produces (results, reports, scratch logs under
 * _canary-data). It deliberately does NOT scan test sources, because `redact.test.mjs` must
 * contain FAKE credential shapes to prove the redactor works; anything that must carry a
 * sample is listed in ALLOWED with a reason.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { looksSecret } from './redact.mjs';

const BENCH = path.resolve(import.meta.dirname);
const REPO = path.resolve(BENCH, '..', '..');

/** Files allowed to contain credential SHAPES, with the reason they must. */
const ALLOWED = new Map([
  [path.join(BENCH, 'redact.test.mjs'), 'the redactor test asserts on fake samples'],
  [path.join(BENCH, 'redact.mjs'), 'the redactor describes the shapes it matches'],
]);

const ROOTS = [
  path.join(BENCH, 'results'),
  path.join(BENCH, 'scratch'),
  path.join(REPO, '_canary-data', 'evidence'),
];

/**
 * Paths the scan must skip, with the reason.
 *
 * MEASURED: a first version scanned everything under `_canary-data/evidence` and reported
 * eleven "credentials" — all of them vendored npm/Js docs inside a pinned Node distribution
 * that a test parks there (`.canary-pinned-host/.../node_modules/npm/...`). Those files talk
 * about tokens and passwords because that is what they are ABOUT. The guard exists to check
 * THIS harness's artifacts, not to audit a vendored runtime, and a guard that cries wolf is
 * a guard that gets switched off.
 */
const SKIP_DIRS = new Set(['node_modules', '.canary-pinned-host', '.git']);
const SKIP = (p) => [...SKIP_DIRS].some((d) => p.includes(`${path.sep}${d}${path.sep}`) || p.endsWith(`${path.sep}${d}`));

function walk(dir, out = []) {
  if (SKIP(dir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Text-ish files only: a binary artifact has no credential in a form worth grepping. */
const TEXT = /\.(json|md|txt|log|ndjson|jsonl|yaml|yml|cjs|mjs|js)$/i;

describe('stored benchmark artifacts carry no credentials', () => {
  const files = ROOTS.flatMap((r) => walk(r)).filter((f) => TEXT.test(f) && !ALLOWED.has(f));

  it('there is something to scan (an empty scan is not a pass)', () => {
    assert.ok(files.length > 0, `no artifacts found under ${ROOTS.join(', ')} — the guard would be vacuous`);
  });

  it('no artifact contains a credential shape', () => {
    const offenders = [];
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (looksSecret(text)) offenders.push(path.relative(REPO, f));
    }
    assert.deepEqual(offenders, [],
      `credential-shaped text found in stored artifacts (redact before storing):\n  ${offenders.join('\n  ')}`);
  });

  it('the scan really can see a planted secret (the guard is not blind)', () => {
    // A control: if this fails, the scan above proves nothing.
    const planted = `{"note":"ANTHROPIC_AUTH_TOKEN=zzzzzzzzzzzzzzzz"}`;
    assert.equal(looksSecret(planted), true, 'the guard must detect a credential shape in JSON');
  });
});
