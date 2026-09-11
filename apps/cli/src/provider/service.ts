/**
 * The Canary provider service — the trusted side of the HARDENED boundary
 * (v1.1 Phase 3).
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO KEEP: the privileged broker NEVER
 * executes candidate or project code with its own identity. Verification runs in
 * a RESTRICTED RUNNER (a separate account), and if that identity is not
 * available the service refuses the work — it does not fall back to running it
 * itself. Everything else here is plumbing around that rule.
 *
 * IT REFUSES TO START WITHOUT A PROVEN BOUNDARY. `measureBoundary()` must show
 * that the store is not writable by the worker, that a broker service runs as an
 * account which is not the caller's, and that a worker identity is enrolled. If
 * even one control is missing the service prints exactly which and exits 2 —
 * because a broker that runs without the separation is a single-process Canary
 * with extra steps, and calling that HARDENED is the overclaim this whole
 * repository is organised against.
 *
 * WHAT IS *NOT* HERE, so no reader infers it: this file does not create the
 * worker identity, install the service, or rewrite the store DACL. Those are
 * privileged and are the owner's decision; `installPlan()` prints the exact
 * commands and `provider status` measures whether they were run.
 */
import path from 'node:path';

import { LocalAuthorityBroker } from '../broker.js';
import type { AuthorizationSubject } from '../authorization.js';
import { subjectDigest } from '../authorization.js';
import { storeFromEnv, type TrustStore } from '../trust-store.js';
import {
  PROVIDER_PIPE_NAME, PROVIDER_SERVICE_NAME, WORKER_USER_ENV, installPlan,
  measureBoundary, type BoundaryMeasurement, type InstallPlan,
} from './boundary.js';
import {
  IpcError, callBroker, createBrokerServer, ensureBrokerToken, providerEndpoint,
  type WireRequest,
} from './ipc.js';

export { PROVIDER_PIPE_NAME, PROVIDER_SERVICE_NAME, WORKER_USER_ENV };

/** What the provider reports about itself. Never a verdict about a candidate. */
export interface ProviderStatus {
  schema: 'canary-provider-status/1';
  service: string;
  pipe: string;
  /** The measured boundary — the authority for `hardened`. */
  boundary: BoundaryMeasurement;
  /** True only when every control is available. HARDENED is exactly this. */
  hardened: boolean;
  /** Why not, one line per unavailable control. */
  unavailable: string[];
  /** True when a worker identity is enrolled but the service is not running. */
  activationPending: boolean;
}

export function providerStatus(store: TrustStore = storeFromEnv(), env: NodeJS.ProcessEnv = process.env): ProviderStatus {
  const boundary = measureBoundary(store, env);
  const unavailable = Object.entries(boundary.controls)
    .filter(([, c]) => !c.available)
    .map(([name, c]) => `${name}: ${c.why}`);
  return {
    schema: 'canary-provider-status/1',
    service: PROVIDER_SERVICE_NAME,
    pipe: providerEndpoint(PROVIDER_PIPE_NAME),
    boundary,
    hardened: boundary.hardenedAvailable,
    unavailable,
    activationPending: boundary.workerUser !== null && !boundary.brokerServiceRunning,
  };
}

/**
 * A restricted runner: launches candidate code under the enrolled worker
 * identity. It is deliberately the ONLY place a provider would start a child for
 * verification, and it refuses when the identity is not enrolled — so there is no
 * path in this file that runs project code as the broker.
 *
 * The launch mechanism is per platform (`runas`/a scheduled task on Windows,
 * `sudo -u`/`setpriv` on POSIX); the identity argument is the enrolled worker
 * account, never anything a client supplied.
 */
export class RestrictedRunner {
  constructor(private readonly workerUser: string | null) {}

  /** The argv a provider WOULD use, so the mechanism is inspectable and testable
   *  without the identity existing. Returns null when it cannot be built. */
  launchArgv(program: string, args: readonly string[], cwd: string): string[] | null {
    if (this.workerUser === null) return null;
    if (program.includes('"') || cwd.includes('"')) return null; // cannot embed safely
    if (process.platform === 'win32') {
      // runas cannot pass a password non-interactively; the supported mechanism is
      // a scheduled task or the service itself running as the worker. Printing the
      // shape keeps this honest instead of pretending runas is usable.
      return ['schtasks', '/run', `/tn`, `CanaryRunner-${this.workerUser}`];
    }
    return ['sudo', '-n', '-u', this.workerUser, '--', program, ...args];
  }

  /** Refuse rather than execute as the broker. The provider turns this into a
   *  BLOCKED outcome; it never falls back. */
  assertUsable(): string | null {
    if (this.workerUser === null) {
      return `no restricted runner identity is enrolled (${WORKER_USER_ENV} is unset): running candidate code as the broker identity is exactly what HARDENED forbids, so the verification is BLOCKED`;
    }
    if (process.platform === 'win32') {
      return 'a Windows restricted runner must be a scheduled task or a second service running as the enrolled identity; no such runner is installed here, so the verification is BLOCKED';
    }
    return null;
  }
}

