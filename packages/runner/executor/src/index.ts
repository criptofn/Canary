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
 * Audit F8 — isolation-flag injection must be impossible to dodge by npm's
 * own argv grammar. The old detector (`first token not starting with '-'`)
 * was shifted by VALUE-TAKING options: `$npm -u evil.npmrc install x`
 * "detected" `evil.npmrc` as the subcommand, silently skipping ALL isolation
 * flags. The contract now:
 *
 *  1. subcommand = first non-option token, where every preceding option must
 *     be self-describing (`--key=value`) or a known valueless boolean — an
 *     unknown bare option THROWS instead of being guessed at (guessing in
 *     either direction is the bypass);
 *  2. isolation-conflicting npm/yarn config flags are rejected ANYWHERE
 *     before `--` (npm honors `--prefix`, `--userconfig`, `--registry`, ...
 *     in both positions, and Canary's trailing injection does not override
 *     keys it never injects, e.g. prefix);
 *  3. short options (`-u`, clusters) are rejected outright: every legitimate
 *     Canary spec form is long-form, so there is nothing to parse-loose;
 *  4. `exec|x|dlx|shell|explore` are rejected: they fetch and run THIRD-PARTY
 *     packages, where trailing injected flags would land after any `--`
 *     separator as dead weight and script isolation would evaporate.
 */
export const INSTALL_FAMILY: readonly string[] = ['install', 'i', 'ci', 'add'];
export const FORBIDDEN_PM_SUBS: readonly string[] = ['exec', 'x', 'dlx', 'shell', 'explore', 'edit', 'link'];

const NPM_CONFLICT_LONG = new Set([
  '--userconfig', '--globalconfig', '--cache', '--prefix', '--chdir', '--global',
  '--workspace', '--workspaces', '--ignore-scripts', '--foreground-scripts',
  '--script-shell', '--config', '--registry', '--dist-tag', '--tag', '--omit',
  '--include', '--proxy', '--https-proxy', '--noproxy', '--strict-ssl', '--ca',
  '--cert', '--key', '--editor', '--node-version',
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
  '--cache-folder', '--config',
]);
const YARN_BARE_OK = new Set(['--silent', '--verbose', '--non-interactive', '--offline', '--version', '--help']);

/** Throws CanaryError on any $npm/$yarn argv shape that could dodge isolation. */
export function pmArgvGuard(cmd: readonly string[]): string | undefined {
  const npm = cmd[0] === '$npm';
  const conflict = npm ? NPM_CONFLICT_LONG : YARN_CONFLICT_LONG;
  const bareOk = npm ? NPM_BARE_OK : YARN_BARE_OK;
  let sub: string | undefined;
  for (let k = 1; k < cmd.length; k++) {
    const tok = cmd[k]!;
    if (tok === '--') break; // everything after is positional/script args
    if (!tok.startsWith('-')) {
      if (sub === undefined) {
        sub = tok;
        if (FORBIDDEN_PM_SUBS.includes(tok)) {
          throw new CanaryError(
            `spec command '${cmd[0]} ${tok}' is not allowed: it fetches/runs outside the install-family isolation injection (v0.1 contract)`,
            'spec-forbidden-subcommand',
          );
        }
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
    // Case-fold the option name for ALL set membership: the conflict/bare-ok
    // sets are lowercase, and we refuse to bet the isolation guarantee on
    // whether npm's option parser happens to be case-sensitive (red-team
    // post-F8: `--Userconfig=evil` must not sneak through exact matching).
    const name = (eq === -1 ? tok : tok.slice(0, eq)).toLowerCase();
    if (conflict.has(name)) {
      throw new CanaryError(
        `spec command contains isolation-conflicting flag '${name}': Canary pins userconfig/cache/scripts policy and registry/prefix/workspace resolution itself`,
        'spec-config-conflict',
      );
    }
    if (eq === -1 && sub === undefined && !bareOk.has(name)) {
      throw new CanaryError(
        `bare option '${name}' before the subcommand cannot be verified valueless — value-taking options before the subcommand skip isolation-flag injection; use '--flag=value' form or move options after the subcommand`,
        'spec-ambiguous-option',
      );
    }
  }
  return sub;
}

export class Recorder {
  private counts = new Map<string, number>();
  readonly facts: RoundFact[] = [];
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Expand spec tokens to concrete argv and ENFORCE isolation flags on any
   * package-manager invocation whose subcommand is install-family
   * (install|i|ci|add) — with the audit-F8 argv guard (pmArgvGuard) making
   * silent detection-shift impossible and rejecting conflicting flags.
   */
  expandArgv(
    cmd: readonly string[],
    subs: { dep: string; baseline: string; candidate: string },
    resolveBin: (pkg: string, key?: string) => string,
  ): string[] {
    const d = this.deps;
    const out: string[] = [];
    for (const raw of cmd) {
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
        out.push(process.execPath, i === -1 ? resolveBin(s) : resolveBin(s.slice(0, i), s.slice(i + 1)));
      } else out.push(t);
    }

    const tool = cmd[0];
    if (tool === '$npm' || tool === '$yarn') {
      // Audit F8: unambiguous subcommand detection + conflict/forbidden argv
      // rejection (the old find(!startsWith('-')) could be shifted by a
      // value-taking option and silently skip ALL isolation flags).
      const sub = pmArgvGuard(cmd);
      if (sub && INSTALL_FAMILY.includes(sub)) {
        if (tool === '$npm') {
          out.push(
            '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps',
            '--userconfig', path.join(d.ws.root, 'empty.npmrc'),
            '--cache', path.join(d.ws.root, 'npm-cache'),
          );
        } else {
          out.push('--ignore-scripts', '--non-interactive',
            '--cache-folder', path.join(d.ws.root, 'yarn-cache'));
        }
      }
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
