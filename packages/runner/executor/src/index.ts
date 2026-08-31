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
/**
 * Post-sol secondary: ALL line-oriented matchers/parsers normalize CR/CRLF
 * to LF at entry. Before this, a lone-CR stream (old-Mac style, some
 * progress reporters) was scanned as ONE line, so a real summary could hide
 * from the /m-anchored matchers — an asymmetry against the normalizers
 * (whose 'line-endings' rule has always collapsed them for the hashes).
 * Artifacts stay byte-exact; only the DERIVED facts see the normalized
 * view, and prove.ts re-derives through these same functions (parity).
 */
const toLf = (out: string): string => out.replace(/\r\n?/g, '\n');
const SUMMARY_LINE = /^\s*(?:\d+ (?:tests? )?(?:passed|failed)|\d+ (?:passing|failing)|Tests:\s*\d+ passed)\b/m;
export function hasRunnerSummary(out: string): boolean {
  return SUMMARY_LINE.test(toLf(out));
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
/**
 * PASS_GLYPH: lines reporting a PASSING test (√/✓). Their text is TEST prose
 * (titles may quote error phrases), never a harness complaint — HARD infra
 * patterns skip these lines only.
 *
 * PROGRESS_GLYPH: the SOFT errno matcher's skip set. It covers pass glyphs AND
 * failure/pending marker glyphs (✗ U+2717, ×, →, --): a failing test's TITLE
 * is equally prose (an honest test named "× connect ECONNREFUSED error" must
 * not false-INFRA the round). The deliberate exclusion is ✖ (U+2716,
 * HEAVY BALLOT X) — ava prints REAL infrastructure errors on ✖ lines, and
 * those must keep firing (proven by test, not comment).
 */
const SOFT_CODE = /\b(EADDRINUSE|ECONNREFUSED|ECONNRESET|EMFILE|EPERM|EACCES|EBUSY|ENOSPC|ENOENT|ETIMEDOUT)\b/;
const SOFT_SHAPE = /\b(?:error|errno|syscall|connect|listen|spawn|fatal|fail(?:ed|ure))\b/i;
const PASS_GLYPH = /^\s*(?:√|✓)/;
const PROGRESS_GLYPH = /^\s*(?:√|✓|✗|×|→|-{2,})/;
export function isInfraOutput(out: string): boolean {
  // Round-3 secondary: HARD patterns were scanned over the WHOLE output, so a
  // passing test whose TITLE quotes an error phrase ("√ throws on Cannot
  // find module") conservatively false-INFRA'd the entire round. They are now
  // line-scoped and skip pass-glyph lines; genuine error/stack lines never
  // start with a pass glyph.
  const lines = toLf(out).split('\n');
  if (INFRA_PATTERNS.some((re) => lines.some((line) => !PASS_GLYPH.test(line) && re.test(line)))) return true;
  return lines.some((line) =>
    !PROGRESS_GLYPH.test(line) && SOFT_CODE.test(line) && SOFT_SHAPE.test(line));
}

/**
 * Round-3 secondary: fatal-runtime-crash signatures. Before this, a round
 * that printed a VALID summary and THEN died (V8 heap OOM, native abort,
 * segfault) was indistinguishable from a clean run — the summary suppressed
 * infra suspicion and the crash rode free into a trustful verdict.
 *
 * The patterns are the EXACT process-death banners runtimes emit, chosen to
 * survive the prose trap that bedevils loose infra matching: an ordinary test
 * may print "aborted request" or "handles out of memory", so a case-
 * insensitive /\baborted\b/ or /out of memory/ would false-INFRA an honest
 * suite. We require the specific runtime phrasing (V8 "FATAL ERROR: … heap",
 * "JavaScript heap out of memory", the shell's "core dumped"/"Segmentation
 * fault", libc's "abort() called", or a bare SIGSEGV/SIGABRT name), and skip
 * pass-glyph lines just like the infra matcher.
 */
// Self-review N6: the V8 native CHECK-failure banner ('# Fatal error in,
// line 0' followed by a Runtime/OOM/Check failure line) printed NO keyword
// the old set matched — a post-summary native abort could therefore pose as
// an ordinary failing round. '# Fatal error in' is the exact V8 banner
// prefix (anchored to the line start); the classic OOM/heap, SIGSEGV/SIGABRT
// and shell 'core dumped' shapes remain.
const CRASH_LINE =
  /FATAL ERROR:.*\bheap\b|JavaScript heap out of memory|Segmentation fault|core dumped|abort\(\) called|\bSIGSEGV\b|\bSIGABRT\b|^\s*#\s*Fatal error in[ ,]/i;
export function hasCrashSignature(out: string): boolean {
  return toLf(out).split('\n').some((line) => !PASS_GLYPH.test(line) && CRASH_LINE.test(line));
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
 *  3. install/update family → Canary's isolation controls are APPENDED AS
 *     THE ARGV SUFFIX (post-sol RB-1: npm's CLI config layer is last-wins,
 *     so the final canonical occurrence is the EFFECTIVE one), and a `--`
 *     separator is rejected in these families so nothing can follow the
 *     suffix (which would otherwise turn it into dead weight);
 *  4. script/info families run without injection (own pinned scripts /
 *     read-only queries); `--` passthrough only exists after such a
 *     subcommand, where the subcommand is already positionally pinned;
 *  5. the F8 grammar rules stay: short options rejected, isolation-
 *     conflicting flags rejected in ANY position, unknown bare options before
 *     the subcommand rejected (option names case-folded);
 *  6. (round-3 B5) LITERAL spec executables are allowlisted: only `node` may
 *     start a non-token command — wrappers (cmd/powershell/env/sh/xargs/…),
 *     package-manager frontends (pnpm/bun/corepack/volta/…) and every other
 *     unenumerated executable are refused fail-closed, because their first
 *     token is not what they execute;
 *  7. (post-sol RB-1) OPTION SPELLINGS ARE POLICIED SEMANTICALLY, not
 *     textually. Empirically derived on npm 11.16/11.19 (pinned by an
 *     executed probe in executor.test.ts): npm's CLI layer applies
 *     unique-prefix ABBREVIATIONS (--ig → --ignore-scripts, --userc →
 *     --userconfig, --reg → --registry), `--no-` NEGATIONS, and
 *     LAST-WINS ordering within the CLI config layer — while ambiguous
 *     abbreviations, case variants and unknown flags are ignored with a
 *     warning. An exact-string denylist therefore cannot protect: every
 *     spelling-equivalent of a denied name is an open door. The fix closes
 *     the whole equivalence class from BOTH ends:
 *
 *     (a) INSTALL-FAMILY OPTION SURFACE IS A CLOSED ALLOWLIST of exact
 *         vetted spellings (NPM/YARN_INSTALL_OPTION_ALLOW). A token is
 *         accepted only if its case-folded name (before '=') matches an
 *         allow entry literally — abbreviations, camelCase, negations of
 *         unlisted keys and every unknown config (including the per-package
 *         family --@scope:registry / //…:_auth) are REJECTED, not parsed.
 *         Value-taking entries require the `=` form, so no user token can
 *         swallow a following argv slot. The allowlist is property-tested
 *         prefix-DISJOINT from the protected key universe: no accepted
 *         spelling can abbreviate or negate INTO a protected key.
 *
 *     (b) CANARY'S PROTECTED FLAGS ARE APPENDED LAST (argv suffix). npm's
 *         CLI layer is last-wins (probe-verified), so even a hypothetical
 *         future leak of a same-key spelling cannot change the EFFECTIVE
 *         configuration: Canary's canonical occurrence is the final one.
 *         `--` and short options remain rejected in this family, so nothing
 *         user-supplied can follow the block.
 *
 *     (c) NON-INSTALL FAMILIES (script/info, no injected config) keep the
 *         open-option posture (specs pass their own flags / `--` payloads),
 *         but the conflict check now RESOLVES spellings: any token whose
 *         case-folded, one-`no-`-stripped name is a PREFIX of a protected
 *         key (exact spellings included) is rejected, as is the whole
 *         per-package config family. `--userc` cannot retarget a run
 *         script's npmrc anymore either.
 *
 * Invariant (property-tested): IF an install-family command is accepted,
 * the executed argv ENDS with exactly one canonical occurrence of each of
 * --ignore-scripts, --userconfig, --cache, --registry (and the hygiene
 * pair), after every user-controlled token — so the EFFECTIVE package-
 * manager configuration of those keys is Canary's by npm's own semantics.
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

/**
 * Post-sol RB-1 — the PROTECTED CONFIG UNIVERSE: npm/yarn config keys whose
 * effective value must be Canary's (or Canary-determined) for the isolation
 * contract to hold: scripts execution, config-file sources, cache/registry
 * resolution, and everything that changes WHERE or HOW the package manager
 * installs (target root, cwd, global-ness, workspace selection, script
 * shell, TLS/proxy interception, version/tag selection, auto-confirm).
 * Matching happens on the RESOLVED key (see resolveOptionToken), so
 * abbreviations and negations of these names are covered by the prefix test.
 */
export const NPM_PROTECTED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'userconfig', 'globalconfig', 'config', 'cache', 'registry', 'prefix', 'chdir',
  'global', 'location', 'workspace', 'workspaces', 'ignore-scripts',
  'foreground-scripts', 'script-shell', 'omit', 'include', 'dist-tag', 'tag',
  'proxy', 'https-proxy', 'noproxy', 'strict-ssl', 'ca', 'cert', 'key',
  'editor', 'node-version', 'yes',
]);
export const YARN_PROTECTED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'cwd', 'use-yarnrc', 'ignore-scripts', 'ignore-path', 'registry',
  'cache-folder', 'config', 'global',
]);

