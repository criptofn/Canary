/**
 * `canary provider` — the explicit provider lifecycle (v1.1 Phase 3).
 *
 *   canary provider status          measure the boundary; say whether HARDENED is real
 *   canary provider install-plan    the EXACT privileged commands, and the rollback
 *   canary provider uninstall-plan   what removal does, and what it must never delete
 *   canary provider serve           run the broker service (what the OS starts)
 *   canary provider call            worker-side request, for scripts and tests
 *
 * The verbs are split so that the privileged step is never a side effect of a
 * routine command: nothing here elevates, and `install-plan` prints rather than
 * executes. Routine Canary use after activation needs no elevation, because the
 * service holds the privileged identity.
 */
import { measuredCapabilities } from '../platform-boundary.js';
import { storeFromEnv } from '../trust-store.js';
import { emitEnvelope } from '../protocol.js';
import {
  PROVIDER_PIPE_NAME, PROVIDER_SERVICE_NAME, callProvider, providerInstallPlan,
  providerServe, providerStatus, providerUninstallPlan,
} from './service.js';
import type { WorkerOperation } from './ipc.js';
import { enrollProduction, serveProduction, productionAuthority, launchProductionCaller } from './production.js';
import { beginProductionMeasurement } from './production-measurement.js';
import { measureProductionAttacks } from './production-attacks.js';
import { workerTools } from './worker-tools.js';
import { modelTransport } from './model-transport.js';
import fs from 'node:fs';

function hasFlag(args: readonly string[], f: string): boolean { return args.includes(f); }

/**
 * v1.5 — collapse the repeated clauses a per-control reason can accumulate.
 *
 * MEASURED (v1.5, this host): with no deployment measured, each of the six control
 * lines repeated the SAME sentence twice and then appended a third clause — e.g.
 * `authorityCustody` printed "the confined-caller deployment is not measured: no
 * confined-caller deployment has been measured in this store (expected <path>);
 * the record reports: no confined-caller deployment has been measured in this
 * store (expected <path>); the identity path also leaves it unavailable: …".
 * That is ~430 characters per control, six times, saying one thing.
 *
 * The rule is deliberately conservative: split on `; `, then drop a clause only
 * when the text AFTER ITS FIRST COLON already appears in what has been kept. A
 * clause carrying any new payload is never dropped, so this can only remove
 * duplication — it can never hide a distinct reason. Order is preserved, and the
 * first clause (which carries the label) always survives.
 */
export function dedupeReason(why: string): string {
  const clauses = why.split('; ');
  const kept: string[] = [];
  for (const clause of clauses) {
    const colon = clause.indexOf(': ');
    const payload = colon < 0 ? clause : clause.slice(colon + 2);
    if (payload.trim().length > 0 && kept.some((k) => k.includes(payload))) continue;
    kept.push(clause);
  }
  return kept.join('; ');
}

