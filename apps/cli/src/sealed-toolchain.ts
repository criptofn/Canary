/**
 * AUDIT BLOCKER 6 (v1.5) — THE SEALED TOOLCHAIN, AND WHO IS TO BLAME WHEN A CHECK FAILS.
 *
 * THE DEFECT THIS FILE EXISTS FOR, as the auditor reproduced it on commit a004f55 and as
 * tooling/probes/v15-realworld-gate-env.mjs measures on this host: a clean project whose declared
 * check is `npm test` → `java -version` PASSES outside Canary and FAILS inside it, because a sealed
 * step child gets `sanitizedEnv` — `PATH` = the Node install dir + the OS-managed dirs, and nothing
 * else (12 entries against the shell's 41; `python`, `java`, `git` invisible; `JAVA_HOME` absent).
 * Canary then printed *"That is your project talking, not Canary."* — a FALSE attribution, because
 * the project's own command passes on the same host outside Canary's restriction.
 *
 * TWO THINGS ARE FIXED HERE, AND THEY ARE DIFFERENT THINGS.
 *
 * 1. THE ATTRIBUTION. `attributeStepFailure` answers "is Canary's own environment the cause?" from
 *    MEASUREMENTS, never from the shape of the output alone:
 *      - Canary's own resolution refused the program (the step never ran): environment;
 *      - a toolchain directory the OPERATOR authorized at setup is gone: environment;
 *      - the child's output reports a program it could not find AND that program genuinely does not
 *        resolve in the directories the child was handed: environment.
 *    The third rule is deliberately two-sided. An agent that PRINTS "java: not found" from a failing
 *    test cannot move the message, because the same function walks the sealed directories itself and
 *    finds `java` where it belongs; and a program that npm's own script PATH provides (a project's
 *    `node_modules/.bin/tsc`, say) is not an environment problem either, so those directories are
 *    part of the walk. Nothing here changes a VERDICT — a failing check still fails, still
 *    `NEEDS ATTENTION`, still exit 2. What changes is that Canary no longer blames the project for a
 *    restriction Canary itself imposed, and the two outcomes now have different words:
 *      PROJECT CHECK FAILURE
 *      CANARY SEALED ENVIRONMENT CANNOT RESOLVE REQUIRED TOOLCHAIN
 *
 * 2. THE NARROWEST WAY OUT. `trustedDirs()`/`resolveProgram` already pin the PROGRAM each step names
 *    to an absolute path, and that stays exactly as it was: the plan's own program is never resolved
 *    through PATH. What no pin can reach is the TRANSITIVE case this blocker is about — `npm test`
 *    spawns whatever the project's own scripts spawn (`java`, `python`, `git`), and that resolution
 *    happens inside the child, through the PATH the child was handed. So the operator can now name
 *    executable DIRECTORIES at setup (`canary setup --toolchain-dir <dir>`); they are validated,
 *    sealed into the local config, and appended to the sealed step PATH after the Node install dir
 *    and the OS dirs. This is NOT the calling PATH: `process.env.PATH` is still ignored at
 *    verification time, a directory is authority only because a human named it at the one
 *    authorizing moment, and a directory the repository can write is refused outright, so a worker
 *    cannot authorize its own shim. Nothing is trusted merely because it is on PATH.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The two outcomes, in the product's own vocabulary. */
export const PROJECT_CHECK_FAILURE = 'PROJECT CHECK FAILURE';
export const SEALED_ENV_CANNOT_RESOLVE = 'CANARY SEALED ENVIRONMENT CANNOT RESOLVE REQUIRED TOOLCHAIN';

/**
 * Programs whose presence is recorded when Canary is set up. RECORDED EVIDENCE, not authority: the
 * inventory only ever appears in a remediation sentence ("java was at C:\...\bin when Canary was set
 * up — authorize that directory"). Nothing is executed from it, and no verdict reads it.
 */
export const TOOLCHAIN_CANDIDATES: readonly string[] = [
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3', 'py', 'pip', 'pip3', 'pytest',
  'java', 'javac', 'mvn', 'gradle',
  'git', 'sh', 'bash', 'make', 'cmake',
  'go', 'cargo', 'rustc', 'dotnet', 'ruby', 'php', 'swift',
];