/**
 * CLOSED INSTALL OPTION ALLOWLIST (exact spellings, case-folded). Only these
 * user options may accompany an install/update-family command; every one is
 * a boolean (bare or `=true|false`) or is listed in the *_VALUE_REQUIRED set
 * (which forces the `=` form so no bare token can consume a following argv
 * slot). The allowlist is property-tested prefix-disjoint from the protected
 * universe (executor.test.ts), so no accepted spelling can abbreviate or
 * negate INTO a protected key. Deliberately EXCLUDED: every abbreviable or
 * negatable relationship to protected keys, the per-package config family,
 * and anything not positively vetted for this command family.
 */
export const NPM_INSTALL_OPTION_ALLOW: ReadonlySet<string> = new Set([
  '--json', '--silent', '--quiet', '--verbose', '--no-color',
  '--no-audit', '--audit', '--no-fund', '--fund',
  '--no-save', '--save', '--save-dev', '--save-prod', '--save-optional', '--save-exact',
  '--no-package-lock', '--package-lock', '--legacy-peer-deps', '--dry-run',
  '--no-update-notifier',
]);
/** Allow entries that TAKE a value and therefore require the `=` form. */
export const NPM_INSTALL_VALUE_REQUIRED: ReadonlySet<string> = new Set([
  '--before', '--loglevel',
]);
export const YARN_INSTALL_OPTION_ALLOW: ReadonlySet<string> = new Set([
  '--frozen-lockfile', '--pure-lockfile', '--no-lockfile', '--check-files',
  '--update-checksums', '--ignore-engines', '--production', '--dev',
  '--offline', '--verbose', '--silent',
]);
const YARN_INSTALL_VALUE_REQUIRED: ReadonlySet<string> = new Set([
  '--loglevel', '--mutex', '--network-timeout',
]);

