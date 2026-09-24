/**
 * v1.5 — the focused regression for the two `canary provider status` changes.
 *
 * MEASURED before the change, on a host with no measured deployment: the six
 * control lines each printed ~430 characters that said one thing twice —
 *
 *   authorityCustody — the confined-caller deployment is not measured: no
 *   confined-caller deployment has been measured in this store (expected <path>);
 *   the record reports: no confined-caller deployment has been measured in this
 *   store (expected <path>); the identity path also leaves it unavailable: …
 *
 * — and the command never plainly answered the two questions a user has: "is
 * HARDENED real here?" and "was this host measured at all?".
 *
 * What these tests assert is deliberately about SEMANTICS, not wording where the
 * wording is prose: that the duplication is gone, that every required answer is
 * present, and — the part that matters for trust — that NO output claims
 * HARDENED while the controls are not measured. They do not snapshot the prose,
 * so the output can be improved again without rewriting them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dedupeReason } from '../src/provider/commands.js';

const repo = path.resolve(import.meta.dirname, '../../../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
/** A store that provably holds no deployment, so the answer is deterministic. */
const emptyStore = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-status-empty-'));
const run = (args: string[]) => spawnSync(process.execPath, [cli, 'provider', 'status', ...args], {
  cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  env: { ...process.env, CANARY_TRUST_STORE: emptyStore },
});

describe('dedupeReason collapses duplication and nothing else', () => {
  it('drops a clause whose payload was already stated', () => {
    const why = 'the deployment is not measured: no record in this store; '
      + 'the record reports: no record in this store; '
      + 'the identity path also leaves it unavailable: no worker identity is enrolled';
    const out = dedupeReason(why);
    assert.equal(out.match(/no record in this store/g)?.length, 1, out);
    // The DISTINCT clause must survive — dropping it would hide a real reason.
    assert.match(out, /no worker identity is enrolled/);
    assert.match(out, /^the deployment is not measured: /);
  });
  it('never drops a clause that carries new information', () => {
    const why = 'alpha: one; beta: two; gamma: three';
    assert.equal(dedupeReason(why), why);
  });
  it('keeps a payload-free clause unless it is itself a repeat', () => {
    assert.equal(dedupeReason('a reason with no colon; another reason'), 'a reason with no colon; another reason');
    assert.equal(dedupeReason('same text; same text'), 'same text');
  });
  it('is total on the shapes the boundary actually emits', () => {
    assert.equal(dedupeReason(''), '');
    assert.equal(dedupeReason('single clause'), 'single clause');
    // A shorter payload that is a substring of a kept clause is still a repeat.
    assert.equal(dedupeReason('outer: the store is absent; other: store is absent'), 'outer: the store is absent');
  });
});

describe('provider status tells the truth without a measured deployment', () => {
  const r = run(['--json']);

  it('never reads READY or HARDENED, and exits non-zero', () => {
    assert.equal(r.status, 2, r.stderr);
    const envelope = JSON.parse(r.stdout);
    assert.equal(envelope.schema, 'canary-provider-status/1');
    assert.equal(envelope.status, 'NOT CONNECTED');
    assert.notEqual(envelope.security.level, 'HARDENED');
    assert.equal(envelope.exitCode, 2);
  });

  it('reports the missing prerequisite and the unmeasured state explicitly', () => {
    const envelope = JSON.parse(r.stdout);
    assert.equal(envelope.provider.hardenedAvailable, false);
    assert.equal(envelope.provider.controlsTotal, 6);
    assert.equal(envelope.provider.controlsAvailable, 0);
    assert.equal(envelope.provider.controlsMissing.length, 6);
    // Nothing is measured in an empty store: this is the field a consumer must
    // read instead of inferring a boundary from the presence of primitives.
    assert.equal(envelope.provider.deploymentMeasured, null);
  });

  it('keeps host primitives and activation strictly separate', () => {
    const envelope = JSON.parse(r.stdout);
    // `hostPrimitives` records what the host OFFERS. On Windows the sandbox
    // primitive is observed, and that observation alone must never be readable
    // as HARDENED — the two fields are independent on purpose.
    if (process.platform === 'win32') assert.equal(envelope.provider.hostPrimitives, 'win32-appcontainer-restricted-low');
    assert.equal(envelope.provider.hardenedAvailable, false);
  });

  it('stdout carries exactly one envelope', () => {
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, r.stdout);
    assert.doesNotThrow(() => JSON.parse(lines[0]!));
  });
});

describe('provider status answers the user in compact form by default', () => {
  const r = run([]);

  it('states level, measurement state, the missing prerequisite and the next action', () => {
    assert.equal(r.status, 2);
    const human = r.stdout;
    assert.match(human, /security level\s+LOCAL/);
    assert.match(human, /boundary controls 0 of 6 available/);
    assert.match(human, /measured here\s+NO/);
    // Every control that is missing must be NAMED — a count alone is not a reason.
    for (const control of ['authorityCustody', 'workerFilesystem', 'verificationSandbox',
      'authenticatedReview', 'protectedPromotion', 'networkEgress']) {
      assert.ok(human.includes(control), `missing control not named: ${control}`);
    }
    assert.match(human, /tooling\/probes\/v12-confined-caller\.mjs/);
    assert.match(human, /canary provider install-plan/);
  });

  it('does NOT claim HARDENED while no control is measured', () => {
    const human = run([]).stdout;
    assert.doesNotMatch(human, /HARDENED — every boundary control is measured available/);
    assert.doesNotMatch(human, /^\s*HARDENED\b/m);
    assert.match(human, /HARDENED is NOT available here/);
  });

  it('is compact: the default output does not carry the raw per-control essays', () => {
    const human = run([]).stdout;
    // The verbose reasoning quotes the record path inside a per-control line;
    // the default output must not repeat it six times.
    assert.doesNotMatch(human, /the record reports:/);
    const longest = Math.max(...human.split('\n').map((l) => l.length));
    assert.ok(longest < 200, `default output has a ${longest}-char line; the detail belongs behind --verbose`);
  });

  it('keeps every per-control reason available behind --verbose', () => {
    const verbose = run(['--verbose']).stdout;
    assert.match(verbose, /boundary controls \(each derived from the measured deployment, never from configuration\)/);
    assert.match(verbose, /identity-path controls \(what an ELEVATED install would add; NOT evidence on this host\)/);
    assert.match(verbose, /sandbox:\s+win32-appcontainer-restricted-low|sandbox:\s+none/);
    // Nothing was deleted from the reasoning: the distinct clause survives.
    assert.match(verbose, /the identity path also leaves it unavailable/);
  });
});