export async function cmdProvider(rawArgs: string[]): Promise<number> {
  const json = hasFlag(rawArgs, '--json');
  const verbose = hasFlag(rawArgs, '--verbose');
  const rest = rawArgs.filter((a) => !a.startsWith('--'));
  const [sub = 'status'] = rest;
  const out = (s: string): void => { if (json) console.error(s); else console.log(s); };

  switch (sub) {
    case 'model-transport': {
      if (rest.length !== 6) throw new Error('usage: canary provider model-transport <store> <work> <prompt-file> <model> <absolute-claude-executable>');
      return modelTransport(rest[1]!, rest[2]!, fs.readFileSync(rest[3]!, 'utf8'), rest[4]!, rest[5]!);
    }
    case 'worker-tools': {
      if (rest.length !== 3) throw new Error('usage: canary provider worker-tools <store> <work>');
      return workerTools(rest[1]!, rest[2]!);
    }
    case 'measurement-begin': {
      if (rest.length !== 2) throw new Error('usage: canary provider measurement-begin <store>');
      console.log(JSON.stringify({ challenge: beginProductionMeasurement(rest[1]!) })); return 0;
    }
    case 'measure-production': {
      if (rest.length !== 2) throw new Error('usage: canary provider measure-production <store>');
      await measureProductionAttacks(rest[1]!);
      console.log('production measurement recorded'); return 0;
    }
    case 'enroll': {
      if (rest.length !== 3) throw new Error('usage: canary provider enroll <trusted-base> <new-deployment-store>');
      console.log(JSON.stringify(await enrollProduction(rest[1]!, rest[2]!)));
      return 0;
    }
    case 'serve-production': {
      if (rest.length !== 2) throw new Error('usage: canary provider serve-production <deployment-store>');
      return serveProduction(rest[1]!);
    }
    case 'launch': {
      // Operator-only launch; the OS token, not this verb's spelling, is custody.
      const [, store, cwd, ...argv] = rawArgs;
      if (!store || !cwd || !argv.length) throw new Error('usage: canary provider launch <store> <work> <program> [args...]');
      return launchProductionCaller(store, cwd, argv);
    }
    case 'authority': {
      if (rest.length !== 2) return 2;
      let input = '';
      for await (const chunk of process.stdin) {
        input += String(chunk);
        if (input.length > 4 * 1024 * 1024) return 2;
      }
      const log = console.log;
      console.log = (...args: unknown[]) => console.error(...args);
      try {
        const envelope = JSON.parse(input);
        if (typeof envelope.requestJson !== 'string') throw new Error('invalid broker framing');
        const result = await productionAuthority(rest[1]!, { client: envelope.client, request: JSON.parse(envelope.requestJson) });
        log(JSON.stringify(result)); return 0;
      } catch (e) {
        log(JSON.stringify({ status: 403, detail: String((e as Error).message) })); return 0;
      } finally { console.log = log; }
    }
    case 'status': {
      const status = providerStatus();
      const boundary = status.boundary;
      const measured = measuredCapabilities(boundary);
      const hardened = measured.level === 'HARDENED';
      const controls = Object.entries(boundary.controls) as Array<[string, { available: boolean; why: string }]>;
      const missing = controls.filter(([, c]) => !c.available).map(([name]) => name);
      const available = controls.length - missing.length;
      const production = boundary.production;
      const deployment: 'production' | 'confined-caller' | null = production?.valid === true
        ? 'production' : (boundary.confined.measured ? 'confined-caller' : null);
      const primitives = boundary.sandbox.kind ?? null;
      const next = hardened
        ? 'the boundary is established; canary provider serve is what the OS starts'
        : 'run: node tooling/probes/v12-confined-caller.mjs (measures the real boundary on this host; nothing is elevated)';

      if (json) {
        emitEnvelope({
          schema: 'canary-provider-status/1',
          command: 'provider status',
          // The status word is the MEASURED level, so the human and machine
          // answers cannot diverge, and HARDENED can only appear when it is real.
          status: hardened ? 'READY' : 'NOT CONNECTED',
          exitCode: hardened ? 0 : 2,
          problems: status.unavailable,
          security: { level: measured.level, reasons: Object.values(boundary.controls).map(c => c.why) },
          provider: {
            hardenedAvailable: hardened,
            controlsAvailable: available,
            controlsTotal: controls.length,
            controlsMissing: missing,
            hostPrimitives: primitives,
            deploymentMeasured: deployment,
          },
          next,
        });
      }

      // v1.5 — the COMPACT answer first. MEASURED on this host before the change:
      // six control lines of ~430 characters each, repeating one sentence twice
      // and burying the two questions a user actually has ("is HARDENED real
      // here?" and "was this host measured at all?"). The default output now
      // answers the six required questions in a dozen lines; the raw per-control
      // reasoning and observations moved behind `--verbose`, where they belong,
      // and nothing was removed from them.
      out(`canary provider — ${measured.level}${hardened ? '' : ' (HARDENED is NOT available here)'}`);
      out('');
      out(`  security level    ${measured.level}`);
      out(`  provider          ${PROVIDER_SERVICE_NAME}   pipe ${status.pipe}`);
      out(`  boundary controls ${available} of ${controls.length} available${hardened ? '' : ` — missing: ${missing.join(', ')}`}`);
      out(`  host primitives   ${primitives ?? 'none observed'}${primitives ? '   (present is NOT proof: only a measurement activates HARDENED)' : ''}`);
      if (deployment === null) {
        out(`  measured here     NO — nothing is measured in this store (${boundary.storeDir})`);
        // The exact refused reason quotes an absolute record path, which is real
        // detail and belongs behind `--verbose` — the default says only whether a
        // record EXISTS and did not validate, which is the user-facing fact.
        const refused = production !== undefined || boundary.confined.recordPresent;
        out(`  boundary          NOT MEASURED — ${refused
          ? 'a record is present but did not validate (see --verbose)'
          : 'no measurement record present'}`);
      } else if (deployment === 'production') {
        out('  measured here     YES — this store holds a valid production deployment measurement');
        out(`  boundary          MEASURED + LIVE BROKER VERIFIED — ${production?.reason ?? ''}`);
        if (production?.payload) out(`  deployment        ${production.payload.deployment} generation ${production.payload.nonce}`);
      } else {
        out('  measured here     YES — this store holds a valid confined-caller deployment measurement');
        out(`  boundary          MEASURED — ${boundary.confined.callerPackage ?? 'n/a'} at ${boundary.confined.measuredAt ?? 'n/a'}`);
      }
      out('');
      out(`  what this means   ${hardened
        ? 'every control was measured available: the worker cannot rewrite the records,'
        : 'candidate code is NOT confined here. Proof records are sealed outside the repo (LOCAL),'}`);
      out(`                    ${hardened
        ? 'key or history that judge it.'
        : 'but a process running as you could replace the store, the key and the ledger together.'}`);
      out('');
      out('  to enable HARDENED (nothing below elevates anything by itself)');
      out('    node tooling/probes/v12-confined-caller.mjs    measure the real boundary on this host');
      out('    canary provider install-plan                   print the privileged identity-path steps');
      out('');
      out('  verbose: canary provider status --verbose        per-control reasons and raw observations');

      if (verbose) {
        out('');
        out('--- detail ---------------------------------------------------------------');
        out(`platform: ${boundary.platform}  user: ${boundary.currentUser ?? 'unknown'}  elevated: ${boundary.elevated}`);
        out(`store:    ${boundary.storeDir} (${boundary.storeExists ? 'present' : 'absent'})`);
        const d = boundary.confined;
        if (production) {
          out(`production: ${production.valid ? 'MEASURED + LIVE BROKER VERIFIED' : 'NOT MEASURED'} — ${production.reason}`);
        } else if (d.measured) {
          out(`confined: MEASURED  package=${d.callerPackage ?? 'n/a'} at=${d.measuredAt ?? 'n/a'} age=${d.ageMs === null ? 'n/a' : `${(d.ageMs / 60_000).toFixed(1)} min`} signature=${d.signatureVerified ? 'verified' : 'NOT VERIFIED'}`);
          out(`          tools digest ${d.toolsDigest ?? 'n/a'}  record ${d.recordPath}`);
        } else {
          out(`confined: NOT MEASURED — ${dedupeReason(d.reason)}`);
        }
        out(`identity: service installed=${boundary.brokerServiceInstalled} running=${boundary.brokerServiceRunning} account=${boundary.brokerServiceAccount ?? 'n/a'}  worker=${boundary.workerUser ?? 'not enrolled'}`);
        out(`sandbox:  ${boundary.sandbox.kind ?? 'none'}  ${boundary.sandbox.detail}`);
        out('boundary controls (each derived from the measured deployment, never from configuration):');
        for (const [name, c] of controls) {
          out(`  ${c.available ? 'AVAILABLE  ' : 'UNAVAILABLE'} ${name}${c.available ? '' : ` — ${dedupeReason(c.why)}`}`);
        }
        out('identity-path controls (what an ELEVATED install would add; NOT evidence on this host):');
        for (const [name, c] of Object.entries(boundary.identityControls) as Array<[string, { available: boolean; why: string }]>) {
          out(`  ${c.available ? 'AVAILABLE  ' : 'UNAVAILABLE'} ${name}${c.available ? '' : ` — ${dedupeReason(c.why)}`}`);
        }
        out(`\n${hardened
          ? 'HARDENED — every boundary control is measured available on this host.'
          : `${measured.level} — HARDENED is NOT available: ${status.unavailable.length} control(s) missing.`}`);
      }
      return hardened ? 0 : 2;
    }
    case 'install-plan': {
      const plan = providerInstallPlan();
      if (json) { console.log(JSON.stringify(plan, null, 2)); return 0; }
      console.log(`OWNER AUTHORIZATION REQUIRED — WINDOWS HARDENED ACTIVATION`);
      console.log(`platform: ${plan.platform}\n`);
      console.log('1. exactly what the privileged commands will change:');
      for (const s of plan.steps) console.log(`   - ${s.id}: ${s.why}`);
      console.log('\n2. exact commands (run as Administrator; <STRONG-PASSWORD> is yours to choose):');
      for (const s of plan.steps) console.log(`   ${s.needsElevation ? '[elevated] ' : ''}${s.argv.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
      console.log('\n3. rollback / uninstall commands:');
      for (const r of plan.rollback) console.log(`   ${r.argv.join(' ')}`);
      console.log('\n4. expected post-install state:');
      for (const p of plan.postState) console.log(`   - ${p}`);
      console.log('\n5. verification command that must run afterwards:');
      for (const v of plan.verify) console.log(`   ${v}`);
      console.log('\nNothing in this command executed any of the above.');
      return 0;
    }
    case 'uninstall-plan': {
      const plan = providerUninstallPlan();
      if (json) { console.log(JSON.stringify(plan, null, 2)); return 0; }
      console.log('uninstall removes the service and the identities:');
      for (const step of plan.steps) console.log(`   ${step.join(' ')}`);
      console.log(`\n${plan.keepsProtectedAuthority}`);
      return 0;
    }
    case 'serve': {
      return await providerServe(storeFromEnv());
    }
    case 'call': {
      const op = rest[1] as WorkerOperation | undefined;
      if (op === undefined) { console.error('usage: canary provider call <operation> [--json]'); return 3; }
      try {
        const result = await callProvider({ op });
        console.log(json ? JSON.stringify(result) : `ok: ${JSON.stringify(result)}`);
        return 0;
      } catch (e) {
        console.error(`provider refused: ${String((e as Error).message)}`);
        return 2;
      }
    }
    default:
      console.log('usage: canary provider <status|install-plan|uninstall-plan|serve|call>');
      out(`unknown provider subcommand: ${sub}`);
      return 3;
  }
}
