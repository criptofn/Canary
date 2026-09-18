/** Provider reporting and legacy LOCAL protocol compatibility. Enrolled Windows
 * deployments are served by production.ts and the authenticated native broker.
 * Candidate code only runs under the measured restricted AppContainer runner;
 * legacy reservations cannot mint evidence or authorize caller-owned apply. */
import path from 'node:path';
import fs from 'node:fs';
import { serveProduction } from './production.js';

import { LocalAuthorityBroker } from '../broker.js';
import type { AuthorizationSubject } from '../authorization.js';
import { storeFromEnv, type TrustStore } from '../trust-store.js';
import {
  PROVIDER_PIPE_NAME, PROVIDER_SERVICE_NAME, WORKER_USER_ENV, installPlan,
  measureBoundary, type BoundaryMeasurement, type InstallPlan,
} from './boundary.js';
import {
  IpcError, callBroker, ensureBrokerToken, providerEndpoint,
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
  /** Where candidate code would be confined, when it can be. */
  confinement:
    | { kind: 'win32-appcontainer-restricted-low'; package: string; measuredAt: string; ageMs: number | null }
    | { kind: 'identity-runner'; account: string | null }
    | null;
}

export function providerStatus(store: TrustStore = storeFromEnv(), env: NodeJS.ProcessEnv = process.env): ProviderStatus {
  const boundary = measureBoundary(store, env);
  const unavailable = (Object.entries(boundary.controls) as Array<[string, { available: boolean; why: string }]>)
    .filter(([, c]) => !c.available)
    .map(([name, c]) => `${name}: ${c.why}`);
  const record = boundary.confined.record;
  const production = boundary.production?.valid ? boundary.production.payload : undefined;
  const confinement: ProviderStatus['confinement'] = production
    ? { kind: 'win32-appcontainer-restricted-low', package: production.observations.native[0]!.package,
      measuredAt: new Date(production.finishedAt).toISOString(), ageMs: Date.now() - production.finishedAt }
    : boundary.confined.measured && record !== null
    ? {
      kind: 'win32-appcontainer-restricted-low',
      package: boundary.confined.callerPackage ?? '',
      measuredAt: record.measuredAt,
      ageMs: boundary.confined.ageMs,
    }
    : boundary.workerUser !== null
      ? { kind: 'identity-runner', account: boundary.workerUser }
      : null;
  return {
    schema: 'canary-provider-status/1',
    service: PROVIDER_SERVICE_NAME,
    pipe: providerEndpoint(production ? `canary-production-${production.deployment}` : PROVIDER_PIPE_NAME),
    boundary,
    hardened: boundary.hardenedAvailable,
    unavailable,
    activationPending: boundary.workerUser !== null && !boundary.brokerServiceRunning
      && !boundary.confined.measured && !production,
    confinement,
  };
}

/**
 * A restricted runner: launches candidate code under the ENROLLED worker
 * identity. It is deliberately the ONLY place a provider would start a child for
 * verification, and it refuses when neither mechanism is available — so there is
 * no path in this file that runs project code as the broker.
 *
 * v1.2 Mission 3 added the path that matters: when a confined-caller deployment
 * is MEASURED (`provider/confined-measurement.ts`), candidate code runs inside
 * an AppContainer added to a restricted, low-integrity, zero-capability token —
 * no elevation, no second account — and that is the mechanism this build
 * activates. The identity account remains the fallback for a host that has one.
 *
 * The launch mechanism is per platform (`runas`/a scheduled task on Windows,
 * `sudo -u`/`setpriv` on POSIX); the identity argument is the enrolled worker
 * account, never anything a client supplied.
 */
export class RestrictedRunner {
  constructor(
    private readonly workerUser: string | null,
    /** The measured confinement, when a deployment record validates. */
    private readonly confinement: ProviderStatus['confinement'] = null,
  ) {}

  /** The argv a provider WOULD use, so the mechanism is inspectable and testable
   *  without the identity existing. Returns null when it cannot be built. */
  launchArgv(program: string, args: readonly string[], cwd: string): string[] | null {
    if (this.confinement?.kind === 'win32-appcontainer-restricted-low') {
      // The confined caller is launched by the native helper, never by a shell:
      // one command line, a mandatory disposable sandbox, a side-channel record.
      return ['CanaryConfinedLauncher', 'run', program, ...args, cwd];
    }
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
    if (this.confinement?.kind === 'win32-appcontainer-restricted-low') return null;
    if (this.workerUser === null) {
      return `neither a measured confined-caller deployment nor an enrolled runner identity exists (${WORKER_USER_ENV} is unset): running candidate code as the broker identity is exactly what HARDENED forbids, so the verification is BLOCKED`;
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
  const runner = new RestrictedRunner(
    process.env[WORKER_USER_ENV]?.trim() || null,
    providerStatus(opts.store).confinement,
  );
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
        // The legacy reservation protocol has no signing operation. Production
        // verification belongs exclusively to the authenticated native controller.
        throw new IpcError('production-protocol-required', 'use the enrolled production broker; legacy callers cannot submit trusted evidence');
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
  if (fs.existsSync(path.join(store.root, 'enrollment.json'))) return serveProduction(store.root);
  const status = providerStatus(store);
  if (!status.hardened) {
    process.stderr.write('CANARY PROVIDER UNAVAILABLE — the boundary is not established, so the broker will not run.\n');
    for (const u of status.unavailable) process.stderr.write(`  - ${u}\n`);
    process.stderr.write('\nwhy this is a refusal and not a warning: a broker without a measured boundary is our own\n');
    process.stderr.write('process with extra steps, and running candidate code under it is the exact overclaim that\n');
    process.stderr.write('HARDENED is reserved for. Measure the confined-caller deployment:\n');
    process.stderr.write('  node tooling/probes/v12-confined-caller.mjs\n');
    process.stderr.write('and, only if a separate broker identity is wanted too, `canary provider install-plan`.\n');
    return 2;
  }
  // Only real enrollment can start a production controller. No placeholder
  // project, enrollment resolver or generic local server is an authority path.
  process.stderr.write('CANARY PROVIDER UNAVAILABLE — production enrollment required.\n');
  return 2;
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
