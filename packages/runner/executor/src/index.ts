/**
 * Executor — the ONLY path through which Canary runs external commands.
 *
 * Responsibilities (ported from the proven m0/experiment harness):
 *  - sanitized-env spawn via @canary-rn/support (allowlist, no shell, timeout kill)
 *  - per-round artifact logging (raw + normalized streams)
 *  - production of both classification RoundFacts and evidence RoundEvidence
 *  - token expansion of spec argv ($npm/$yarn/$tsc/$bin:/placeholders) with
 *    the isolation flags appended to every install command, unconditionally
 */

import fs from 'node:fs';
import path from 'node:path';

import { runCommand, CanaryError, type RunOptions, type RunOutcome, type WorkspaceLayout } from '@canary-rn/support';
import { normalize, type Normalizer } from '@canary-rn/normalizers';
import { sha256hex } from '@canary-rn/hashing';
import { extractFailingTestNames, parseSummaryCounts } from '@canary-rn/comparator';
import type { RoundFact } from '@canary-rn/classification';

export interface ExecutorDeps {
  ws: WorkspaceLayout;
  nodeDir: string;
  npmCli: string;
  artifactsDir: string;
  pipeline: readonly Normalizer[];
  yarnPin?: string;
  run?: (o: RunOptions) => Promise<RunOutcome>;
}

export interface ExecResult {
  label: string;
  run: RunOutcome;
  combined: string;
  normOut: string;
  normErr: string;
}

/**
 * Strict structured-summary matchers (red-team F1: the previous loose
 * regex accepted prose like "Assertion failed: 2 failed checks").
 * Only runner summary LINES count.
 */
const SUMMARY_LINE = /^\s*(?:\d+ (?:tests? )?(?:passed|failed)|\d+ (?:passing|failing)|Tests:\s*\d+ passed)\b/m;
export function hasRunnerSummary(out: string): boolean {
  return SUMMARY_LINE.test(out);
}

/**
 * Infra signatures, two-tier (audit B2).
 *
 * HARD patterns are unambiguous tool/environment failures; they match ANYWHERE
 * in the round's output regardless of exit code — ESM/module/dependency
 * resolution breakage is infrastructure even when the harness exits 0.
 *
 * SOFT codes (network/fs errno names) CAN legitimately appear inside a
 * PASSING test suite's prose (a test named "retries after ECONNREFUSED").
 * They only count when they co-occur on the SAME line with an error shape
 * ("Error: connect ECONNREFUSED", "npm error EACCES", …) and the line is not
 * a runner progress glyph (√/✓/✗/×). This is the balance the audit demands:
 * "recognized infrastructure-failure output must not become PASS" while
 * "ordinary test text must not become false infrastructure".
 */
export const INFRA_PATTERNS: readonly RegExp[] = [
  /ERR_MODULE_NOT_FOUND/, /Cannot find module/, /ReferenceError: require is not defined/,
  /ERR_REQUIRE_ESM/, /ERESOLVE/, /ETARGET/, /npm error/, /npm ERR!/, /error Command failed/,
  /SyntaxError: Unexpected token/,
];
const SOFT_CODE = /\b(EADDRINUSE|ECONNREFUSED|ECONNRESET|EMFILE|EPERM|EACCES|EBUSY|ENOSPC|ENOENT|ETIMEDOUT)\b/;
const SOFT_SHAPE = /\b(?:error|errno|syscall|connect|listen|spawn|fatal|fail(?:ed|ure))\b/i;
const PROGRESS_GLYPH = /^\s*(?:√|✓|✗|×|→|-{2,})/;
export function isInfraOutput(out: string): boolean {
  if (INFRA_PATTERNS.some((re) => re.test(out))) return true;
  return out.split(/\r?\n/).some((line) =>
    !PROGRESS_GLYPH.test(line) && SOFT_CODE.test(line) && SOFT_SHAPE.test(line));
}

