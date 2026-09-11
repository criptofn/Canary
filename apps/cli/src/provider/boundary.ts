/**
 * The HARDENED boundary, MEASURED (v1.1 Phase 3).
 *
 * `HARDENED` is a claim that a different OS identity stands between candidate
 * code and Canary's authority. That is either observable on a host or it is not
 * claimed, so this module runs the observations instead of asserting the answer:
 * which account this process is, whether it is elevated, which principals can
 * write the protected store, whether a broker service exists, and which account
 * that service runs as.
 *
 * DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE: this module MEASURES; it never
 * creates. Creating the worker identity, installing the service and setting the
 * store's DACL are privileged operations that require the owner's authorization
 * — `installPlan()` prints them, and nothing in this file runs them. A boundary
 * that a process could establish for itself would not be a boundary.
 *
 * WHAT EACH CONTROL NEEDS (and therefore why it is unavailable without
 * elevation), stated as the condition that must be OBSERVED, not as prose:
 *
 *   authorityCustody      the store exists and NO principal other than the
 *                         broker account (and the OS) can write it
 *   workerFilesystem      a worker identity is enrolled AND that same identity
 *                         cannot write the store or Canary's own bytes
 *   verificationSandbox   a broker service runs as an account OTHER than the
 *                         caller's, so candidate code can be launched under a
 *                         third, restricted identity
 *   authenticatedReview   the enrolled reviewer key exists and the review
 *                         operation is served by the broker, not by the caller
 *   protectedPromotion    promotion is only reachable through the broker (the
 *                         local promote path is refused once a provider is
 *                         configured) and requires a fresh promotion window
 *   networkEgress         an egress policy this process can actually enforce;
 *                         on Windows without a container/sandbox primitive that
 *                         is a per-identity firewall rule, which is privileged
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { BoundaryControl } from '../platform-boundary.js';
import { storeFromEnv, type TrustStore } from '../trust-store.js';

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
  workerCanWriteStore: boolean | null;
  brokerServiceInstalled: boolean;
  brokerServiceRunning: boolean;
  brokerServiceAccount: string | null;
  /** The service runs as an account that is not the caller's: the separation. */
  separateBrokerIdentity: boolean;
  /** What a restricted runner could actually be built on, observed per platform. */
  sandbox: SandboxPrimitive;
  /** Every raw observation, so a human can re-check the reasoning. */
  observations: CommandObservation[];
  controls: Record<BoundaryControl, { available: boolean; why: string }>;
  /** True only when EVERY control is available. HARDENED is exactly this. */
  hardenedAvailable: boolean;
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

const control = (available: boolean, why: string): { available: boolean; why: string } => ({ available, why });

/**
 * Measure the boundary on THIS host. Pure observation: nothing is created,
 * nothing is changed, and no privileged command is attempted.
 */
