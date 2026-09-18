/** Boundary reporting: current production schema-2 evidence plus a live signed
 * broker check is the only activation path. Schema-1 records remain diagnostic
 * and permanently non-activating. Identity/service observations are separate;
 * no service declaration or standalone probe can establish HARDENED. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { BoundaryControl } from '../platform-boundary.js';
import { storeFromEnv, type TrustStore } from '../trust-store.js';
import { PRODUCTION_MEASUREMENT, readProductionMeasurement } from './production-measurement.js';
import {
  ALL_CONTROLS, readConfinedMeasurement, recordPath, toolsDigest,
  type ConfinedMeasurementRecord, type RecordState,
} from './confined-measurement.js';

/** The provider service's name and pipe. Fixed, so install/uninstall/verify agree. */
export const PROVIDER_SERVICE_NAME = 'CanaryBroker';
export const PROVIDER_PIPE_NAME = 'canary-broker';
export const WORKER_USER_ENV = 'CANARY_WORKER_USER';

export interface CommandObservation {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ControlReason = { available: boolean; why: string };

export interface BoundaryMeasurement {
  schema: 'canary-boundary-measurement/1';
  platform: string;
  /** This process's account, as the OS reports it. */
  currentUser: string | null;
  elevated: boolean;
  storeDir: string;
  storeExists: boolean;
  /** Principals with write access to the store dir, as icacls reports them. */
  storeWriters: string[];
  storeDaclObservable: boolean;
  /** The declared worker identity, if any — Canary never invents one. */
  workerUser: string | null;
  brokerServiceInstalled: boolean;
  brokerServiceRunning: boolean;
  brokerServiceAccount: string | null;
  /** The service runs as an account that is not the caller's: the identity separation. */
  separateBrokerIdentity: boolean;
  /** What a restricted runner could actually be built on, observed per platform. */
  sandbox: SandboxPrimitive;
  /** The confined-caller deployment: validated record state, or the reason it is unusable. */
  confined: ConfinedDeploymentState;
  production?: ReturnType<typeof readProductionMeasurement>;
  /**
   * The identity path's own verdict, reported SEPARATELY and never mixed into
   * `controls`. It is what an elevated install would add; it is not evidence of
   * anything on a host where nobody installed one.
   */
  identityControls: Record<BoundaryControl, ControlReason>;
  /** Every raw observation, so a human can re-check the reasoning. */
  observations: CommandObservation[];
  /** The six controls, each derived from the measured deployment record. */
  controls: Record<BoundaryControl, ControlReason>;
  /** True only when EVERY control is available. HARDENED is exactly this. */
  hardenedAvailable: boolean;
}

/** What this host knows about a confined-caller deployment, as data. */
export interface ConfinedDeploymentState {
  /** A usable, fresh, signed, complete measurement record exists. */
  measured: boolean;
  /** Whether any record file is present, valid or not. */
  recordPresent: boolean;
  recordPath: string;
  /** The check that refused it, when it is not usable. Empty when measured. */
  reason: string;
  measuredAt: string | null;
  ageMs: number | null;
  callerPackage: string | null;
  /** The digest of the boundary tools on disk RIGHT NOW. */
  toolsDigest: string | null;
  /** The digest the record was bound to. */
  recordToolsDigest: string | null;
  deploymentComplete: boolean | null;
  deploymentFailures: string[];
  signatureVerified: boolean;
  /** Per-control availability derived from the record's own evidence. */
  controls: Record<BoundaryControl, ControlReason>;
  /** The record itself, so a report can quote its observations. */
  record: ConfinedMeasurementRecord | null;
}

const run = (argv: string[], timeoutMs = 30_000): CommandObservation => {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { argv, exitCode: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
};

/** `DOMAIN\user` for this process, or null when it cannot be read. */
export function currentUser(): { user: string | null; observation: CommandObservation } {
  const o = process.platform === 'win32' ? run(['whoami']) : run(['id', '-un']);
  const user = o.exitCode === 0 && o.stdout !== '' ? o.stdout.split('\n')[0]!.trim() : null;
  return { user, observation: o };
}

/** Elevated? `net session` needs administrator, `id -u` needs root. */
export function isElevated(): { elevated: boolean; observation: CommandObservation } {
  const o = process.platform === 'win32' ? run(['net', 'session']) : run(['id', '-u']);
  const elevated = process.platform === 'win32' ? o.exitCode === 0 : o.stdout === '0';
  return { elevated, observation: o };
}

/**
 * Does this listing grant WRITE to a specific principal?
 *
 * This is the function the boundary DECISION uses, and it is deliberately not a
 * parse-then-search: `icacls` prints the directory path on the same line as the
 * first ACE (`C:\store DOMAIN\user:(OI)(CI)(F)`), so "where does the principal
 * start" has no unambiguous answer in general — and guessing it is how a
 * read-only ACE could be misread as a write grant.
 *
 * Instead the principal must be IMMEDIATELY followed by its ACE permission group.
 * A name that merely appears somewhere on the line (the directory path, a
 * longer principal that contains this one as a prefix, a comment) therefore
 * cannot match, and only (F)/(M)/(W) count as write.
 */
export function storeDaclGrantsWrite(icaclsOutput: string, principal: string): boolean {
  const needle = principal.toLowerCase();
  for (const line of icaclsOutput.split(/\r?\n/)) {
    let from = 0;
    for (;;) {
      const idx = line.toLowerCase().indexOf(needle, from);
      if (idx === -1) break;
      const after = line.slice(idx + principal.length);
      const m = /^:((?:\([A-Z]+\))+)/.exec(after);
      if (m !== null && /\((?:F|M|W)\)/.test(m[1]!)) return true;
      from = idx + principal.length;
    }
  }
  return false;
}

/**
 * Informational only: the text preceding each ACE's permission group, for a
 * human reading `canary provider status`. NOT used for any decision — see
 * `storeDaclGrantsWrite`, which does not need to locate a principal's start.
 */
export function parseStoreWriters(icaclsOutput: string): string[] {
  const writers: string[] = [];
  const ACE = /([A-Za-z0-9_\\.\- ]*?[A-Za-z0-9_\\.\-])\s*:((?:\([A-Z]+\))+)/g;
  for (const line of icaclsOutput.split(/\r?\n/)) {
    for (let m = ACE.exec(line); m !== null; m = ACE.exec(line)) {
      if (/\((?:F|M|W)\)/.test(m[2]!)) writers.push(m[1]!.trim());
    }
    ACE.lastIndex = 0;
  }
  return writers;
}

function observeStoreDacl(dir: string): { writers: string[]; raw: string; observable: boolean; observation: CommandObservation | null } {
  if (process.platform !== 'win32') {
    // POSIX: report what the mode bits say, which is the honest analogue.
    try {
      const st = fs.statSync(dir);
      const writers = (st.mode & 0o222) !== 0 ? ['(owner/group/other with a write bit)'] : [];
      return { writers, raw: '', observable: true, observation: null };
    } catch { return { writers: [], raw: '', observable: false, observation: null }; }
  }
  if (!fs.existsSync(dir)) return { writers: [], raw: '', observable: false, observation: null };
  const o = run(['icacls', dir]);
  if (o.exitCode !== 0) return { writers: [], raw: '', observable: false, observation: o };
  return { writers: parseStoreWriters(o.stdout), raw: o.stdout, observable: true, observation: o };
}

function observeBrokerService(): {
  installed: boolean; running: boolean; account: string | null; observations: CommandObservation[];
} {
  if (process.platform !== 'win32') {
    const active = run(['systemctl', 'is-active', PROVIDER_SERVICE_NAME]);
    const cat = run(['systemctl', 'show', '-p', 'User', '--value', PROVIDER_SERVICE_NAME]);
    return {
      installed: active.exitCode === 0 || /inactive|failed/.test(active.stdout),
      running: active.stdout === 'active',
      account: cat.stdout.trim() === '' ? null : cat.stdout.trim(),
      observations: [active, cat],
    };
  }
  const q = run(['sc.exe', 'query', PROVIDER_SERVICE_NAME]);
  const qc = run(['sc.exe', 'qc', PROVIDER_SERVICE_NAME]);
  const installed = q.exitCode === 0;
  const running = /STATE\s*:\s*4\s+RUNNING/i.test(q.stdout);
  const account = /SERVICE_START_NAME\s*:\s*(\S.*)$/im.exec(qc.stdout)?.[1]?.trim() ?? null;
  return { installed, running, account, observations: [q, qc] };
}

const control = (available: boolean, why: string): ControlReason => ({ available, why });

/**
 * The IDENTITY path's verdict for one control, as observation only. Every branch
 * states the fact it rests on; none of them can produce a control on its own.
 */
function identityControl(
  name: BoundaryControl,
  f: {
    storeExists: boolean; daclObservable: boolean; workerUser: string | null;
    separateBrokerIdentity: boolean; brokerInstalled: boolean; brokerAccount: string | null;
    sandboxFullJail: boolean;
  },
): ControlReason {
  switch (name) {
    case 'authorityCustody':
      return f.storeExists && f.daclObservable && f.workerUser !== null
        ? control(false, `an identity-path store is present but nothing yet proves ${f.workerUser} cannot write it: the confined-caller deployment is the measured path`)
        : control(false, !f.storeExists
          ? 'no identity-path protected store is installed'
          : f.workerUser === null
            ? 'no worker identity is enrolled, so "the worker cannot write the store" is not a testable statement'
            : 'the store DACL could not be read, so custody cannot be claimed');
    case 'workerFilesystem':
      return f.workerUser === null
        ? control(false, 'no worker identity is declared, so no process runs under a separate account')
        : control(false, `an identity-path worker (${f.workerUser}) is enrolled; custody is still unmeasured`);
    case 'verificationSandbox':
      return control(false, !f.brokerInstalled
        ? `no ${PROVIDER_SERVICE_NAME} service is installed, so nothing can launch candidate code under a third identity`
        : !f.separateBrokerIdentity
          ? `the service account (${f.brokerAccount ?? 'unknown'}) is the caller's own account, so candidate code would run with the broker's identity`
          : f.sandboxFullJail
            ? 'the identity-path service runs as another account'
            : 'the identity path has no filesystem/network jail primitive');
    case 'authenticatedReview':
      return control(false, 'the identity path has no broker-held reviewer key: review is authenticated by terminal presence only');
    case 'protectedPromotion':
      return control(false, 'the identity path leaves the local promote path authoritative, so promotion has a writable shortcut');
    case 'networkEgress':
      return control(false, 'no per-identity egress policy is installed (Windows needs a firewall rule or a sandbox primitive, both privileged)');
    default:
      return control(false, `${name} is not measured on the identity path`);
  }
}

/** The refused-record reason, phrased for a control report. */
const deploymentWhy = (reason: string): string => `the confined-caller deployment is not measured: ${reason}`;

/**
 * Observe the confined-caller deployment for this store. The record is validated
 * (freshness, host, store, toolchain, custody signature, completeness, per-control
 * evidence) and the resulting per-control availability is returned unchanged.
 */
export function observeConfinedDeployment(
  store: TrustStore = storeFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
  now?: number,
): ConfinedDeploymentState {
  const digest = toolsDigest();
  const state: RecordState = readConfinedMeasurement(store.root, {
    ...(env.CANARY_CONFINED_MAX_AGE_MS !== undefined && /^\d+$/.test(env.CANARY_CONFINED_MAX_AGE_MS)
      ? { maxAgeMs: Number(env.CANARY_CONFINED_MAX_AGE_MS) }
      : {}),
    ...(now !== undefined ? { now } : {}),
    digest,
  });
  return {
    measured: state.valid,
    recordPresent: state.record !== null,
    recordPath: state.recordPath,
    reason: state.reason,
    measuredAt: state.measuredAt,
    ageMs: state.ageMs,
    callerPackage: state.callerPackage,
    toolsDigest: digest,
    recordToolsDigest: state.toolsDigest,
    deploymentComplete: state.deploymentComplete,
    deploymentFailures: state.deploymentFailures,
    signatureVerified: state.signatureVerified,
    controls: state.controls,
    record: state.record,
  };
}

/**
 * Measure the boundary on THIS host. Pure observation: nothing is created,
 * nothing is changed, and no privileged command is attempted.
 */
export function measureBoundary(
  store: TrustStore = storeFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
  now?: number,
): BoundaryMeasurement {
  const { user, observation: userObs } = currentUser();
  const { elevated, observation: elevObs } = isElevated();
  const storeExists = fs.existsSync(store.root);
  const dacl = observeStoreDacl(store.root);
  const svc = observeBrokerService();
  const workerUser = env[WORKER_USER_ENV]?.trim() || null;
  const sandbox = observeSandboxPrimitive();
  const separateBrokerIdentity = svc.installed && svc.account !== null && user !== null
    && svc.account.toLowerCase() !== user.toLowerCase();
  const confined = observeConfinedDeployment(store, env, now);
  const production = fs.existsSync(path.join(store.root, PRODUCTION_MEASUREMENT)) ? readProductionMeasurement(store.root, now) : undefined;

  const identityControls = Object.fromEntries(ALL_CONTROLS.map((name) => [name, identityControl(name, {
    storeExists, daclObservable: dacl.observable, workerUser, separateBrokerIdentity,
    brokerInstalled: svc.installed, brokerAccount: svc.account, sandboxFullJail: sandbox.fullJail,
  })])) as Record<BoundaryControl, ControlReason>;

  // The controls HARDENED rests on: the MEASURED deployment, nothing else. When
  // the record is not usable, every control carries the validation's own refusal
  // reason — never a placeholder, and never an optimistic default.
  const controls = Object.fromEntries(ALL_CONTROLS.map((name) => {
    if (production) return [name, control(production.valid, `${name}: ${production.reason}; raw native, authority and pipe observations are required together` )];
    const measured = confined.controls[name];
    if (confined.measured) return [name, measured];
    const identity = identityControls[name];
    // BOTH facts travel: which control the record itself found missing, and why
    // the identity path does not make up the difference. A refusal that hides
    // which observation is missing is not actionable.
    const detail = measured.available ? '' : `; the record reports: ${measured.why}`;
    return [name, control(false, `${deploymentWhy(confined.reason)}${detail}; the identity path also leaves it unavailable: ${identity.why}`)];
  })) as Record<BoundaryControl, ControlReason>;

  const hardenedAvailable = ALL_CONTROLS.every((name) => controls[name].available);
  return {
    schema: 'canary-boundary-measurement/1',
    platform: process.platform,
    currentUser: user,
    elevated,
    storeDir: store.root,
    storeExists,
    storeWriters: dacl.writers,
    storeDaclObservable: dacl.observable,
    workerUser,
    brokerServiceInstalled: svc.installed,
    brokerServiceRunning: svc.running,
    brokerServiceAccount: svc.account,
    separateBrokerIdentity,
    sandbox,
    confined,
    ...(production ? { production } : {}),
    identityControls,
    observations: [
      userObs, elevObs, ...svc.observations,
      ...(dacl.observation !== null ? [dacl.observation] : []),
    ],
    controls,
    hardenedAvailable,
  };
}

/**
 * Is a provider CONFIGURED here? Used to decide whether the ordinary read-only
 * capability answer should consult the provider at all.
 *
 * This matters for more than tidiness: `status`/`result`/`agents` promise to be
 * cheap and to write nothing, and measuring the boundary costs several process
 * spawns. A machine with no provider must therefore behave exactly as it did
 * before this module existed — and it does, because a provider that was never
 * installed leaves no token, no declared worker identity and no measurement
 * record.
 */
export function providerConfigured(store: TrustStore = storeFromEnv(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (fs.existsSync(path.join(store.root, 'enrollment.json'))) return true;
  if ((env[WORKER_USER_ENV] ?? '').trim() !== '') return true;
  try {
    if (fs.statSync(path.join(store.root, 'provider-token')).isFile()) return true;
  } catch { /* no token */ }
  try {
    return fs.statSync(recordPath(store.root)).isFile();
  } catch {
    return false;
  }
}

/**
 * Is there a sandbox primitive a RESTRICTED runner could actually be built on?
 *
 * The answer is per platform and is OBSERVED, not assumed:
 *  - Windows: the AppContainer + restricted-token + low-integrity launcher and
 *    the trusted broker are IMPLEMENTED as native C# helpers under
 *    `tools/windows-boundary/`. `fullJail: true` here means the mechanism exists
 *    and has been executed on this host; whether a particular DEPLOYMENT was
 *    measured is a separate question, answered only by a valid measurement
 *    record bound to the digest of those very files.
 *  - Linux: `bwrap` (bubblewrap) or `unshare` give a real mount/pid/net namespace
 *    to run candidate code in; `systemd-run --uid=` gives a transient unit under
 *    another identity. The Windows mechanism was executed here; the Linux one was
 *    not, and is not claimed.
 */
export interface SandboxPrimitive {
  kind: string | null;
  /** True when the primitive provides identity AND isolation, not just identity. */
  fullJail: boolean;
  detail: string;
  /** The boundary tools this primitive consists of, hashed, when they are present. */
  toolsDigest?: string | null;
}
export function observeSandboxPrimitive(platform: NodeJS.Platform = process.platform): SandboxPrimitive {
  if (platform === 'win32') {
    const digest = toolsDigest();
    if (digest === null) {
      return {
        kind: null, fullJail: false, toolsDigest: null,
        detail: 'the Win32 confined-caller boundary tools are incomplete on disk, so no deployment can be measured',
      };
    }
    return {
      kind: 'win32-appcontainer-restricted-low', fullJail: true, toolsDigest: digest,
      detail: 'a native AppContainer + restricted-token + low-integrity launcher and its trusted broker are present and were executed on this host; the deployment itself is only proven by a fresh measurement record bound to their digest',
    };
  }
  for (const [cmd, fullJail, why] of [
    ['bwrap', true, 'bubblewrap gives namespaces plus an identity switch'],
    ['unshare', true, 'util-linux unshare gives namespaces; the identity switch needs setpriv/sudo alongside'],
    ['systemd-run', false, 'systemd-run --uid gives the identity but not the filesystem/network jail on its own'],
  ] as const) {
    const r = run(['sh', '-c', `command -v ${cmd}`]);
    if (r.exitCode === 0 && r.stdout !== '') return { kind: cmd, fullJail, detail: `${cmd} present at ${r.stdout}: ${why}` };
  }
  return { kind: null, fullJail: false, detail: 'no bwrap/unshare/systemd-run found, so candidate code cannot be jailed here' };
}

/**
 * The EXACT privileged steps required to activate the IDENTITY provider on this
 * platform, and the exact rollback. Printed, never executed: creating an
 * identity, installing a service and rewriting a DACL are the owner's decisions.
 *
 * This is NOT the path this build activates. The confined-caller deployment
 * needs no elevation at all and is the one whose measurement produces HARDENED;
 * this plan is kept because a host that already has a separate broker account
 * would use it, and because the alternative must not become a secret.
 */
export interface InstallPlan {
  schema: 'canary-provider-install-plan/1';
  platform: string;
  /** True when this platform's enforcement path has actually been EXECUTED on a
   *  host. Windows is the one this repository has run; the Linux path is
   *  implemented and unverified, and says so instead of implying parity. */
  hostVerified: boolean;
  steps: Array<{ id: string; why: string; argv: string[]; needsElevation: boolean }>;
  /** Files a step writes, with their content, so nothing is a black box. */
  files?: Array<{ path: string; content: string; why: string }>;
  rollback: Array<{ id: string; argv: string[] }>;
  verify: string[];
  postState: string[];
}

function windowsInstallPlan(storeDir: string, workerUser: string, installDir: string): InstallPlan {
  const brokerAccount = 'CanaryBroker';
  return {
    schema: 'canary-provider-install-plan/1',
    platform: 'win32',
    hostVerified: true,
    steps: [
      {
        id: 'worker-identity',
        why: 'candidate code must run as an identity that cannot write Canary\'s authority; until this exists no identity-path control can be proven',
        argv: ['net', 'user', workerUser, '<STRONG-PASSWORD>', '/add', '/passwordreq:yes'],
        needsElevation: true,
      },
      {
        id: 'broker-identity',
        why: 'the broker must hold the key material under an identity the worker does not have',
        argv: ['net', 'user', brokerAccount, '<STRONG-PASSWORD>', '/add', '/passwordreq:yes'],
        needsElevation: true,
      },
      {
        id: 'protected-store',
        why: 'the authority store must be writable ONLY by the broker account and the OS, and the worker must be explicitly denied',
        argv: ['icacls', storeDir, '/inheritance:r',
          '/grant:r', `${brokerAccount}:(OI)(CI)F`, '/grant:r', 'SYSTEM:(OI)(CI)F',
          '/grant:r', 'Administrators:(OI)(CI)F', '/deny', `${workerUser}:(OI)(CI)W`],
        needsElevation: true,
      },
      {
        id: 'install-service',
        why: 'the service is what makes the broker reachable without repeated elevation',
        argv: ['sc.exe', 'create', PROVIDER_SERVICE_NAME, `binPath= "${path.join(installDir, 'canary.exe')} provider serve"`,
          `obj= ${brokerAccount}`, 'password= <STRONG-PASSWORD>', 'start= auto'],
        needsElevation: true,
      },
      {
        id: 'start-service',
        why: 'the provider must be running before any command can rely on it',
        argv: ['sc.exe', 'start', PROVIDER_SERVICE_NAME],
        needsElevation: true,
      },
      {
        id: 'enroll-worker',
        why: 'declares the restricted runner identity to Canary; without it the identity path is unmeasurable',
        argv: ['setx', WORKER_USER_ENV, workerUser],
        needsElevation: false,
      },
    ],
    rollback: [
      { id: 'stop-service', argv: ['sc.exe', 'stop', PROVIDER_SERVICE_NAME] },
      { id: 'delete-service', argv: ['sc.exe', 'delete', PROVIDER_SERVICE_NAME] },
      { id: 'restore-store-acl', argv: ['icacls', storeDir, '/remove:d', workerUser, '/remove', brokerAccount, '/grant:r', `${process.env.USERNAME ?? '<you>' }:(OI)(CI)F`] },
      { id: 'delete-worker', argv: ['net', 'user', workerUser, '/delete'] },
      { id: 'delete-broker', argv: ['net', 'user', brokerAccount, '/delete'] },
      { id: 'unset-env', argv: ['reg', 'delete', 'HKCU\\Environment', '/v', WORKER_USER_ENV, '/f'] },
    ],
    verify: [
      'canary provider status --json   # every control must read available, and hardenedAvailable true',
      'node tooling/probes/v12-confined-caller.mjs   # the deployment measurement the controls come from',
      'node tooling/probes/provider-boundary.mjs',
      'npm test                        # the broker/trust-store/platform-boundary attack suites',
    ],
    postState: [
      `a ${PROVIDER_SERVICE_NAME} service running as a non-caller account`,
      `${workerUser} present but denied write access to ${storeDir}`,
      `${storeDir} writable only by ${brokerAccount}, SYSTEM and Administrators`,
      `${WORKER_USER_ENV}=${workerUser} declared for the verifying user`,
      'canary provider status: hardenedAvailable = true (only then does HARDENED become reachable)',
    ],
  };
}

/**
 * The LINUX provider path. IMPLEMENTED_BUT_HOST_UNVERIFIED: the commands, the
 * unit file and the enforcement points are real, and none of them has been
 * executed here because this host is Windows. Saying that plainly is the point —
 * a Linux claim resting on "the code looks right" is exactly the overclaim this
 * repository forbids, so `hostVerified: false` travels with the plan.
 */
function linuxInstallPlan(storeDir: string, workerUser: string, installDir: string): InstallPlan {
  const brokerAccount = 'canary-broker';
  const unit = [
    '[Unit]', 'Description=Canary trusted broker (verification control plane)', 'After=network.target', '',
    '[Service]', 'Type=simple', `User=${brokerAccount}`,
    `ExecStart=${path.join(installDir, 'canary')} provider serve`,
    // The broker holds the authority; it must never gain a writable home or the
    // ability to execute candidate code as itself.
    'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true',
    `ReadWritePaths=${storeDir}`, 'Restart=on-failure', '',
    '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n');
  return {
    schema: 'canary-provider-install-plan/1',
    platform: 'linux',
    hostVerified: false,
    steps: [
      {
        id: 'worker-identity',
        why: 'candidate code runs as this identity; it must not be able to write Canary\'s authority',
        argv: ['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', workerUser],
        needsElevation: true,
      },
      {
        id: 'broker-identity',
        why: 'the broker holds the key material; a distinct identity is what makes the boundary a boundary',
        argv: ['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', brokerAccount],
        needsElevation: true,
      },
      {
        id: 'protected-store',
        why: 'the store must be owned by the broker and unreadable/unwritable by the worker',
        argv: ['sh', '-c', `install -d -m 0700 -o ${brokerAccount} -g ${brokerAccount} '${storeDir}' && setfacl -m u:${workerUser}:--- '${storeDir}'`],
        needsElevation: true,
      },
      {
        id: 'install-unit',
        why: 'the unit runs the broker as the broker identity, with the filesystem hardened and only the store writable',
        argv: ['install', '-m', '0644', '/dev/stdin', `/etc/systemd/system/${PROVIDER_SERVICE_NAME}.service`],
        needsElevation: true,
      },
      {
        id: 'enable-service',
        why: 'the provider must be running before any command can rely on it',
        argv: ['systemctl', 'enable', '--now', PROVIDER_SERVICE_NAME],
        needsElevation: true,
      },
      {
        id: 'egress-policy',
        why: 'ONLY if HARDENED is to claim egress control: a per-uid deny with an explicit allowlist. If this is not installed, the control must stay UNAVAILABLE and HARDENED unreachable',
        argv: ['nft', 'add', 'rule', 'inet', 'filter', 'output', 'meta', 'skuid', brokerAccount, 'tcp', 'dport', '{443}', 'accept'],
        needsElevation: true,
      },
    ],
    files: [{ path: `/etc/systemd/system/${PROVIDER_SERVICE_NAME}.service`, content: unit, why: 'the unit is the enforcement point: identity, ProtectSystem, and the single writable path' }],
    rollback: [
      { id: 'stop-service', argv: ['systemctl', 'disable', '--now', PROVIDER_SERVICE_NAME] },
      { id: 'remove-unit', argv: ['rm', '-f', `/etc/systemd/system/${PROVIDER_SERVICE_NAME}.service`] },
      { id: 'drop-egress', argv: ['nft', '-f', '/etc/canary-egress.nft'] },
      { id: 'delete-worker', argv: ['userdel', workerUser] },
      { id: 'delete-broker', argv: ['userdel', brokerAccount] },
    ],
    verify: [
      'canary provider status --json   # every control must read available, and hardenedAvailable true',
      'node tooling/probes/provider-boundary.mjs',
      'npm test',
    ],
    postState: [
      `a ${PROVIDER_SERVICE_NAME} systemd unit active as ${brokerAccount}`,
      `${workerUser} exists and has no access to ${storeDir}`,
      `${storeDir} owned by ${brokerAccount} with mode 0700`,
      `${WORKER_USER_ENV}=${workerUser} declared`,
      'canary provider status: hardenedAvailable = true — and ',
      'WARNING: this list is IMPLEMENTED_BUT_HOST_UNVERIFIED; it has never been executed on a Linux host',
    ],
  };
}

/**
 * The install plan for a NAMED platform. Exported so the Linux path can be
 * CONTRACT-TESTED on a Windows host — the alternative is a Linux path whose only
 * evidence is that it looks right, which is the thing this repository refuses.
 * Execution still has to happen on the platform (`hostVerified` says which).
 */
export function installPlanFor(platform: string, storeDir: string, workerUser: string, installDir: string): InstallPlan {
  return platform === 'win32'
    ? windowsInstallPlan(storeDir, workerUser, installDir)
    : linuxInstallPlan(storeDir, workerUser, process.platform === 'darwin' || platform === 'darwin' ? '/usr/local/lib/canary' : installDir);
}

export function installPlan(store: TrustStore = storeFromEnv(), workerUser = 'canary-worker', installDir = 'C:\\ProgramData\\Canary'): InstallPlan {
  return installPlanFor(process.platform, store.root, workerUser, installDir);
}