/** What setup sealed, in the local config. `dirs` is the authority; `found` is evidence. */
export interface ToolchainSeal {
  /** Operator-authorized executable directories, absolute, sealed at setup time. */
  dirs: string[];
  /** Where the OPERATOR's PATH resolved each candidate AT SETUP TIME (evidence for remediation). */
  found: Record<string, string | null>;
  at: string;
}

export function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env['PATH'] ?? '').split(path.delimiter).map((d) => d.trim()).filter((d) => d.length > 0);
}

/** The executable-name spellings an OS loader would try, in order. */
export function programNames(program: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`, program] : [program];
}

/**
 * Does `program` resolve in exactly these directories? This is the OS loader's walk, re-implemented
 * so a claim about the sealed environment is a MEASUREMENT of that environment and not a guess. No
 * shell is involved, so a shell builtin can never be mistaken for an executable.
 */
export function resolvesIn(program: string, dirs: readonly string[], platform: NodeJS.Platform = process.platform): string | null {
  if (path.isAbsolute(program)) {
    try { return fs.statSync(program).isFile() ? program : null; } catch { return null; }
  }
  for (const dir of dirs) {
    for (const name of programNames(program, platform)) {
      const abs = path.join(dir, name);
      try { if (fs.statSync(abs).isFile()) return abs; } catch { /* keep walking */ }
    }
  }
  return null;
}

/**
 * The `node_modules/.bin` directories npm prepends to a script's PATH for a step running in `cwd`
 * (one per ancestor package directory). Included in the resolution walk so that a MISSING
 * project-local tool is never reported as Canary's environment being too narrow.
 */
export function npmScriptDirs(cwd: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    out.push(path.join(dir, 'node_modules', '.bin'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (out.length > 24) break;
  }
  return out;
}

/**
 * Accept or refuse a directory the OPERATOR named. Fail closed, and refuse the one source of
 * authority that would make the whole mechanism theatre: a directory inside the repository, i.e.
 * inside the one tree the worker Canary is checking can write.
 */
export function validateToolchainDir(root: string, dir: string): { ok: true; dir: string } | { ok: false; problem: string } {
  if (typeof dir !== 'string' || dir.trim().length === 0) return { ok: false, problem: 'empty path' };
  if (!path.isAbsolute(dir)) return { ok: false, problem: `not an absolute path: ${dir}` };
  let real: string;
  try { real = fs.realpathSync.native(dir); } catch { return { ok: false, problem: `does not exist: ${dir}` }; }
  let isDir = false;
  try { isDir = fs.statSync(real).isDirectory(); } catch { isDir = false; }
  if (!isDir) return { ok: false, problem: `not a directory: ${dir}` };
  const rel = (() => {
    try { return path.relative(fs.realpathSync.native(root), real); } catch { return null; }
  })();
  if (rel === null) return { ok: false, problem: `could not resolve against the repository: ${dir}` };
  const insideRepo = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (insideRepo) {
    return { ok: false, problem: `${dir} is inside the repository — a directory the project (and therefore the worker) can write is not a trusted source of executables` };
  }
  return { ok: true, dir: real };
}

/** MEASURED at setup (the one authorizing moment): where does the OPERATOR's PATH resolve each candidate? */
export function inventoryOperatorToolchain(pathValue: string, platform: NodeJS.Platform = process.platform): Record<string, string | null> {
  const dirs = pathValue.split(path.delimiter).map((d) => d.trim()).filter((d) => d.length > 0);
  const found: Record<string, string | null> = {};
  for (const name of TOOLCHAIN_CANDIDATES) {
    let hit: string | null = null;
    for (const dir of dirs) {
      for (const candidate of programNames(name, platform)) {
        const abs = path.join(dir, candidate);
        try { if (fs.statSync(abs).isFile()) { hit = abs; break; } } catch { /* keep walking */ }
      }
      if (hit !== null) break;
    }
    found[name] = hit;
  }
  return found;
}

/**
 * The programs a child said it could not find, read from the child's own output.
 *
 * These are the loaders' published failure shapes, measured rather than imagined: cmd.exe
 * (`'git' is not recognized as an internal or external command`, exit 9009), POSIX sh
 * (`git: not found` / `command not found: git`, exit 127), PowerShell, Node's spawn ENOENT, and Go's
 * exec lookup error — plus the LOCALIZED cmd/PowerShell sentence this repository's own host prints
 * (`Der Befehl "git" ist entweder falsch geschrieben oder konnte nicht gefunden werden.`, MEASURED by
 * tooling/probes/v15-sealed-toolchain.mjs, which failed on its first run for exactly this reason).
 *
 * The locale list is NOT assumed to be complete, so there is a second, locale-free door: exit 9009 is
 * cmd.exe's own "command not found" and 127 is the POSIX shell's, and when the child exited with one
 * of those, the program it named in quotes is taken — but ONLY when that name is one of the KNOWN
 * toolchain programs below. That restriction is what keeps a failing test that merely mentions a
 * quoted word from being read as a missing executable.
 */
export function notFoundPrograms(output: string, exitCode?: number | null): string[] {
  const names = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return;
    const name = raw.trim();
    if (name.length === 0 || name.length > 64) return;
    if (!/^[A-Za-z0-9._+-]+$/.test(name)) return;
    names.add(name);
  };
  const patterns: RegExp[] = [
    /['"`]([A-Za-z0-9._+-]{1,64})['"`]\s+is not recognized as an internal or external command/g,
    /The term '([A-Za-z0-9._+-]{1,64})' is not recognized/g,
    /([A-Za-z0-9._+-]{1,64}):\s+(?:command )?not found/g,
    /command not found:\s*([A-Za-z0-9._+-]{1,64})/g,
    /spawn(?:Sync)?\s+([A-Za-z0-9._+-]{1,64})\s+ENOENT/g,
    /exec:\s*"([A-Za-z0-9._+-]{1,64})":\s*executable file not found/g,
    // de-DE cmd.exe / PowerShell ("Der Befehl/Ausdruck \"git\" ist entweder falsch geschrieben oder
    // konnte nicht gefunden werden.") — the shape this host actually produced.
    /Der (?:Befehl|Ausdruck) ["'„]([A-Za-z0-9._+-]{1,64})["'“]/g,
    /['"„]([A-Za-z0-9._+-]{1,64})["'“]\s+wurde nicht gefunden/g,
  ];
  for (const re of patterns) {
    for (const m of output.matchAll(re)) add(m[1]);
  }
  if (exitCode === 9009 || exitCode === 127) {
    for (const m of output.matchAll(/["'„“]([A-Za-z0-9._+-]{1,64})["'“”]/g)) {
      if (TOOLCHAIN_CANDIDATES.includes(m[1] as string)) add(m[1]);
    }
  }
  return [...names].sort();
}

export interface FailureAttribution {
  cause: 'project' | 'environment';
  /** Programs the child needed and Canary's sealed environment does not provide. */
  missing: string[];
  /** One line for the product's verdict, starting with the vocabulary word for the outcome. */
  reason: string;
  /** The one next step for the human/operator. */
  next: string;
}

export interface AttributeInput {
  kind: string;
  /** The sealed plan's script name (for the message). */
  script: string;
  exitCode: number | null;
  output: string;
  /** The directories the step child was actually handed (sealed env PATH entries + npm's own). */
  childPathDirs: readonly string[];
  /** Operator-authorized directories that NO LONGER EXIST at verification time. */
  vanishedDirs: readonly string[];
  seal: ToolchainSeal | null;
}

/** Where the operator's own environment had this program when Canary was set up (evidence only). */
function suggestDirFor(program: string, seal: ToolchainSeal | null): string | null {
  const hit = seal?.found?.[program];
  if (typeof hit !== 'string' || hit.length === 0) return null;
  return path.dirname(hit);
}

/**
 * The project-failure line. It KEEPS the sentence the product already printed for this case
 * ("your project's own checks did not pass … That is your project talking, not Canary.") because that
 * sentence was TRUE here and existing consumers read it — the defect was never this branch, it was
 * this branch being printed when the cause was Canary's own restriction. Only the vocabulary word
 * (`PROJECT CHECK FAILURE`) and the named step are new.
 */
function projectFailureReason(kinds: readonly string[], detail?: string): string {
  return `${PROJECT_CHECK_FAILURE} — your project's own checks did not pass (${kinds.join(', ')}). `
    + `${detail === undefined ? '' : `${detail} `}That is your project talking, not Canary.`;
}

export function attributeStepFailure(input: AttributeInput): FailureAttribution {
  const { kind, script, exitCode, output, childPathDirs, vanishedDirs, seal } = input;
  const reported = notFoundPrograms(output, exitCode);

  // 1. The step never ran at all (resolution refused, or the spawn itself failed): infrastructure,
  //    not a test result. Nothing about the project was measured, so nothing about it may be claimed.
  //    When an operator-authorized directory has ALSO vanished, that is the concrete cause and it is
  //    named here rather than left to a generic sentence.
  if (exitCode === null) {
    const reason = vanishedDirs.length > 0
      ? `${SEALED_ENV_CANNOT_RESOLVE} — the toolchain directory sealed at setup is gone: ${vanishedDirs[0]}. `
        + `The ${kind} check ("${script}") could not be run at all, so nothing about the project was measured.`
      : `${SEALED_ENV_CANNOT_RESOLVE} — the ${kind} check ("${script}") could not be run at all, so nothing about the project was measured.`;
    return {
      cause: 'environment', missing: [],
      reason,
      next: vanishedDirs.length > 0
        ? `restore it, or re-authorize where it lives now: canary setup --toolchain-dir "${vanishedDirs[0]}"`
        : 'install the tool into a directory you authorize, then: canary setup --toolchain-dir "<that directory>"',
    };
  }

  // 2. The child named a program it could not find, and the sealed directories confirm it is not
  //    there. BOTH halves are required: an agent printing "java: not found" cannot move the message
  //    while `java` resolves in the directories its child was handed, and a project-local tool npm
  //    provides is not an environment question. A vanished authorized directory is reported here only
  //    when the child's own output shows a missing program — otherwise a genuinely failing test would
  //    be blamed on Canary's environment, which is the same defect in the other direction.
  const missing = reported.filter((name) => resolvesIn(name, childPathDirs) === null);
  if (missing.length > 0) {
    const list = missing.map((m) => {
      const dir = suggestDirFor(m, seal);
      return dir === null ? m : `${m} (your environment had it at ${dir} when Canary was set up)`;
    }).join(', ');
    const gone = vanishedDirs.length > 0 ? ` A toolchain directory sealed at setup is also gone: ${vanishedDirs[0]}.` : '';
    const reason = `${SEALED_ENV_CANNOT_RESOLVE} — the ${kind} check ("${script}") needed ${list}. `
      + 'Canary runs your checks without your shell\'s PATH on purpose (a program planted earlier on that PATH would be executed as Canary\'s own authority). '
      + `This is NOT your project failing.${gone}`;
    const first = missing[0] as string;
    const dir = vanishedDirs.length > 0 ? vanishedDirs[0] as string : suggestDirFor(first, seal);
    return {
      cause: 'environment', missing,
      reason,
      next: dir === null
        ? `install ${missing.join(', ')} into a directory you authorize, then: canary setup --toolchain-dir "<that directory>"`
        : `authorize the directory that has it: canary setup --toolchain-dir "${dir}"`,
    };
  }

  // 3. Everything the child complained about resolves inside the sealed environment: this is the
  //    project's own failure, and Canary says so with the project's name on it.
  return {
    cause: 'project', missing: [],
    reason: projectFailureReason([kind], `The ${kind} check ("${script}") ran in the sealed environment and exited ${String(exitCode)}.`),
    next: 'fix the failing check, then: canary doctor',
  };
}

/** One attribution for a whole failed run: the environment cause WINS, and every failing step is named. */
export function attributeFailures(inputs: AttributeInput[]): FailureAttribution {
  const all = inputs.map(attributeStepFailure);
  const env = all.filter((a) => a.cause === 'environment');
  if (env.length > 0) {
    return {
      cause: 'environment',
      missing: [...new Set(env.flatMap((a) => a.missing))].sort(),
      reason: env.map((a) => a.reason).join(' '),
      // EVERY remediation is printed: two failing checks can need two different directories, and
      // naming only the first would leave the operator to guess the second.
      next: [...new Set(env.map((a) => a.next))].join(' | '),
    };
  }
  // Nothing was the environment's doing: one line, naming every check that failed.
  const kinds = [...new Set(inputs.map((i) => i.kind))];
  return { cause: 'project', missing: [], reason: projectFailureReason(kinds), next: 'fix the failing check, then: canary doctor' };
}

/** Only used to keep the temp-dir reasoning in one place for callers that materialize a fixture. */
export const ISOLATED_HOME_BASE = os.tmpdir();