/**
 * Audit B5 (supersedes the F8 blacklist posture) — CANARY OWNS the
 * package-manager command surface. Blacklisting npm aliases is a treadmill
 * (`ins`, `ii`, `add`, `it`, `ait`, `dedupe`, … — any alias not enumerated is
 * a silent no-injection hole, and the pre-F8 code only knew four). The policy
 * is instead a CLOSED ALLOWLIST with fail-closed rejection:
 *
 *  1. only the `$npm` / `$yarn` tokens may invoke a package manager at all —
 *     raw forms (`npm`, `npm.cmd`, `npx`, `yarn`, `node …/npm-cli.js`) are
 *     REJECTED before execution, so a spec cannot smuggle an unpolicied
 *     invocation past the guard;
 *  2. the subcommand must be on the closed allowlist; ANYTHING ELSE
 *     (including vetted-looking but unlisted aliases, `exec`, `publish`,
 *     `link`, `rebuild`) is REJECTED as unsupported rather than run without
 *     policy;
 *  3. install/update family → Canary's isolation controls are SPLICED IN
 *     IMMEDIATELY AFTER the subcommand (effective position — the old
 *     end-append became dead weight the moment a user wrote `--`), and a `--`
 *     separator is rejected in these families;
 *  4. script/info families run without injection (own pinned scripts /
 *     read-only queries); `--` passthrough only exists after such a
 *     subcommand, where the subcommand is already positionally pinned;
 *  5. the F8 grammar rules stay: short options rejected, isolation-
 *     conflicting flags rejected in ANY position, unknown bare options before
 *     the subcommand rejected (option names case-folded).
 *
 * Invariant (property-tested): IF an install-family command is accepted, the
 * executed argv demonstrably carries --ignore-scripts, --userconfig, --cache,
 * --registry in effective position right after the subcommand.
 */
const NPM_INSTALL_SUBS = new Set([
  'install', 'i', 'ii', 'ins', 'add', 'ci', 'cit', 'clean-install', 'ic',
  'install-test', 'it', 'install-ci-test', 'ait', 'update', 'up', 'dedupe', 'dd',
]);
const NPM_SCRIPT_SUBS = new Set(['run', 'run-script', 'test']);
const NPM_INFO_SUBS = new Set(['ls', 'll', 'view', 'show', 'info', 'help']);
const YARN_INSTALL_SUBS = new Set(['install', 'add', 'i', 'a']);
const YARN_SCRIPT_SUBS = new Set(['run', 'test']);

/** The public registry Canary pins installs to (defeats host-global npmrc
 *  registry overrides; --userconfig alone does not cover globalconfig). */
export const NPM_REGISTRY_PIN = 'https://registry.npmjs.org/';

/** @deprecated kept for API stability; equals the npm install-family set. */
export const INSTALL_FAMILY: readonly string[] = [...NPM_INSTALL_SUBS];

const NPM_CONFLICT_LONG = new Set([
  '--userconfig', '--globalconfig', '--cache', '--prefix', '--chdir', '--global',
  '--workspace', '--workspaces', '--ignore-scripts', '--foreground-scripts',
  '--script-shell', '--config', '--registry', '--dist-tag', '--tag', '--omit',
  '--include', '--proxy', '--https-proxy', '--noproxy', '--strict-ssl', '--ca',
  '--cert', '--key', '--editor', '--node-version', '--yes',
]);
/** Bare-OK long options BEFORE the subcommand (provably valueless booleans). */
const NPM_BARE_OK = new Set([
  '--json', '--silent', '--quiet', '--verbose', '--no-color', '--version', '--help',
  '--no-update-notifier', '--no-audit', '--no-fund', '--audit', '--fund',
  '--no-save', '--save', '--save-dev', '--save-prod', '--save-optional',
  '--save-exact', '--no-package-lock', '--package-lock', '--dry-run',
  '--legacy-peer-deps',
]);
const YARN_CONFLICT_LONG = new Set([
  '--cwd', '--use-yarnrc', '--ignore-scripts', '--ignore-path', '--registry',
  '--cache-folder', '--config', '--global',
]);
const YARN_BARE_OK = new Set(['--silent', '--verbose', '--non-interactive', '--offline', '--version', '--help']);

const RAW_PM_BASENAMES = new Set(['npm', 'npm.cmd', 'npm.exe', 'npx', 'npx.cmd', 'npx.exe', 'yarn', 'yarn.cmd', 'yarn.exe', 'yarnpkg']);
/** Package names whose $bin: form resolves the pm CLI itself (B5 bypass). */
const RAW_PM_PACKAGES = new Set(['npm', 'npx', 'yarn', 'yarnpkg']);
const NODE_BASENAMES = new Set(['node', 'node.exe']);
const NPM_SCRIPT_BASENAMES = new Set(['npm-cli.js', 'npx-cli.js', 'yarn.js', 'yarnpkg.js']);
const basenameLower = (p: string): string => (p.split(/[\\/]/).pop() ?? '').toLowerCase();