export function measureBoundary(store: TrustStore = storeFromEnv(), env: NodeJS.ProcessEnv = process.env): BoundaryMeasurement {
  const { user, observation: userObs } = currentUser();
  const { elevated, observation: elevObs } = isElevated();
  const storeExists = fs.existsSync(store.root);
  const dacl = observeStoreDacl(store.root);
  const svc = observeBrokerService();
  const workerUser = env[WORKER_USER_ENV]?.trim() || null;
  const sandbox = observeSandboxPrimitive();

  // Can the worker write the store? Only answerable when a worker identity is
  // DECLARED — "the worker cannot write it" is not a testable statement about a
  // principal nobody named, so it stays null and the control stays unavailable.
  const workerCanWriteStore = workerUser === null || !dacl.observable
    ? null
    : workerUser === null
      ? null
      : storeDaclGrantsWrite(dacl.raw, workerUser);
  const separateBrokerIdentity = svc.installed && svc.account !== null && user !== null
    && svc.account.toLowerCase() !== user.toLowerCase();

  const controls = {
    authorityCustody: storeExists && dacl.observable && workerUser !== null && workerCanWriteStore === false
      ? control(true, `the store is present and ${workerUser} cannot write it (icacls: ${dacl.writers.join(', ') || 'no writers'})`)
      : control(false, !storeExists
        ? `no protected store is installed at ${store.root}`
        : dacl.observable
          ? (workerUser === null
            ? 'no worker identity is enrolled, so "the worker cannot write the store" is not a testable statement'
            : `${workerUser} can still write the store, so custody is not separated`)
          : 'the store DACL could not be read, so custody cannot be claimed'),
    workerFilesystem: workerUser !== null && workerCanWriteStore === false
      ? control(true, `${workerUser} is enrolled and cannot write the protected store`)
      : control(false, workerUser === null
        ? 'no worker identity is declared, so no process runs under a restricted identity'
        : 'the declared worker identity can still write Canary\'s protected material'),
    verificationSandbox: separateBrokerIdentity && workerUser !== null && sandbox.fullJail
      ? control(true, `the broker runs as ${svc.account} and candidate code can be jailed via ${sandbox.kind}`)
      : control(false, !svc.installed
        ? `no ${PROVIDER_SERVICE_NAME} service is installed, so nothing can launch candidate code under a third identity`
        : !separateBrokerIdentity
          ? `the service account (${svc.account ?? 'unknown'}) is the caller's own account, so candidate code would run with the broker's identity`
          : workerUser === null
            ? 'no worker identity is enrolled'
            : `the broker identity is separated, but candidate code cannot be JAILED: ${sandbox.detail}`),
    authenticatedReview: separateBrokerIdentity
      ? control(false, 'the review operation is not yet served by the broker: an enrolled reviewer key exists in the store, but nothing can require it')
      : control(false, 'review is authenticated by terminal presence only; without a broker identity the same uid can mint it'),
    protectedPromotion: separateBrokerIdentity
      ? control(false, 'the local promote path is still authoritative; until the CLI refuses it while a provider is configured, promotion has a writable shortcut')
      : control(false, 'promotion runs in the caller\'s own process, so the identity that ran the plan also performs the apply'),
    networkEgress: control(false, 'no egress policy this process can enforce is installed: Windows needs a per-identity firewall rule or a sandbox primitive, both privileged'),
  } satisfies Record<BoundaryControl, { available: boolean; why: string }>;

  const hardenedAvailable = Object.values(controls).every((c) => c.available);
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
    workerCanWriteStore,
    brokerServiceInstalled: svc.installed,
    brokerServiceRunning: svc.running,
    brokerServiceAccount: svc.account,
    separateBrokerIdentity,
    sandbox,
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
 * installed leaves no token and no declared worker identity.
 */
export function providerConfigured(store: TrustStore = storeFromEnv(), env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env[WORKER_USER_ENV] ?? '').trim() !== '') return true;
  try {
    return fs.statSync(path.join(store.root, 'provider-token')).isFile();
  } catch {
    return false;
  }
}

/**
 * Is there a sandbox primitive a RESTRICTED runner could actually be built on?
 *
 * The answer is per platform and is OBSERVED, not assumed:
 *  - Linux: `bwrap` (bubblewrap) or `unshare` give a real mount/pid/net namespace
 *    to run candidate code in; `systemd-run --uid=` gives a transient unit under
 *    another identity.
 *  - Windows: the equivalent needs a job object / AppContainer / restricted token,
 *    which a Node process cannot create without a native helper. A scheduled task
 *    under the worker account gives the IDENTITY but not the filesystem/network
 *    jail.
 *
 * Reported as what it is, so a control is never claimed on the strength of a
 * binary existing somewhere.
 */
export interface SandboxPrimitive {
  kind: string | null;
  /** True when the primitive provides identity AND isolation, not just identity. */
  fullJail: boolean;
  detail: string;
}
export function observeSandboxPrimitive(): SandboxPrimitive {
  if (process.platform === 'win32') {
    const t = run(['where', 'schtasks.exe']);
    return {
      kind: null,
      fullJail: false,
      detail: t.exitCode === 0
        ? 'a scheduled task can give the worker IDENTITY, but Windows needs a job object/AppContainer for the filesystem and network jail and Node cannot create one without a native helper'
        : 'no identity-switching mechanism was found',
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
 * The EXACT privileged steps required to activate the provider on THIS platform,
 * and the exact rollback. Printed, never executed: creating an identity,
 * installing a service and rewriting a DACL are the owner's decisions.
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
        why: 'candidate code must run as an identity that cannot write Canary\'s authority; until this exists no control can be proven',
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
        why: 'declares the restricted runner identity to Canary; without it the boundary is unmeasurable',
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
