// Independent audit reproductions. No product changes; disposable stores only.
// Run v12-confined-caller.mjs first to supply live confined observations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as CM from '../../apps/cli/dist/src/provider/confined-measurement.js';
import { measureBoundary } from '../../apps/cli/dist/src/provider/boundary.js';
import { measuredCapabilities } from '../../apps/cli/dist/src/platform-boundary.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-independent-audit-'));
let findings = 0;
function finding(name, condition) {
  console.log(`${condition ? 'REPRODUCED' : 'NOT REPRODUCED'} ${name}`);
  if (condition) findings++;
}
try {
  const labelProbe = fileURLToPath(new URL('../test-support/fixtures/audit-pipe-label.ps1', import.meta.url));
  const labelRun = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', labelProbe],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (labelRun.status !== 0) throw new Error('pipe-label native diagnostic failed');
  const label = JSON.parse(labelRun.stdout.trim());
  console.log(`PIPE LABEL: original DWORD=${label.originalDWORD}, corrected DWORD=${label.correctedDWORD}`);
  finding('broker accepts a failed native pipe-label call as success',
    !label.missingRejected || !label.readbackVerified || label.correctedDWORD !== 0);
  const journal = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'v12-confined-caller.json'), 'utf8'));
  const arm = journal.arms.confinedBroker;
  if (arm.exit !== 0 || !arm.side.appContainer || !arm.side.restricted || arm.side.capabilities !== 0)
    throw new Error('no real confined broker conversation; findings cannot be credited');
  const exchanges = arm.report.broker;
  const response = id => exchanges.find(x => x.id === id)?.response?.verification;
  const disclosed = response('review')?.content;
  // The unrestricted positive control recorded the original file bytes before its own write.
  const original = journal.arms.control.attempts.find(x => x.id === 'trusted-store-read');
  finding('confined review endpoint disclosed the protected custody-file bytes',
    original.executed && original.result === 'ALLOWED' && typeof disclosed === 'string' && disclosed === original.value);
  const body = 'confined-promotion-body-' + arm.report.nonce;
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const reviewedDigest = response('review')?.receipt?.split('|')[1];
  finding('caller-selected body was signed and promoted without being the reviewed artifact',
    reviewedDigest !== digest && response('signature-request')?.payload === digest
      && typeof response('signature-request')?.signature === 'string'
      && response('promote-valid')?.receipt?.accepted === true);

  // These are validator counterexamples, not newly executed isolation attacks.
  // The key is what the real confined review endpoint just disclosed. Never print it.
  // Retest validation even after disclosure is repaired: grant the attacker the old
  // key as a stronger control. This is deliberately not a new isolation claim.
  const attackerKey = typeof disclosed === 'string' ? disclosed : original.value;
  fs.writeFileSync(path.join(root, 'custody-key-material.txt'), attackerKey);
  function record() {
    return {
      schema: CM.CONFINED_RECORD_SCHEMA, source: CM.CONFINED_RECORD_SOURCE,
      measuredAt: new Date().toISOString(), platform: process.platform,
      host: { hostname: os.hostname(), user: os.userInfo().username }, storeRoot: root,
      callerPackage: arm.side.package,
      broker: { identity: 'audit-placeholder', name: 'audit-placeholder', isSystem: false },
      tools: { digest: CM.toolsDigest(), files: [...CM.CONFINED_TOOL_PATHS] },
      corpus: { corpus: 'audit', digest: 'audit', files: 0 },
      battery: { pass: 0, fail: 0, inconclusive: 0, durationMs: 0 },
      deployment: { complete: true, failures: [], facts: {
        required: Object.fromEntries(CM.REQUIRED_DEPLOYMENT_FACTS.map(name => [name, true])),
        separateBrokerIdentity: false, brokerIdentity: 'audit-placeholder', brokerName: 'audit-placeholder',
        brokerAccountIsCaller: true, callerIdentity: 'audit-placeholder', callerName: 'audit-placeholder'
      } },
      controls: CM.completeControls(CM.ALL_CONTROLS.map(control => ({ control,
        subject: 'audit counterexample', positiveControl: 'assertion', attack: 'assertion',
        denial: 'assertion', observed: { unrelatedField: true }
      })))
    };
  }
  function level(r) {
    CM.writeConfinedMeasurement(r, root);
    return measuredCapabilities(measureBoundary({ root }, {})).level;
  }
  finding('unrelated observations with zero executed attacks activate HARDENED', level(record()) === 'HARDENED');
  const future = record(); future.measuredAt = '2099-01-01T00:00:00.000Z';
  finding('future-dated signed measurement activates HARDENED', level(future) === 'HARDENED');
  const failed = record(); failed.battery.fail = 1; failed.battery.inconclusive = 1;
  failed.deployment.failures = ['audit failure'];
  finding('signed failed/inconclusive battery activates HARDENED', level(failed) === 'HARDENED');
  const copied = record(); copied.storeRoot = path.join(root, 'other-store');
  fs.mkdirSync(copied.storeRoot);
  // Rebinding and resigning uses only material returned to the confined caller.
  fs.writeFileSync(path.join(copied.storeRoot, 'custody-key-material.txt'), attackerKey);
  CM.writeConfinedMeasurement(copied, copied.storeRoot);
  finding('disclosed custody material can activate a different, unmeasured store',
    measuredCapabilities(measureBoundary({ root: copied.storeRoot }, {})).level === 'HARDENED');
  console.log(`Concrete findings reproduced: ${findings}/7; secrets omitted from output.`);
  console.log('These seven checks do not prove production integration, policy-causal egress, or replacement measurement custody.');
  process.exitCode = findings ? 1 : 0;
} catch (e) { console.error(`AUDIT INFRASTRUCTURE FAILURE: ${e.message}`); process.exitCode = 2; }
finally { fs.rmSync(root, { recursive: true, force: true }); }
