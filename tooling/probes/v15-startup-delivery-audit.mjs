#!/usr/bin/env node
/** Check actual native model input for the installed startup context; never infer completion. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [root, out] = process.argv.slice(2);
assert.ok([root, out].every((value) => value && path.isAbsolute(value)) && !fs.existsSync(out));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
let verified = 0;
for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line); assert.ok(match);
  const target = path.join(root, match[2]), relative = path.relative(root, target);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(hash(fs.readFileSync(target)), match[1]); verified++;
}
const summary = read('summary.json');
assert.equal(hash(fs.readFileSync(summary.cli)), summary.cliSha256);
const texts = (value) => {
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.text === 'string' ? [value.text] : []), ...Object.values(value).flatMap(texts)];
};
const rows = summary.sessions.map((session) => {
  assert.ok(session.calls.length && session.captureComplete);
  const request = read(`api-${session.calls[0]}.request.json`);
  const context = texts(request).find((text) => text.includes('Canary completion workflow (not a verification result).'));
  const canary = session.name.endsWith('-canary');
  assert.equal(!!context, canary, `${session.name}: startup delivery differs from its integration`);
  if (canary) {
    assert.ok(context.includes(summary.cli));
    assert.ok(context.includes('finish normally'));
    assert.ok(context.includes('sealed test'));
  }
  const outcome = read(`${session.name}-outcome.json`);
  assert.ok(outcome.protectedUnchanged && outcome.baselinePreserved);
  return { name: session.name, startupContextInFirstModelRequest: !!context,
    modelTextBlockChars: context?.length ?? 0, correct: outcome.correctness === 'pass',
    normalCompletion: outcome.sessionComplete,
    actualStopPass: session.hookFired && session.checkpointChanged && session.checkpoint?.source === 'checkpoint' && session.checkpoint.status === 'pass' };
});
fs.writeFileSync(out, `${JSON.stringify({ scope: 'Startup delivery and preserved setup; completion outcomes are separate observations.',
  verifiedFiles: verified, evidence: root, cliSha256: summary.cliSha256,
  instrumentSha256: hash(fs.readFileSync(import.meta.filename)), rows }, null, 2)}\n`, { flag: 'wx' });
console.log(`PASS startup delivery: ${rows.length} fully captured sessions, ${verified} verified files; outcomes ${JSON.stringify(rows)}`);