/** The service handler: narrow operations over the broker kernel. */
export function createProviderHandler(opts: {
  store: TrustStore;
  projectId: string;
  generation: string;
  /** Resolve the enrolled subject from the SERVICE's own state. A client can
   *  never supply one — that is the confused-deputy guard. */
  liveSubject: () => AuthorizationSubject;
}): (req: WireRequest) => unknown {
  const broker = new LocalAuthorityBroker(opts.store, opts.projectId);
  const runner = new RestrictedRunner(process.env[WORKER_USER_ENV]?.trim() || null);
  return (req) => {
    switch (req.op) {
      case 'broker.hello':
        return { schema: 'canary-broker/1', generation: opts.generation, service: PROVIDER_SERVICE_NAME };
      case 'broker.status': {
        const s = providerStatus(opts.store);
        return { hardened: s.hardened, unavailable: s.unavailable, service: PROVIDER_SERVICE_NAME };
      }
      case 'broker.request-verification': {
        // The subject is resolved HERE, from the broker's own enrollment. The
        // worker's request cannot name new authority.
        const live = opts.liveSubject();
        const opened = broker.beginPromotion(live, opts.generation);
        return { runId: opened.runId, sequence: opened.sequence, purpose: opened.purpose, subjectDigest: opened.subjectDigest };
      }
      case 'broker.submit-verification':
      case 'broker.submit-acceptance': {
        const blocked = runner.assertUsable();
        if (blocked !== null) throw new IpcError('no-restricted-runner', blocked);
        // With a real restricted runner installed, the provider would execute the
        // sealed plan THERE and sign the statement with the broker-held key. The
        // signing path is the kernel's (`request`), which is already implemented
        // and attack-tested; what is missing on this host is the identity.
        throw new IpcError('runner-not-installed', 'the restricted runner is declared but not installed; verification cannot be produced');
      }
      case 'broker.reserve-promotion': {
        const live = opts.liveSubject();
        const intent = broker.reservePromotion(live, opts.generation);
        return { targetId: intent.targetId, expectedHead: intent.expectedHead, candidateCommit: intent.candidateCommit };
      }
      case 'broker.reconcile':
        return { status: 'not-applied', reason: 'no promotion has been reserved in this generation' };
      default:
        throw new IpcError('unknown-operation', `operation ${String(req.op)} is not served`);
    }
  };
}

/** Run the service in the foreground (what `sc.exe` starts). */
export async function providerServe(store: TrustStore = storeFromEnv()): Promise<number> {
  const status = providerStatus(store);
  if (!status.hardened) {
    process.stderr.write('CANARY PROVIDER UNAVAILABLE — the boundary is not established, so the broker will not run.\n');
    for (const u of status.unavailable) process.stderr.write(`  - ${u}\n`);
    process.stderr.write('\nwhy this is a refusal and not a warning: a broker without a separate identity is our own\n');
    process.stderr.write('process with extra steps, and running candidate code under it is the exact overclaim that\n');
    process.stderr.write('HARDENED is reserved for. Run `canary provider install-plan` for the privileged steps.\n');
    return 2;
  }
  const token = ensureBrokerToken(store.root);
  // The subject is read from the store by the broker itself; this stand-in keeps
  // the handler shaped correctly and is replaced by enrollment lookup once the
  // provider is activated.
  const projectId = 'p-'.padEnd(34, '0');
  const generation = process.env.CANARY_AUTHORITY_GENERATION?.trim() || '1';
  const server = createBrokerServer({
    pipeName: PROVIDER_PIPE_NAME,
    token,
    authorityGeneration: generation,
    handler: createProviderHandler({
      store, projectId, generation,
      liveSubject: () => { throw new IpcError('no-enrollment', 'this broker has no enrolled subject'); },
    }),
    log: (l) => process.stderr.write(`canary-broker: ${l}\n`),
  });
  process.stderr.write(`canary-broker: serving ${providerEndpoint(PROVIDER_PIPE_NAME)} as generation ${generation}\n`);
  const shutdown = async (): Promise<void> => { await server.close(); process.exit(0); };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  return await new Promise<number>(() => { /* serve until signalled */ });
}

/** A worker-side call. Present so the CLI can be pointed at a provider. */
export async function callProvider(req: Omit<WireRequest, 'schema' | 'token' | 'id'>, store: TrustStore = storeFromEnv()): Promise<unknown> {
  const token = ensureBrokerToken(store.root);
  return callBroker(req, { pipeName: PROVIDER_PIPE_NAME, token });
}

export function providerInstallPlan(store: TrustStore = storeFromEnv()): InstallPlan {
  return installPlan(store);
}

/** What an uninstall must remove, and what it must NOT touch. */
export function providerUninstallPlan(store: TrustStore = storeFromEnv()): { steps: string[][]; keepsProtectedAuthority: string } {
  const plan = installPlan(store);
  return {
    steps: plan.rollback.map((r) => r.argv),
    // Stated explicitly because "uninstall" must never silently destroy the
    // sealed authority: it is the owner's record, and a routine uninstall is not
    // authorization to delete it.
    keepsProtectedAuthority: `${store.root} is NOT deleted: it holds the sealed authority and key material. `
      + 'Remove it deliberately, by hand, after confirming no project depends on its records.',
  };
}
