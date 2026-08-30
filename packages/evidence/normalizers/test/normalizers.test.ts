import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildPipeline,
  DEFAULT_RULE_NAMES,
  machineRules,
  normalize,
  pathVariants,
} from '../src/index.js';

const WS_ROOT = 'C:\\canary-ws';

function pipelineFor(wsRoot: string) {
  const machine = machineRules({
    tempDir: os.tmpdir(),
    homeDir: os.homedir(),
    user: os.userInfo().username,
    host: os.hostname(),
    workspaceRoot: wsRoot,
  });
  return buildPipeline(DEFAULT_RULE_NAMES, machine);
}

describe('normalizers', () => {
  const p = pipelineFor(WS_ROOT);
  const n = (t: string) => normalize(t, p);

  it('canonicalizes line endings, trailing ws, final newline', () => {
    assert.equal(n('a  \r\nb\t\r\n\r\n\r'), 'a\nb\n');
    assert.equal(n(''), '');
  });

  it('collapses timestamps, dates, durations', () => {
    assert.equal(n('start 2026-08-30T12:34:56.789Z ok'), 'start <TS> ok\n');
    assert.equal(n('on 2026-08-30 we'), 'on <DATE> we\n');
    assert.equal(n('Ran 12 tests in 3.456s'), 'Ran 12 tests in <DUR>\n');
    assert.equal(n('42 passing (152ms)'), '42 passing (<DUR>)\n');
  });

  it('collapses uuids and long hex addresses but not short hex', () => {
    assert.equal(n('id 3f2504e0-4f89-11d3-9a0c-0305e82b3391'), 'id <UUID>\n');
    assert.equal(n('at 0x7ff8a1b2c3d4'), 'at <ADDR>\n');
    assert.equal(n('color 0xfff'), 'color 0xfff\n');
  });

  it('collapses ports on localhost', () => {
    assert.equal(n('GET http://localhost:54321/x'), 'GET http://localhost:<PORT>/x\n');
  });

  it('normalizes the run workspace, temp, home, user, host', () => {
    assert.ok(n(`file ${path.join(WS_ROOT, 'fixture', 'a.js')} x`).includes('<WS>'));
    assert.ok(n(`tmp ${path.join(os.tmpdir(), 'xyz123')}`).includes('<TEMP>'));
    assert.ok(n(`h ${os.homedir()}`).includes('<HOME>'));
    assert.ok(n(`u=${os.userInfo().username}`).includes('<USER>'));
  });

  it('pathVariants covers slash forms and drive case', () => {
    const vs = pathVariants('C:\\Users\\someone\\AppData\\Local\\Temp');
    assert.ok(vs.some((v) => v.includes('/')));
    assert.ok(vs.some((v) => v[0] === 'C' || v[0] === 'c'));
  });

  it('the stability invariant: same logical run shape at different moments collapses to identical bytes', () => {
    const shape = (i: number): string =>
      [
        `  ✔ request pipeline (${0.123 + i}s)`,
        `  ✗ adapter contract broke at 2026-08-30T0${i}:11:22.5Z`,
        `    server on http://localhost:5${i}000 responded`,
        `    file ${WS_ROOT}\\fixture\\node_modules\\x${i}\\index.js`,
        `    tmp ${os.tmpdir()}\\canary-run-${i}${i}${i}`,
        `  28 passing (1${i}4ms)`,
        `  4 failing`,
      ].join('\r\n');
    const a = n(shape(1));
    const b = n(shape(7));
    assert.equal(a, b);
    // Outcomes survive; unstable values do not.
    assert.match(a, /^  ✔ request pipeline \(\x3cDUR>\)$/m);
    assert.match(a, /<PORT>/);
    assert.match(a, /<WS>/);
    assert.match(a, /<TEMP>/);
    assert.match(a, /  4 failing/);
  });

  it('result lines are never rewritten by value-shape rules', () => {
    const t = '28 passing\n4 failing';
    assert.equal(n(t), t + '\n');
  });
});
