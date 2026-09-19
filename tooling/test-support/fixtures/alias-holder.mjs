// Trusted-side holder: calls the real production confined executor in its own process
// so the audit probe's event loop stays free to sample the session device namespace
// WHILE the sandbox alias is live.
import fs from 'node:fs';
import path from 'node:path';
import { productionTool } from '../../../apps/cli/dist/src/provider/production.js';

const [store, work, observerArgsJson, out] = process.argv.slice(2);
const argv = ['node', '--preserve-symlinks-main', path.join(work, 'alias-observer.cjs'), ...JSON.parse(observerArgsJson)];
try {
  const r = productionTool(store, work, { op: 'exec', argv });
  fs.writeFileSync(out, JSON.stringify({ ok: true, argv, observation: r.observation, result: r.output?.result ?? null, toolError: r.output?.error ?? null }, null, 1));
} catch (e) {
  fs.writeFileSync(out, JSON.stringify({ ok: false, argv, error: e.message }, null, 1));
}
process.exit(0);
