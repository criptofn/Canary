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

export async function cmdProvider(rawArgs: string[]): Promise<number> {
  const json = hasFlag(rawArgs, '--json');
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
      const measured = measuredCapabilities(status.boundary);
      if (json) {
        emitEnvelope({
          schema: 'canary-provider-status/1',
          command: 'provider status',
          // The status word is the MEASURED level, so the human and machine
          // answers cannot diverge, and HARDENED can only appear when it is real.
          status: measured.level === 'HARDENED' ? 'READY' : 'NOT CONNECTED',
          exitCode: measured.level === 'HARDENED' ? 0 : 2,
          problems: status.unavailable,
          security: { level: measured.level, reasons: Object.values(status.boundary.controls).map(c => c.why) },
          next: measured.level === 'HARDENED'
            ? 'the boundary is established; canary provider serve is what the OS starts'
            : 'run: canary provider install-plan (privileged steps, owner authorization required)',
        });
      }
      out(`provider: ${PROVIDER_SERVICE_NAME}  pipe: ${status.pipe}`);
      out(`platform: ${status.boundary.platform}  user: ${status.boundary.currentUser ?? 'unknown'}  elevated: ${status.boundary.elevated}`);
      out(`store:    ${status.boundary.storeDir} (${status.boundary.storeExists ? 'present' : 'absent'})`);
      const d = status.boundary.confined;
      if (status.boundary.production) {
        const p = status.boundary.production;
        out(`production: ${p.valid ? 'MEASURED + LIVE BROKER VERIFIED' : 'NOT MEASURED'} — ${p.reason}`);
        if (p.payload) out(`deployment=${p.payload.deployment} generation=${p.payload.nonce}`);
      } else if (d.measured) {
        out(`confined: MEASURED  package=${d.callerPackage ?? 'n/a'} at=${d.measuredAt ?? 'n/a'} age=${d.ageMs === null ? 'n/a' : `${(d.ageMs / 60_000).toFixed(1)} min`} signature=${d.signatureVerified ? 'verified' : 'NOT VERIFIED'}`);
        out(`          tools digest ${d.toolsDigest ?? 'n/a'}  record ${d.recordPath}`);
      } else {
        out(`confined: NOT MEASURED — ${d.reason}`);
      }
      out(`identity: service installed=${status.boundary.brokerServiceInstalled} running=${status.boundary.brokerServiceRunning} account=${status.boundary.brokerServiceAccount ?? 'n/a'}  worker=${status.boundary.workerUser ?? 'not enrolled'}`);
      out(`sandbox:  ${status.boundary.sandbox.kind ?? 'none'}  ${status.boundary.sandbox.detail}`);
      out('boundary controls (the measured confined-caller deployment):');
      for (const [name, c] of Object.entries(status.boundary.controls)) {
        out(`  ${c.available ? 'AVAILABLE  ' : 'UNAVAILABLE'} ${name}${c.available ? '' : ` — ${c.why}`}`);
      }
      out(`\n${measured.level === 'HARDENED'
        ? 'HARDENED — every boundary control is measured available on this host.'
        : `${measured.level} — HARDENED is NOT available: ${status.unavailable.length} control(s) missing.`}`);
      if (measured.level !== 'HARDENED') {
        out('next: node tooling/probes/v12-confined-caller.mjs   (measures the confined-caller deployment; nothing is elevated)');
        out('      canary provider install-plan                  (prints the privileged identity-path steps; nothing is executed)');
      }
      return measured.level === 'HARDENED' ? 0 : 2;
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
