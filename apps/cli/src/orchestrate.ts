/**
 * 1.1 §22 — the invisible workflow.
 *
 * The expert primitives (`task` → `isolate` → `isolate --verify` → `isolate
 * --promote`, with `accept` for subjective duties) are the trust boundary, and
 * they stay exactly as they are. What an ordinary user should not have to do is
 * remember them. This file is orchestration ONLY: every step delegates to the
 * primitive that owns it, so there is no second implementation of registration,
 * verification or promotion — and therefore no second place for a gate to be
 * weakened.
 *
 *   canary work <name> "<intent>"     register the intent, open the candidate,
 *                                     tell the worker where to work and what
 *                                     will be demanded of it
 *   canary finish <name>              verify the candidate from outside it, then
 *                                     promote IF the objective proof holds; if a
 *                                     subjective duty is open, stop and hand the
 *                                     decision to a human
 *
 * Two properties this must never lose:
 *   - `finish` promotes only what `isolate --verify` just proved, and promotion
 *     re-verifies LIVE on its own (the existing M8 rule). A stored PASS is never
 *     replayed.
 *   - `finish` never closes a subjective duty. Aesthetics and "feel" still need
 *     `canary accept` in an interactive terminal, and the workflow says so
 *     instead of pretending a green plan was enough.
 */
import { cmdIsolate } from './candidate.js';
import { cmdTask, findRepoRoot, Out, parseGlobals, readConfig, unboundRequirements } from './onboarding.js';

/** Flags the delegated primitive needs, minus the ones that shape OUR output:
 *  forwarding `--json` would make two commands each print an envelope, and a
 *  consumer must always see exactly one object on stdout. */
const forwarded = (args: string[]): string[] => args.filter((a) => a !== '--json' && a !== '--verbose' && a !== '--yes');

/** `canary work <name> "<intent>" [--kind k] [--requirement "…"]…`
 *
 * Registration happens BEFORE isolation on purpose: the candidate record freezes
 * the task at isolation, so the work is judged against the intent as it was
 * understood when the worker started. Registering later cannot mint authority —
 * it only adds duties. */