/** Bare-OK long options BEFORE the subcommand in NON-install families
 *  (provably valueless booleans; install families ignore this and use the
 *  closed allowlist above). */
const NPM_BARE_OK = new Set([
  '--json', '--silent', '--quiet', '--verbose', '--no-color', '--version', '--help',
  '--no-update-notifier', '--no-audit', '--no-fund', '--audit', '--fund',
  '--no-save', '--save', '--save-dev', '--save-prod', '--save-optional',
  '--save-exact', '--no-package-lock', '--package-lock', '--dry-run',
  '--legacy-peer-deps',
]);
const YARN_BARE_OK = new Set(['--silent', '--verbose', '--non-interactive', '--offline', '--version', '--help']);

/**
 * Normalize one long-option token into its RESOLVED config key (post-sol
 * RB-1). npm's observable CLI semantics (probe-verified on 11.16/11.19):
 * names are lower-case kebab; the value attaches via `=`; `--no-<key>`
 * negates (one strip only — `--noproxy` is its own key); everything else is
 * literal. Abbreviation is a PREFIX RELATION, expressed by callers via
 * touchesProtected — this function never expands.
 */
export function resolveOptionToken(tok: string): { name: string; value: string | undefined; negated: boolean } {
  const eq = tok.indexOf('=');
  let name = (eq === -1 ? tok : tok.slice(0, eq)).toLowerCase();
  if (name.startsWith('--')) name = name.slice(2);
  let negated = false;
  if (name.startsWith('no-')) { name = name.slice(3); negated = true; }
  return { name, value: eq === -1 ? undefined : tok.slice(eq + 1), negated };
}

