#!/usr/bin/env node
/** Replay the actual preserved failed Stop output through the changed display function. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildFailurePayload, MAX_TOTAL_CHARS } from '../../apps/cli/dist/src/failure-payload.js';

const [root, out] = process.argv.slice(2);
assert.ok([root, out].every((value) => value && path.isAbsolute(value)) && !fs.existsSync(out));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const summary = JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8'));
const session = summary.sessions.find((record) => record.name === 'R1-canary'); assert.ok(session);
const response = session.hookEvents.map((event) => {
  try { return JSON.parse(event.stdout); } catch { return null; }
}).find((value) => value?.decision === 'block' && value.reason.includes('1-tests.log'));
assert.ok(response);
const originalPath = response.reason.split('full output: ')[1].split('\n')[0];
const file = path.join(root, session.name, 'product-evidence', path.basename(path.dirname(originalPath)), '1-tests.log');
const relative = path.relative(root, file).replaceAll('\\', '/');
const bytes = fs.readFileSync(file), expected = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').split('\n')
  .find((line) => line.slice(66) === relative)?.slice(0, 64);
assert.equal(hash(bytes), expected, 'replay input must match the original captured runner log');
assert.doesNotMatch(response.reason, /extractFailureIds|AssertionError|failure-ids\.test\.ts:\d+:/);
let saved = '';
const improved = buildFailurePayload({ steps: [{ id: 'test', kind: 'tests', display: 'npm run test', exitCode: 1,
  stdout: bytes.toString('utf8'), stderr: '' }], writeLog: (_name, raw) => { saved = raw; return originalPath; } });
assert.equal(saved, `${bytes.toString('utf8')}\n`);
assert.match(improved, /failure-ids\.test\.ts > extractFailureIds/);
assert.match(improved, /help-drift\.test\.ts \[ tests\/unit\/cli\/help-drift\.test\.ts \]/);
assert.match(improved, /Error: dist CLI not found/);
assert.match(improved, /❯ tests\/unit\/cli\/help-drift\.test\.ts:37:9/);
assert.ok(improved.includes(originalPath) && improved.includes('doctor --check test') && improved.length <= MAX_TOTAL_CHARS);
fs.writeFileSync(out, `${JSON.stringify({ scope: 'Actual-log display replay; no new model session or changed verdict.',
  inputSha256: hash(bytes), evidence: root, before: response.reason, after: improved,
  compiledModuleSha256: hash(fs.readFileSync(new URL('../../apps/cli/dist/src/failure-payload.js', import.meta.url))),
  instrumentSha256: hash(fs.readFileSync(import.meta.filename)) }, null, 2)}\n`, { flag: 'wx' });
console.log(`PASS actual native failure replay: ${response.reason.length} -> ${improved.length} chars; bounded test and suite identities, first failure and source position; original log retained`);
