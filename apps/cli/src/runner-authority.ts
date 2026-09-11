/**
 * THE PRODUCTION AUTHORITY SOURCE for a non-package runner's identity
 * (v1.1 Phase 2).
 *
 * The problem this solves: mocha is trusted because its bytes match a pin in THIS
 * repository. A Python interpreter cannot be pinned that way — its bytes differ per
 * machine — so the executor's `runnerIdentities` demands an explicit statement
 * ("this is the interpreter I authorized"), and until now nothing in the product
 * ever made one: the channel was built, wired and executed, but every Python spec
 * round still came out ABSENT because no production path granted an identity.
 *
 * The authority is the operator's own SEALED SETUP PLAN — the ONE moment (per
 * `pinPlanPrograms`) at which a human authorizes concrete programs, which seals
 * ABSOLUTE paths into `.canary/canary.local.json` with a plan digest and per-check
 * argv digests. Deriving the grant from it adds no new trust surface:
 *
 *  - the config must not be one Canary refuses to treat as local state
 *    (`untrustedConfigReason`: written by a different installation, or committed
 *    to the repo — a cloned config is not yours);
 *  - the plan must still match its own seal (`planAuthorityDrift`: plan digest,
 *    per-check argv digests, declared paths), so editing the plan after setup
 *    grants nothing — the recovery is a deliberate re-seal, not a silent edit;
 *  - only a step whose argv actually invokes a Python TEST RUNNER contributes, and
 *    the identity is Canary's own measurement of that interpreter's version and
 *    bytes. A step that merely runs `python script.py` authorizes nothing.
 *
 * Returns {} on ANY doubt. An empty grant is not an error: it is exactly the
 * fail-closed state in which the round records ABSENT and strong labels stay
 * unreachable — the honest outcome for a machine where nobody has run
 * `canary setup` for this project.
 *
 * This lives in its own module because `onboarding.ts` imports `pipeline.ts` for
 * `CANARY_VERSION`; the other direction would make the graph cyclic.
 */
import { PYTEST_RUNNER_ID, detectPythonRunner, pytestRunnerIdentity, pythonRunnerIdentity } from '@canary-rn/executor';

import { readConfig, untrustedConfigReason } from './onboarding.js';
import { planAuthorityDrift } from './project.js';

export type RunnerIdentityGrant = Record<string, { version: string; identitySha256: string }>;

export function runnerIdentitiesFromSealedPlan(repoRoot: string): RunnerIdentityGrant {
  const out: RunnerIdentityGrant = {};
  try {
    const cfg = readConfig(repoRoot);
    if (cfg === null || cfg === 'corrupt') return out;
    if (untrustedConfigReason(repoRoot, cfg) !== null) return out;
    if (planAuthorityDrift(repoRoot, cfg) !== null) return out;
    for (const step of cfg.plan) {
      if (step.argv === undefined) continue;
      const detected = detectPythonRunner(step.argv);
      if (detected === null) continue;
      // The same "the runner's own bytes" rule the executor applies: the
      // interpreter for `unittest`, the installed pytest distribution for pytest.
      const identity = detected.runner === PYTEST_RUNNER_ID
        ? pytestRunnerIdentity(detected.python)
        : pythonRunnerIdentity(detected.python);
      if (identity === null) continue;
      out[detected.runner] = { version: identity.version, identitySha256: identity.identitySha256 };
    }
  } catch { return out; }
  return out;
}