/** B5 rule 1: raw package-manager invocation forms are rejected outright. */
export function assertCanonicalPmForm(cmd: readonly string[]): void {
  if (cmd.length === 0) return;
  const base = basenameLower(cmd[0]!);
  if (base && RAW_PM_BASENAMES.has(base)) {
    throw new CanaryError(
      `spec command starts with a raw package-manager executable ('${cmd[0]}'): only the $npm/$yarn tokens may invoke package managers — raw forms bypass Canary's isolation-flag policy entirely`,
      'raw-package-manager',
    );
  }
  if (base && NODE_BASENAMES.has(base) && cmd.length > 1 && basenameLower(cmd[1]!) && NPM_SCRIPT_BASENAMES.has(basenameLower(cmd[1]!))) {
    throw new CanaryError(
      `spec command runs '${cmd[1]}' directly through node: use the $npm token so Canary can enforce its isolation policy`,
      'raw-package-manager',
    );
  }
}

export interface PmPolicy {
  sub: string;
  /** index of the subcommand token within the SPEC argv */
  subIdx: number;
  family: 'install' | 'script' | 'info';
}

/**
 * B5 rules 2–5: closed-allowlist parse of a $npm/$yarn spec command.
 * Throws CanaryError on any shape Canary refuses to police; returns the
 * pinned subcommand + its family otherwise.
 */
export function pmArgvPolicy(cmd: readonly string[]): PmPolicy {
  const npm = cmd[0] === '$npm';
  const conflict = npm ? NPM_CONFLICT_LONG : YARN_CONFLICT_LONG;
  const bareOk = npm ? NPM_BARE_OK : YARN_BARE_OK;
  const installSubs = npm ? NPM_INSTALL_SUBS : YARN_INSTALL_SUBS;
  const scriptSubs = npm ? NPM_SCRIPT_SUBS : YARN_SCRIPT_SUBS;
  const infoSubs = npm ? NPM_INFO_SUBS : new Set<string>();
  let policy: PmPolicy | undefined;
  for (let k = 1; k < cmd.length; k++) {
    const tok = cmd[k]!;
    if (tok === '--') {
      if (policy === undefined) {
        throw new CanaryError(`spec command '${cmd.join(' ')}': '--' before the subcommand is not supported`, 'spec-dashdash-position');
      }
      if (policy.family === 'install') {
        throw new CanaryError(
          `spec command '${cmd.join(' ')}': '--' is not allowed for install-family commands — isolation flags appended after it would be dead weight (B5 bypass shape)`,
          'spec-dashdash-install',
        );
      }
      break; // script/info passthrough: remaining tokens are not npm's to parse
    }
    if (!tok.startsWith('-')) {
      if (policy === undefined) {
        const norm = tok.toLowerCase();
        const fam: PmPolicy['family'] | undefined =
          installSubs.has(norm) ? 'install' : scriptSubs.has(norm) ? 'script' : infoSubs.has(norm) ? 'info' : undefined;
        if (!fam) {
          throw new CanaryError(
            `subcommand '${tok}' is not allowed for ${cmd[0]}: Canary executes only its closed allowlist (npm: install-family, run/run-script/test, ls/view/show/info/help; yarn: install/add, run/test) — unknown or unvetted aliases are rejected rather than run without isolation policy`,
            'unsupported-subcommand',
          );
        }
        policy = { sub: norm, subIdx: k, family: fam };
      }
      continue;
    }
    if (!tok.startsWith('--')) {
      throw new CanaryError(
        `spec command contains short option '${tok}': Canary specs must use long-form flags (short value-taking options like -u shift subcommand detection past the install and silently skip isolation-flag injection)`,
        'spec-short-option',
      );
    }
    const eq = tok.indexOf('=');
    // Case-fold the option name for ALL set membership (red-team post-F8:
    // `--Userconfig=evil` must not sneak through exact matching).
    const name = (eq === -1 ? tok : tok.slice(0, eq)).toLowerCase();
    if (conflict.has(name)) {
      throw new CanaryError(
        `spec command contains isolation-conflicting flag '${name}': Canary pins userconfig/cache/scripts/registry policy and prefix/workspace resolution itself`,
        'spec-config-conflict',
      );
    }
    if (eq === -1 && policy === undefined && !bareOk.has(name)) {
      throw new CanaryError(
        `bare option '${name}' before the subcommand cannot be verified valueless — value-taking options before the subcommand skip isolation-flag injection; use '--flag=value' form or move options after the subcommand`,
        'spec-ambiguous-option',
      );
    }
  }
  if (policy === undefined) {
    throw new CanaryError(
      `spec command '${cmd.join(' ')}' has no recognizable ${cmd[0]} subcommand`,
      'unsupported-subcommand',
    );
  }
  return policy;
}

