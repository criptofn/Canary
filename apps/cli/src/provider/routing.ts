/**
 * PROVIDER-ONLY ROUTING for the two acts that can change the trusted base
 * (v1.1 Phase 3, item 4).
 *
 * THE HOLE THIS CLOSES: `accept` and promote were LOCAL, writable acts. On a
 * machine with a provider installed that is a bypass of the entire boundary — the
 * broker could hold the reviewer key, the kernel could refuse to mint it, and the
 * CLI would still let the same user write the acceptance record and
 * fast-forward the base. A security design whose enforcing process can be stepped
 * around by the process it is protecting is a design on paper.
 *
 * THE RULE, and it is deliberately a RULE rather than a preference: when a provider
 * is CONFIGURED here, these acts are minted by the broker or they do not happen.
 * There is no fallback, no retry against a local path, and no "provider was
 * unreachable so we did it ourselves" — every failure below is a refusal that
 * leaves the base untouched. When NO provider is configured, the ordinary local
 * behaviour is byte-for-byte what it was, so a machine without a provider is
 * unaffected (which is also why this cannot silently change v1.0 outcomes).
 *
 * What "configured" means is NOT re-decided here: `providerConfigured` is the one
 * definition (an enrolled worker identity is declared, or a broker token exists in
 * the store), and this module only asks it.
 *
 * WHAT EACH REFUSAL MEANS — the caller must surface the code, because they are
 * different facts and only one of them is a security event:
 *   connect-failed / timeout   no broker is running (activation incomplete)
 *   unauthorized               the caller does not hold this installation's token
 *                              (a token mismatch, or a store readable by someone
 *                              who should not have it)
 *   stale-generation           the broker serves a different authority generation,
 *                              so the ticket this act would consume cannot be
 *                              replayed into it
 *   candidate-mismatch         the broker's enrolled subject is a different
 *                              candidate or base than the one being acted on
 *   stale-proof                the broker holds no current passing verification
 *                              for this subject (the proof expired or never was)
 *   authority-mismatch         the subject/project the broker is bound to is not
 *                              this repository
 *   runner-not-installed /     the broker refuses to produce the statement at all
 *   no-restricted-runner       (measured: no separated runner identity exists yet)
 */
import fs from 'node:fs';

import { storeFromEnv, type TrustStore } from '../trust-store.js';
import { providerConfigured } from './boundary.js';
import { callProvider } from './service.js';
import { IpcError } from './ipc.js';

/** Is a broker required for base-changing acts on this machine? */
export function brokerRoutingRequired(
  store: TrustStore = storeFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return providerConfigured(store, env);
}

/** Where an installation records the authority generation it is serving. */
export function authorityGenerationPath(storeRoot: string): string {
  return `${storeRoot}/authority-generation`;
}

/**
 * The generation THIS side believes is current.
 *
 * Read from the store's own record rather than assumed, and deliberately allowed to
 * be absent: an installation that never recorded one makes no staleness claim, and
 * the broker's other refusals still apply. Claiming a generation Canary did not
 * record would be inventing the very fact the check exists to compare.
 */
export function expectedAuthorityGeneration(store: TrustStore = storeFromEnv()): string | undefined {
  try {
    const trimmed = fs.readFileSync(authorityGenerationPath(store.root), 'utf8').trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

export type BrokerRefusalCode =
  | 'connect-failed' | 'timeout' | 'unauthorized' | 'stale-generation'
  | 'candidate-mismatch' | 'stale-proof' | 'authority-mismatch'
  | 'runner-not-installed' | 'no-restricted-runner' | 'broker-error';

export type BrokerRouteOutcome =
  | { routed: true; ok: true; result: unknown }
  | { routed: true; ok: false; code: string; message: string }
  | { routed: false };

/** One call to the broker, with every transport failure mapped to a refusal code. */
async function route(
  op: 'broker.submit-acceptance' | 'broker.reserve-promotion' | 'broker.reconcile',
  req: { projectId: string; candidate?: string | undefined },
  store: TrustStore,
): Promise<BrokerRouteOutcome> {
  if (!brokerRoutingRequired(store)) return { routed: false };
  const generation = expectedAuthorityGeneration(store);
  try {
    const result = await callProvider({
      op,
      projectId: req.projectId,
      ...(req.candidate !== undefined ? { candidate: req.candidate } : {}),
      ...(generation !== undefined ? { authorityGeneration: generation } : {}),
    }, store);
    return { routed: true, ok: true, result };
  } catch (e) {
    const code = e instanceof IpcError ? e.code : 'broker-error';
    return { routed: true, ok: false, code, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask the broker to mint the human-review statement. Never writes locally. */
export function submitAcceptanceThroughBroker(
  req: { projectId: string; candidate: string },
  store: TrustStore = storeFromEnv(),
): Promise<BrokerRouteOutcome> {
  return route('broker.submit-acceptance', req, store);
}

/**
 * Reserve the promotion window AFTER a passing verification. The returned
 * `candidateCommit`/`expectedHead` are compared with Canary's own live identity by
 * the caller — a broker that authorizes a DIFFERENT candidate must not authorize
 * this act, and vice versa.
 */
export function reservePromotionThroughBroker(
  req: { projectId: string; candidate: string },
  store: TrustStore = storeFromEnv(),
): Promise<BrokerRouteOutcome> {
  return route('broker.reserve-promotion', req, store);
}

/** Reconcile after the apply, so an interrupted promotion is visible next time. */
export function reconcilePromotionThroughBroker(
  req: { projectId: string; candidate: string },
  store: TrustStore = storeFromEnv(),
): Promise<BrokerRouteOutcome> {
  return route('broker.reconcile', req, store);
}

/** What the caller must say about a refusal. One line, code first, never softened. */
export function refusalText(code: string, message: string): string {
  const meaning: Record<string, string> = {
    'connect-failed': 'the broker is not running (provider activation is incomplete)',
    'timeout': 'the broker did not answer in time',
    'unauthorized': 'this process does not hold the installation token the broker requires',
    'stale-generation': 'the broker serves a different authority generation than the one recorded here',
    'candidate-mismatch': 'the broker is bound to a different candidate or base than this one',
    'stale-proof': 'the broker holds no current passing verification for this subject',
    'authority-mismatch': 'the broker is bound to a different project than this repository',
    'runner-not-installed': 'the broker has no restricted runner installed, so it refuses to produce the statement',
    'no-restricted-runner': 'no separated runner identity is enrolled, and the broker will not run candidate code as itself',
  };
  return `${code}${meaning[code] !== undefined ? ` (${meaning[code]})` : ''}: ${message}`;
}