/** The per-package config family: scoped registries, per-registry auth.
 *  These are genuine npm config keys (`--@scope:registry=…` verifies — see
 *  the executed probe) and CANNOT be neutralized by a later global
 *  `--registry`, so they are refused at resolution time everywhere. */
function isPerPackageConfigKey(name: string): boolean {
  return name.startsWith('@') || name.startsWith('//') || name.startsWith('_') || name.includes(':');
}

/**
 * True iff a RESOLVED option name can reach a protected key under npm's
 * abbreviation semantics: the token applies to key K iff K starts with the
 * token name (unique-prefix expansion, probe-verified direction). Case and
 * `no-` stripping happened in resolveOptionToken.
 */
function touchesProtected(name: string, universe: ReadonlySet<string>): string | undefined {
  if (isPerPackageConfigKey(name)) return name; // the whole family is protected
  for (const k of universe) if (k.startsWith(name)) return k;
  return undefined;
}

const RAW_PM_BASENAMES = new Set(['npm', 'npm.cmd', 'npm.exe', 'npx', 'npx.cmd', 'npx.exe', 'yarn', 'yarn.cmd', 'yarn.exe', 'yarnpkg']);
/** Package names whose $bin: form resolves the pm CLI itself (B5 bypass). */
const RAW_PM_PACKAGES = new Set(['npm', 'npx', 'yarn', 'yarnpkg']);
const NODE_BASENAMES = new Set(['node', 'node.exe']);
const NPM_SCRIPT_BASENAMES = new Set(['npm-cli.js', 'npx-cli.js', 'yarn.js', 'yarnpkg.js']);
const basenameLower = (p: string): string => (p.split(/[\\/]/).pop() ?? '').toLowerCase();

/**
 * Round-3 blocker 5: WRAPPER-MEDIATED EXECUTION. Round 3 proved the B5.1
 * first-token basename check was insufficient: `cmd /c npm install …`,
 * `powershell -Command "npm install …"`, `env npm install …`, `sh -c`,
 * `xargs npm`, and package-manager FRONTENDS (pnpm/bun/corepack/volta) all
 * start with an executable that is not itself a package manager, so they
 * passed assertCanonicalPmForm, skipped the $npm/$yarn policy branch, and
 * EXECUTED A PACKAGE MANAGER with zero isolation flags — the exact hole the
 * closed allowlist exists to prevent.
 *
 * The fix inverts the posture, as the audit demands: a small EXPLICIT
 * ALLOWLIST for literal spec executables. A spec command may only start with
 * the `$npm/$yarn/$tsc/$bin:` token forms (each policed at expansion) or a
 * bare `node` (script execution — what the offline fixtures and any sensible
 * test command actually use). EVERYTHING ELSE is rejected fail-closed: there
 * is no wrapper-name treadmill, because no wrapper is allowed.
 */
export const SPEC_LITERAL_EXECUTABLES: ReadonlySet<string> = new Set(['node', 'node.exe']);

/** Named here only for a diagnostic error message — the allowlist rejects
 *  them regardless; this is documentation that survives in the refusal text. */
