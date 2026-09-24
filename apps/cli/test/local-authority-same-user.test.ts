/**
 * v1.5 audit finding — LOCAL IS NOT WORKER-INDEPENDENT, AND THE UI MUST SAY SO.
 *
 * The auditor reproduced that a worker can run `canary setup --yes` and re-seal its own
 * commit and plan at LOCAL. That is EXPECTED onboarding behaviour at LOCAL — `cmdSetup` has
 * never checked the caller's identity — but it is a CLAIM TOO STRONG if any surface a user or
 * an agent reads describes LOCAL proof as independent of the worker.
 *
 * So this file asserts the DIFFERENTIATION, semantically rather than by prose:
 *
 *   - the level a same-user host gets is LOCAL, and its text states the same-user limit AND
 *     the route that makes it true (the caller can re-run `canary setup` and change what is
 *     checked), and denies worker-independence in words;
 *   - HARDENED is the level that adds a separate OS identity, it is only ever produced by a
 *     MEASUREMENT in which every boundary control is available, and the same text surface
 *     says it is not available here;
 *   - the two levels' statements are mutually exclusive: the LOCAL text claims same-user, the
 *     HARDENED text claims the opposite, and neither can be substituted for the other.
 *
 * Exact wording is deliberately NOT pinned: these assertions are about what the text MEANS,
 * so the claims can be re-phrased without weakening the test — but they cannot be removed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-local-claim-'));
process.env.CANARY_TRUST_STORE = path.join(TMP, 'store');

import { localCapabilities, measuredCapabilities, type BoundaryControl } from '../src/platform-boundary.js';
import { proofLevelLine } from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);
const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CONTROL_NAMES: BoundaryControl[] = [
  'authorityCustody', 'workerFilesystem', 'verificationSandbox',
  'authenticatedReview', 'protectedPromotion', 'networkEgress',
];
const controls = (available: BoundaryControl[]): Record<BoundaryControl, { available: boolean }> =>
  Object.fromEntries(CONTROL_NAMES.map((c) => [c, { available: available.includes(c) }])) as Record<BoundaryControl, { available: boolean }>;

function makeProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // findRepoRoot only needs .git presence
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name, scripts: { test: `node "${path.join(FIXTURES, 'f-pass.js')}"` },
  }, null, 2));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}
const canary = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 180_000 });

describe('v1.5 audit — the UI tells the truth about who chose what is checked', () => {
  const root = makeProject('local-claim');
  const setup = canary(['setup', '--yes'], root);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);

  it('a same-user host reports LOCAL, with the same-user limit and the re-seal route in the text it prints', () => {
    const status = canary(['status'], root);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const line = status.stdout.split(/\r?\n/).find((l) => /proof level:/i.test(l));
    assert.ok(line, `status printed no level line:\n${status.stdout}`);
    assert.match(line, /\bLOCAL\b/, `the level line does not name the level: ${line}`);
    // semantics: the same user that runs the worker, and the route that makes it true
    assert.match(line, /same[- ]user|same user account|same uid/i, `the level line does not name the same-user limit: ${line}`);
    assert.match(line, /canary setup/, `the level line does not name the re-seal route: ${line}`);
    assert.match(line, /not worker-independent|NOT worker-independent/i, `the level line does not deny worker-independence: ${line}`);
    assert.match(line, /HARDENED/, `the level line does not name the worker-independent level: ${line}`);
    // and it must not claim the opposite of what is true on this host
    assert.doesNotMatch(line, /proof is worker-independent|worker cannot|cannot re-run|is protected from the worker/i,
      `the level line claims protection LOCAL does not provide: ${line}`);
  });

  it('doctor prints the same LOCAL limit (the gate a worker meets most often says who selected the plan)', () => {
    const doctor = canary(['doctor'], root);
    const line = doctor.stdout.split(/\r?\n/).find((l) => /proof level:/i.test(l));
    assert.ok(line, `doctor printed no level line:\n${doctor.stdout}`);
    assert.match(line, /same[- ]user|same user account|same uid/i, `doctor's level line omits the same-user limit: ${line}`);
    assert.match(line, /canary setup/, `doctor's level line omits the re-seal route: ${line}`);
  });

  it('the machine channel carries the same claim, so an agent reading --json is not told more than is true', () => {
    const status = canary(['status', '--json'], root);
    const env = JSON.parse(status.stdout) as { security?: { level?: string; reasons?: string[] } };
    assert.equal(env.security?.level, 'LOCAL', JSON.stringify(env.security));
    const reasons = env.security?.reasons ?? [];
    assert.ok(reasons.some((r) => /same uid|same user/i.test(r)),
      `no reason names the same-user limit: ${JSON.stringify(reasons)}`);
    assert.ok(reasons.some((r) => /canary setup/.test(r) && /(re-?seal|plan and baseline)/i.test(r) && /not worker-independent/i.test(r)),
      `no reason names the re-seal route AND denies worker-independence: ${JSON.stringify(reasons)}`);
    assert.ok(reasons.some((r) => /HARDENED/.test(r) && /different identity/i.test(r) && /NOT claimed|not claimed/i.test(r)),
      `no reason names HARDENED as the different-identity path: ${JSON.stringify(reasons)}`);
  });

  it('LOCAL and HARDENED are different statements, and neither can stand in for the other', () => {
    const localText = proofLevelLine('LOCAL');
    const hardenedText = proofLevelLine('HARDENED');
    assert.notEqual(localText, hardenedText);
    assert.match(localText, /same[- ]user|same user account|same uid/i);
    assert.match(localText, /not worker-independent|NOT worker-independent/i);
    assert.doesNotMatch(hardenedText, /same[- ]user|same user account|same uid/i,
      `the HARDENED statement must not carry the same-user limit: ${hardenedText}`);
    assert.match(hardenedText, /separate OS identity/i, 'the HARDENED statement must name what makes it different');
  });

  it('HARDENED is produced by a measurement of EVERY control, never by a claim (and is unreachable here)', () => {
    // Local installation: same uid, no provider — all six controls unavailable, so LOCAL.
    assert.equal(localCapabilities(true).level, 'LOCAL');
    assert.equal(localCapabilities(true).unavailable.length, CONTROL_NAMES.length);
    assert.equal(localCapabilities(false).level, 'ADVISORY');

    // One missing control keeps the level where the local store puts it (LOCAL, never HARDENED).
    const five = measuredCapabilities({ storeExists: true, controls: controls(CONTROL_NAMES.slice(0, 5)) });
    assert.equal(five.level, 'LOCAL');
    assert.deepEqual(five.unavailable, ['networkEgress']);

    // And the level HARDENED names is only reachable when the measurement itself says so.
    const all = measuredCapabilities({ storeExists: true, controls: controls(CONTROL_NAMES) });
    assert.equal(all.level, 'HARDENED');
    assert.deepEqual(all.unavailable, []);

    // The same-user host this test runs on is LOCAL: nothing measured a separate identity here.
    const status = canary(['status', '--json'], root);
    assert.notEqual((JSON.parse(status.stdout) as { security?: { level?: string } }).security?.level, 'HARDENED',
      'this host reports HARDENED, so the LOCAL claim above is not the one being made here');
  });
});