export class Recorder {
  private counts = new Map<string, number>();
  readonly facts: RoundFact[] = [];
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Expand spec tokens to concrete argv and ENFORCE Canary's isolation policy
   * on any package-manager command (audit B5). For install/update-family
   * subcommands the isolation flags are spliced in IMMEDIATELY AFTER the
   * subcommand (not appended at the end, which a user `--` would neutralise),
   * and the subcommand is validated against a closed allowlist before the
   * command is ever allowed to expand.
   */
  expandArgv(
    cmd: readonly string[],
    subs: { dep: string; baseline: string; candidate: string },
    resolveBin: (pkg: string, key?: string) => string,
  ): string[] {
    const d = this.deps;
    const tool = cmd[0];
    // B5.1: raw package-manager forms are rejected for EVERY spec command,
    // before the $npm/$yarn policy branch — otherwise a spec using a literal
    // `npm install` (tool not `$npm`) would skip the guard entirely.
    assertCanonicalPmForm(cmd);
    const isPm = tool === '$npm' || tool === '$yarn';
    let policy: PmPolicy | undefined;
    if (isPm) {
      policy = pmArgvPolicy(cmd);          // B5.2: closed-allowlist parse/rejection
    }

    // Expand every token, remembering the OUTPUT index each SPEC token lands
    // at so the install-family flags can be inserted right after the
    // subcommand's expanded position.
    const out: string[] = [];
    const specToOut = new Map<number, number>();
    cmd.forEach((raw, idx) => {
      specToOut.set(idx, out.length);
      const t = raw
        .replaceAll('{dep}', subs.dep)
        .replaceAll('{candidate}', subs.candidate)
        .replaceAll('{baseline}', subs.baseline);
      if (t === '$npm') out.push(process.execPath, d.npmCli);
      else if (t === '$yarn') {
        // npm-exec bootstrap of the pinned yarn itself must not run scripts (F6)
        out.push(process.execPath, d.npmCli, 'exec', '--yes', '--ignore-scripts',
          '--package', d.yarnPin ?? 'yarn@1.22.22', '--', 'yarn');
      } else if (t === '$tsc') out.push(process.execPath, resolveBin('typescript', 'tsc'));
      else if (t.startsWith('$bin:')) {
        const s = t.slice(5);
        const i = s.lastIndexOf('/');
        const pkg = (i === -1 ? s : s.slice(0, i)).toLowerCase();
        // B5: $bin:npm (or npx/yarn) resolves the package-manager's own binary
        // and would run WITHOUT the install-family injection — reject so the
        // only pm path is the policed $npm/$yarn tokens.
        if (RAW_PM_PACKAGES.has(pkg)) {
          throw new CanaryError(
            `spec command uses '$bin:${s}': resolving the package manager's own binary bypasses Canary's isolation policy — use the $npm/$yarn token`,
            'raw-package-manager',
          );
        }
        out.push(process.execPath, i === -1 ? resolveBin(s) : resolveBin(s.slice(0, i), s.slice(i + 1)));
      } else out.push(t);
    });

    if (policy && policy.family === 'install') {
      // insert right after the expanded subcommand token (sub maps to exactly
      // one out token: the bare subcommand word)
      const insertAt = (specToOut.get(policy.subIdx) ?? out.length - 1) + 1;
      const flags = tool === '$npm'
        ? ['--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps',
            '--userconfig', path.join(d.ws.root, 'empty.npmrc'),
            '--cache', path.join(d.ws.root, 'npm-cache'),
            '--registry', NPM_REGISTRY_PIN]
        : ['--ignore-scripts', '--non-interactive', '--no-progress',
            '--cache-folder', path.join(d.ws.root, 'yarn-cache')];
      out.splice(insertAt, 0, ...flags);
    }
    return out;
  }

