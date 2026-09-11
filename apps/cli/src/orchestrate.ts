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
import { cmdTask, findRepoRoot, Out, parseGlobals } from './onboarding.js';

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

  const positionals = rest.filter((a) => !a.startsWith('--'));
  const name = positionals[0];
  const intent = positionals.slice(1).join(' ').trim();
  if (!name || !intent) {
    o.verdict('NEEDS ATTENTION', 'the workflow needs a candidate name and the intent, in that order.', 'usage: canary work <name> "<what to do>" [--kind bugfix|refactor|dependency|performance|ui|multi] [--requirement "<part>"]…');
    return 3;
  }

  // 1. the intent (a hint with zero authority — it can only ADD obligations)
  const taskArgs = [intent, ...forwarded(rest.filter((a) => a.startsWith('--')))];
  const taskCode = cmdTask(taskArgs);
  if (taskCode !== 0) { o.say('the intent could not be registered — nothing was opened.'); return taskCode; }

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