export async function cmdWork(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'work' });
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is nothing here to attach work to.', 'cd into your project, then: canary work <name> "<what to do>"'); return 2; }
  o.context({ root });

  // The name is the first positional; the intent is everything up to the FIRST flag.
  //
  // MEASURED BUG, reported by an AI agent under test and reproduced here: the previous
  // version collected `rest.filter(a => !a.startsWith('--'))` as the intent and
  // forwarded only the flag TOKENS (`--kind`, `--requirement`), so
  //   canary work c1 "add the rules" --kind multi --requirement "must X"
  // registered an intent of "add the rules multi must X" AND lost both values. The
  // consequence is the bad direction: the user explicitly asked for obligations and
  // Canary silently registered FEWER, i.e. weaker verification than the human
  // authorized. Flags and their values are now forwarded verbatim.
  const flagStart = rest.findIndex((a) => a.startsWith('--'));
  const head = flagStart === -1 ? rest : rest.slice(0, flagStart);
  const flags = flagStart === -1 ? [] : rest.slice(flagStart);
  const name = head[0];
  const intent = head.slice(1).join(' ').trim();
  if (!name || !intent) {
    o.verdict('NEEDS ATTENTION', 'the workflow needs a candidate name and the intent, in that order.', 'usage: canary work <name> "<what to do>" [--kind bugfix|refactor|dependency|performance|ui|multi] [--requirement "<part>"]…');
    return 3;
  }

  // 1. the intent (a hint with zero authority — it can only ADD obligations), with
  // every flag AND its value passed through untouched.
  const taskArgs = [intent, ...forwarded(flags)];
  const taskCode = cmdTask(taskArgs);
  if (taskCode !== 0) { o.say('the intent could not be registered — nothing was opened.'); return taskCode; }

  /**
   * 1b. REFUSE TO HAND A WORKER A DUTY IT CANNOT CLOSE (v1.2, Mission 2).
   *
   * v1.1 discovered an unbound requirement only at the END of the session — at the Stop hook or at
   * `finish`. By then the model had already spent its budget trying to satisfy a duty that no check
   * measures and that it therefore could never discharge: MEASURED at 1.5-1.85M tokens over 41-53
   * turns for a five-requirement task, and reproduced by v1.2's own pilot (a correct candidate
   * refused as `UNPROVEN [per-requirement]: 7 registered requirement(s), 7 with NO sealed proof`,
   * at +133% tokens against the plain arm).
   *
   * The information needed to prevent that exists the moment the task is registered, so it is used
   * HERE — before isolation, before the worker is told anything. The candidate is not opened and
   * nothing is spent.
   *
   * A registration that carries its OWN subjective marker is not blocked: acceptance is then a
   * real path and the state is honest rather than stalled. Only a requirement that asks for a
   * mechanical outcome with no check to measure it is refused.
   */
  const cfg = readConfig(root);
  if (cfg !== null && cfg !== 'corrupt') {
    const report = unboundRequirements(root, cfg);
    if (report.unbound.length > 0 && !report.subjective) {
      // Every line is emitted BEFORE the verdict: in `--json` mode `verdict()` writes the single
      // stdout envelope, so anything said after it would be printed outside the envelope.
      o.say('REQUIREMENT UNBOUND — worker execution was NOT started and no candidate was opened.');
      o.say(`  ${report.unbound.length} registered requirement(s) have no sealed proof, so no check can measure them.`);
      o.say(`  sealed plan script(s) available to bind: ${report.planScripts.length > 0 ? report.planScripts.join(', ') : '(none — this plan has no script that could measure a requirement)'}`);
      for (const req of report.unbound) o.say(`  unbound: ${req.digest}`);
      o.say('  (a purely subjective requirement is closed differently: register it with a subjective marker and a human runs `canary accept` in a terminal)');
      o.verdict('NEEDS ATTENTION',
        'REQUIREMENT UNBOUND — a registered requirement has no sealed proof, so no check can measure it. Spending model effort on it could not have discharged it, so the worker was never started.',
        'bind each digest to a script the sealed plan runs, then re-seal: package.json "canary": { "proofs": { "<digest>": "<script>" } } → canary setup');
      return 2;
    }
  }

  // 2. the candidate, from the trusted base, with that intent frozen into it
  const isolateCode = await cmdIsolate([name]);
  if (isolateCode !== 0) { o.say('the candidate could not be opened — the base is untouched.'); return isolateCode; }

  o.verdict('CONNECTED',
    `"${name}" is open for work, and the intent is frozen into it.`,
    `work ONLY in the candidate directory printed above, commit there, then: canary finish ${name}`);
  return 0;
}

/** `canary finish <name>`
 *
 * The objective path completes here: verify from outside the candidate, and — if
 * every objective duty holds — promote. A NOT PROVEN or BLOCKED result returns
 * exactly what the primitive said, with the base untouched. */
export async function cmdFinish(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'finish' });
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no candidate registry here.', 'cd into your project, then: canary finish <name>'); return 2; }
  o.context({ root });
  const name = rest.find((a) => !a.startsWith('--'));
  if (!name) { o.verdict('NEEDS ATTENTION', 'name the candidate to finish.', 'usage: canary finish <name>'); return 3; }

  // 1. verify the committed candidate against the base's sealed authority
  const verified = await cmdIsolate(['--verify', name]);
  if (verified !== 0) {
    o.verdict('NEEDS ATTENTION',
      'the candidate is NOT eligible: the sealed checks did not pass, or an objective duty is unmet or unproven. The base is untouched. Nothing was promoted.',
      `read the report above, fix exactly what it names, commit in the candidate, then: canary finish ${name}`);
    return verified;
  }

  // 2. promotion re-verifies LIVE and fast-forwards only the exact verified commit
  const promoted = await cmdIsolate(['--promote', name]);
  if (promoted !== 0) {
    o.verdict('NEEDS ATTENTION', 'verification passed, but promotion was refused. The base is untouched.', 'read the refusal above, then: canary finish ' + name);
    return promoted;
  }
  o.verdict('CONNECTED',
    `"${name}" is verified and promoted — the base now carries the exact bytes that passed.`,
    `clean up when you are done: canary isolate --remove ${name}`);
  return 0;
}