  /** Execute one labeled step, write artifacts, return streams. Not a test round. */
  async step(label: string, argv: string[], timeoutSecs = 600): Promise<ExecResult> {    const n = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, n);
    const uniq = n === 1 ? label : `${label}-${n}`;
    const run = await (this.deps.run ?? runCommand)({
      ws: this.deps.ws,
      nodeDir: this.deps.nodeDir,
      argv: argv as [string, ...string[]],
      timeoutSecs,
    });
    const combined = run.stdout + run.stderr;
    const normOut = normalize(run.stdout, this.deps.pipeline);
    const normErr = normalize(run.stderr, this.deps.pipeline);
    fs.writeFileSync(path.join(this.deps.artifactsDir, `${uniq}.stdout.log`), run.stdout);
    fs.writeFileSync(path.join(this.deps.artifactsDir, `${uniq}.stderr.log`), run.stderr);
    fs.writeFileSync(path.join(this.deps.artifactsDir, `${uniq}.stdout.norm`), normOut);
    fs.writeFileSync(path.join(this.deps.artifactsDir, `${uniq}.stderr.norm`), normErr);
    return { label: uniq, run, combined, normOut, normErr };
  }

  /** Execute and record a measurement round of one arm. */
  async round(
    arm: 'baseline' | 'candidate', index: number, argv: string[], timeoutSecs = 600,
  ): Promise<ExecResult & { fact: RoundFact }> {
    const res = await this.step(`${arm}-${index}`, argv, timeoutSecs);
    const counts = parseSummaryCounts(res.combined);
    const fact: RoundFact = {
      arm,
      round: index,
      exitCode: res.run.exitCode,
      hasRunnerSummary: hasRunnerSummary(res.combined),
      // Audit B2: infra signatures are recognized REGARDLESS of exit code —
      // a harness can swallow an ECONNREFUSED and still exit 0. The
      // two-tier matcher (see isInfraOutput) keeps benign prose from
      // triggering this.
      infraSignal: isInfraOutput(res.combined),
      reportedPassing: counts.passing,
      reportedFailing: counts.failing,
      reportedPending: counts.pending,
      // Audit F13: failing-test identities are FIRST-CLASS evidence. Sorted
      // so that profile comparison is order-independent; classification uses
      // them (audit F2), the bundle persists them, the report renders them.
      failingTestNames: extractFailingTestNames(res.combined).sort(),
    };
    this.facts.push(fact);
    return { ...res, fact };
  }
}

export interface RoundEvidenceOut {
  arm: 'baseline' | 'candidate';
  round: number;
  exitCode: number;
  killedByTimeout: boolean;
  hasRunnerSummary: boolean;
  infraSignal?: boolean | undefined;
  reportedPassing?: number | undefined;
  reportedFailing?: number | undefined;
  reportedPending?: number | undefined;
  failingTestNames?: string[] | undefined;
  startedAt: string;
  durationMs: number;
  rawStdoutSha256: string;
  rawStderrSha256: string;
  normalizedStdoutSha256: string;
  normalizedStderrSha256: string;
  logPath: string;
  argv: string[];
  envKeys: string[];
}

export function roundEvidence(res: ExecResult, fact: RoundFact): RoundEvidenceOut {
  return {
    arm: fact.arm,
    round: fact.round,
    exitCode: fact.exitCode,
    killedByTimeout: res.run.killedByTimeout,
    hasRunnerSummary: fact.hasRunnerSummary,
    infraSignal: fact.infraSignal,
    ...(fact.reportedPassing !== undefined ? { reportedPassing: fact.reportedPassing } : {}),
    reportedFailing: fact.reportedFailing,
    ...(fact.reportedPending !== undefined ? { reportedPending: fact.reportedPending } : {}),
    ...(fact.failingTestNames ? { failingTestNames: [...fact.failingTestNames] } : {}),
    startedAt: new Date().toISOString(),
    durationMs: res.run.durationMs,
    rawStdoutSha256: sha256hex(res.run.stdout),
    rawStderrSha256: sha256hex(res.run.stderr),
    normalizedStdoutSha256: sha256hex(res.normOut),
    normalizedStderrSha256: sha256hex(res.normErr),
    logPath: `${res.label}.stdout.log`,
    argv: [...res.run.argv],
    envKeys: [...res.run.envKeys],
  };
}