const WRAPPER_BASENAMES = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'cscript', 'cscript.exe', 'wscript', 'wscript.exe', 'mshta', 'mshta.exe',
  'wmic', 'wmic.exe', 'runas', 'start', 'env', 'nohup', 'xargs', 'timeout',
  'sudo', 'doas', 'pkexec', 'wsl', 'wsl.exe', 'busybox', 'unshare', 'setsid', 'time',
]);
/** Package-manager frontends/alternate implementations — each internally
 *  resolves + runs installs, so even "script-like" wrappers of them escape
 *  the $npm policy surface entirely. Rejected by name for message clarity;
 *  the allowlist rejects them too. */
const PM_FRONTEND_BASENAMES = new Set([
  'pnpm', 'pnpm.cmd', 'pnpm.exe', 'pnpx', 'bun', 'bunx', 'bunx.cmd', 'corepack', 'corepack.cmd',
  'volta', 'cnpm', 'npmi', 'nvm', 'deno', 'aqua', 'proto', 'mise', 'rtx', 'yarn', 'yarnpkg',
]);

/** Round-3 B5: literal spec executables are allowlisted; wrappers and pm
 *  frontends are refused by name, anything else by fail-closed default. */
export function assertSupportedSpecExecutable(cmd: readonly string[]): void {
  if (cmd.length === 0) return;
  const first = cmd[0]!;
  if (first.startsWith('$')) return; // token forms are policed at expansion time
  const base = basenameLower(first);
  if (base && SPEC_LITERAL_EXECUTABLES.has(base)) {
    // Bypass shape: node <something-that-is-a-pm> [args] — e.g. ['node','npm','install']
    // runs whatever ./npm lives in the cwd. Arguments are checked as WHOLE
    // basenames (never substrings) so ['node','compare.js','npm-vs-yarn-report'] stands.
    for (let k = 1; k < cmd.length; k++) {
      const arg = basenameLower(cmd[k]!);
      if (RAW_PM_BASENAMES.has(arg) || NPM_SCRIPT_BASENAMES.has(arg)) {
        throw new CanaryError(
          `spec command '${cmd.join(' ')}' executes node with a package-manager file argument ('${cmd[k]}'): use the $npm token so Canary can enforce its isolation policy`,
          'wrapper-mediated-package-manager',
        );
      }
    }
    return;
  }
  if (base && WRAPPER_BASENAMES.has(base)) {
    throw new CanaryError(
      `spec command starts with the wrapper/interpreter '${first}': wrappers re-parse and execute their arguments OUTSIDE Canary's package-manager policy ('${first} … npm install …' was the round-3 B5 bypass) — spec commands may only start with $npm/$yarn/$tsc/$bin: tokens or node`,
      'wrapper-mediated-package-manager',
    );
  }
  if (base && PM_FRONTEND_BASENAMES.has(base)) {
    throw new CanaryError(
      `spec command starts with a package-manager frontend ('${first}'): pnpm/bun/corepack/volta-style frontends resolve and run installs with their own tooling, invisible to the $npm/$yarn isolation policy — not supported in v0.1`,
      'package-manager-frontend',
    );
  }
  throw new CanaryError(
    `spec command starts with '${first}', which is not on Canary's explicit allowlist of literal spec executables (node; token forms $npm/$yarn/$tsc/$bin:) — unenumerated executables cannot be policed for package-manager or isolation behavior (round-3 B5 fail-closed)`,
    'spec-executable-not-allowlisted',
  );
}

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
 * B5 rules 2–5 + post-sol RB-1: closed-allowlist parse of a $npm/$yarn spec
 * command, with SEMANTIC option policing. Pass 1 pins the subcommand/family
 * and the structural shapes (`--` position, short options). Pass 2 then
 * validates every option token npm itself will parse — install-family tokens
 * against the closed exact-spelling allowlist (protected-key spellings get
 * their own isolation-conflicting diagnosis), non-install tokens against the
 * resolved-key protected universe.
 * Throws CanaryError on any shape Canary refuses to police; returns the
 * pinned subcommand + its family otherwise.
 */
