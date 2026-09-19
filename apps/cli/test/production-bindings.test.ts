import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { unchangedBindingSources } from '../src/provider/production.js';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-binding-source-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const digest = 'a'.repeat(64);
const pkg = { scripts: { test: 'node test.cjs' }, canary: { proofs: { [digest]: 'test' } } };
fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify(pkg));
const encoded = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');
test('implementation and unchanged bindings remain eligible for review', () => {
  unchangedBindingSources(base, { 'index.cjs': encoded('implementation'), 'package.json': encoded({ ...pkg, version: '2' }) });
});
for (const [name, files] of Object.entries({
  create: { 'package.json': encoded({ ...pkg, canary: { proofs: { ...pkg.canary.proofs, ['b'.repeat(64)]: 'test' } } }) },
  modify: { 'package.json': encoded({ canary: { proofs: { [digest]: 'other' } } }) },
  remove: { 'package.json': null },
  replace: { 'package.json': encoded({ scripts: pkg.scripts }) },
  alias: { 'PACKAGE.JSON': encoded({ canary: { proofs: {} } }) },
  alternative: { 'canary.project.json': encoded({ proofs: { [digest]: 'test' } }) },
  malformed: { 'package.json': Buffer.from('{broken').toString('base64') },
})) test(`builder binding ${name} is refused`, () => assert.throws(() => unchangedBindingSources(base, files)));
