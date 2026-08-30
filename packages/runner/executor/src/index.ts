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

import { runCommand, type RunOptions, type RunOutcome, type WorkspaceLayout } from '@canary-rn/support';
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

export const INFRA_PATTERNS: readonly RegExp[] = [
  /ERR_MODULE_NOT_FOUND/, /Cannot find module/, /ReferenceError: require is not defined/,
  /ERR_REQUIRE_ESM/, /ERESOLVE/, /ETARGET/, /npm error code/, /error Command failed/,
  /SyntaxError: Unexpected token/,
  // deterministic environmental failures that must never masquerade as drift (F1/F2):
  /EADDRINUSE/, /ECONNREFUSED/, /ECONNRESET/, /EMFILE/, /EPERM/, /EBUSY/, /ENOSPC/,
];
export function isInfraOutput(out: string): boolean {
  return INFRA_PATTERNS.some((re) => re.test(out));
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
   * (install|i|ci|add) — detected by scanning spec tokens, not fixed
   * positions (red-team F6: `--loglevel` before `install`, or `ci`, used to
   * silently skip all guards).
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
      // first meaningful (non-option) spec token after the tool token
      const sub = cmd.slice(1).find((x) => !x.startsWith('-'));
      if (sub && ['install', 'i', 'ci', 'add'].includes(sub)) {
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
  async step(label: string, argv: string[], timeoutSecs = 600): Promise<ExecResult> {
    const n = (this.counts.get(label) ?? 0) + 1;
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
      infraSignal: res.run.exitCode !== 0 && isInfraOutput(res.combined),
      reportedFailing: counts.failing,
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
  reportedFailing?: number | undefined;
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
    reportedFailing: fact.reportedFailing,
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