export function pmArgvPolicy(cmd: readonly string[]): PmPolicy {
  const npm = cmd[0] === '$npm';
  const bareOk = npm ? NPM_BARE_OK : YARN_BARE_OK;
  const installSubs = npm ? NPM_INSTALL_SUBS : YARN_INSTALL_SUBS;
  const scriptSubs = npm ? NPM_SCRIPT_SUBS : YARN_SCRIPT_SUBS;
  const infoSubs = npm ? NPM_INFO_SUBS : new Set<string>();
  const universe = npm ? NPM_PROTECTED_CONFIG_KEYS : YARN_PROTECTED_CONFIG_KEYS;
  const allow = npm ? NPM_INSTALL_OPTION_ALLOW : YARN_INSTALL_OPTION_ALLOW;
  const valueRequired = npm ? NPM_INSTALL_VALUE_REQUIRED : YARN_INSTALL_VALUE_REQUIRED;

  // ---- pass 1: structure (subcommand pinning, --, short options) ----
  let policy: PmPolicy | undefined;
  let passthroughFrom = cmd.length; // first index NOT parsed by npm (after `--`)
  for (let k = 1; k < cmd.length; k++) {
    const tok = cmd[k]!;
    if (tok === '--') {
      if (policy === undefined) {
        throw new CanaryError(`spec command '${cmd.join(' ')}': '--' before the subcommand is not supported`, 'spec-dashdash-position');
      }
      if (policy.family === 'install') {
        throw new CanaryError(
          `spec command '${cmd.join(' ')}': '--' is not allowed for install-family commands — Canary's appended isolation flags would land in the positionals (B5 bypass shape)`,
          'spec-dashdash-install',
        );
      }
      passthroughFrom = k; // script/info passthrough: remaining tokens are not npm's to parse
      break;
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
    // Family-INDEPENDENT conflict check, kept in scan order (a protected
    // spelling must outrank the diagnostic of any later structural surprise):
    // any token whose RESOLVED name (case-folded, one no- strip) reaches a
    // protected key — exact, abbreviation, negation, or per-package family.
    const early = cmd[k]!;
    const { name: earlyName } = resolveOptionToken(early);
    const touchedEarly = touchesProtected(earlyName, universe);
    if (touchedEarly !== undefined) {
      const eqE = early.indexOf('=');
      const fullNameE = (eqE === -1 ? early : early.slice(0, eqE)).toLowerCase();
      throw new CanaryError(
        `spec command contains isolation-conflicting flag '${fullNameE}'${touchedEarly === earlyName ? '' : ` (resolves to protected config '${touchedEarly}')`}: Canary pins userconfig/cache/scripts/registry policy and prefix/workspace/location resolution itself`,
        'spec-config-conflict',
      );
    }
  }
  if (policy === undefined) {
    throw new CanaryError(
      `spec command '${cmd.join(' ')}' has no recognizable ${cmd[0]} subcommand`,
      'unsupported-subcommand',
    );
  }

  // ---- pass 2: option tokens npm itself will parse. (The protected-key
  // conflict check already ran in pass 1 in scan order; what remains is
  // family-specific.) ----
  for (let k = 1; k < passthroughFrom; k++) {
    const tok = cmd[k]!;
    if (!tok.startsWith('--') || tok === '--') continue; // structure handled in pass 1
    const eq = tok.indexOf('=');
    const fullName = (eq === -1 ? tok : tok.slice(0, eq)).toLowerCase(); // exact-spelling key
    // (b) install family: the closed exact-spelling allowlist (RB-1).
    if (policy.family === 'install') {
      const known = allow.has(fullName) || valueRequired.has(fullName);
      if (!known) {
        throw new CanaryError(
          `install-family option '${fullName}' is not on Canary's closed option allowlist: only vetted exact spellings may accompany an install (abbreviations, negations and unvetted config keys are rejected because npm applies semantically equivalent forms — post-sol RB-1)`,
          'spec-install-option-not-allowed',
        );
      }
      if (valueRequired.has(fullName) && eq === -1) {
        throw new CanaryError(
          `install-family option '${fullName}' takes a value and must use the '--${fullName.slice(2)}=value' form: a bare value-taking option can swallow the following argv slot (npm probe: '--before --json' consumed the flag)`,
          'spec-install-option-valueless',
        );
      }
      if (allow.has(fullName) && eq !== -1 && tok.slice(eq + 1) !== 'true' && tok.slice(eq + 1) !== 'false') {
        throw new CanaryError(
          `install-family boolean option '${fullName}' only accepts '=true'/'=false' values, got '${tok}'`,
          'spec-install-option-valueless',
        );
      }
      continue;
    }
    // (c) non-install families keep the pre-subcommand bare-option ambiguity
    // rule (value-taking options before the subcommand shift detection).
    if (eq === -1 && k < policy.subIdx && !bareOk.has(fullName)) {
      throw new CanaryError(
        `bare option '${fullName}' before the subcommand cannot be verified valueless — value-taking options before the subcommand skip isolation-flag injection; use '--flag=value' form or move options after the subcommand`,
        'spec-ambiguous-option',
      );
    }
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
   * on any package-manager command (audit B5, post-sol RB-1). For install/-
   * update-family subcommands the isolation flags are APPENDED LAST (npm's
   * CLI layer is last-wins, probe-verified), the option surface is a closed
   * exact-spelling allowlist prefix-disjoint from the protected keys, and
   * the subcommand is validated against a closed allowlist before the
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
    // Round-3 B5: literal (non-token) spec executables are allowlisted. This
    // closes the wrapper-mediated bypass (cmd/powershell/env/sh + a package
    // manager argument) and the frontend bypass (pnpm/bun/corepack) that the
    // first-token basename check alone could not see. Runs for EVERY spec
    // command, before expansion.
    assertSupportedSpecExecutable(cmd);
    const isPm = tool === '$npm' || tool === '$yarn';
    let policy: PmPolicy | undefined;
    if (isPm) {
      policy = pmArgvPolicy(cmd);          // B5.2 + RB-1: closed-allowlist parse/rejection
    }

    // Expand every token. The install-family flags are APPENDED LAST (RB-1):
    // npm's CLI config layer is last-wins (probe-verified on 11.16/11.19),
    // so a suffix position makes the EFFECTIVE protected configuration
    // structurally Canary's no matter how an accepted user token was
    // spelled or positioned.
    const out: string[] = [];
    cmd.forEach((raw) => {
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
      // APPEND as the argv suffix (RB-1): the last occurrence of a CLI config
      // key wins, so nothing user-controlled can follow this block — `--` and
      // short options are rejected in this family, and every accepted option
      // spelling is allowlisted and prefix-disjoint from these keys.
      const flags = tool === '$npm'
        ? ['--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps',
            '--userconfig', path.join(d.ws.root, 'empty.npmrc'),
            '--cache', path.join(d.ws.root, 'npm-cache'),
            '--registry', NPM_REGISTRY_PIN]
        : ['--ignore-scripts', '--non-interactive', '--no-progress',
            '--cache-folder', path.join(d.ws.root, 'yarn-cache')];
      out.push(...flags);
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
    const crashed = hasCrashSignature(res.combined);
    const sweepFailed = res.run.sweepFailed === true;
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
      // Round-3 secondaries: a post-summary fatal crash (byte-observable) and
      // an incomplete containment sweep (kernel-observable) now reach the
      // decision table via infraCause rule 1 instead of riding silently into
      // a trustful verdict.
      ...(crashed ? { crashSignal: true } : {}),
      ...(sweepFailed ? { sweepFailed: true } : {}),
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
  crashSignal?: boolean | undefined;
  sweepFailed?: boolean | undefined;
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
    // Round-3 secondaries: crashSignal IS byte-observable, so the prove path
    // re-derives and re-checks it against the artifact (verifyArtifact
    // -Semantics/verifyClassificationDerivation). sweepFailed is a post-exit
    // kernel observation the streams cannot carry — it is persisted here and
    // consumed by infraCause, but cannot be byte-re-derived. (Unlike
    // killedByTimeout, which is at least pinned through the proof-pinned
    // exitCode === -1 correlation, sweepFailed has NO independent anchor —
    // integrity-only. Documented in SECURITY.md "Honest integrity limits".)
    ...(fact.crashSignal ? { crashSignal: true } : {}),
    ...(fact.sweepFailed ? { sweepFailed: true } : {}),
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
