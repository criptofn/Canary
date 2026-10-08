/**
 * v1.1 item D — the MCP surface must be a TRANSPORT, not a second authority.
 *
 * What this file pins, in the order it matters:
 *  1. stdout carries ONLY JSON-RPC. A stray `console.log` anywhere in the CLI
 *     path would corrupt the stream for every client, so the transport
 *     invariant is tested directly rather than assumed.
 *  2. Every tool is a fixed template over an operation the CLI already had.
 *     No tool accepts a field that could influence a verdict, and the tool set
 *     is asserted exactly, so adding one is a deliberate act.
 *  3. `canary accept` is NOT reachable. It is the human terminal act; asking
 *     for it by name is refused with the reason, not silently missing.
 *  4. Real calls relay Canary's own words and exit code unmodified, and
 *     `isError` tracks the child's exit code.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { materialDigest } from '../src/authorization.js';

process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mcp-'));

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mcp-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** One MCP session: feed these JSON-RPC lines, get back the parsed responses. */
function session(lines: unknown[], cwd = TMP, args: string[] = []): { stdout: string[]; parsed: Array<Record<string, unknown>>; status: number | null; raw: string } {
  assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);
  const input = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  const r = spawnSync(process.execPath, [CLI, 'mcp', ...args], { cwd, input, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const raw = r.stdout ?? '';
  const stdout = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const parsed = stdout.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stdout, parsed, status: r.status, raw };
}

const req = (id: number, method: string, params?: unknown): Record<string, unknown> =>
  (params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
const resultOf = (m: Record<string, unknown>): Record<string, unknown> => (m.result ?? {}) as Record<string, unknown>;
const textOf = (m: Record<string, unknown>): Record<string, unknown> => {
  const content = (resultOf(m).content ?? []) as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
};

describe('transport: stdout is the protocol channel and nothing else', () => {
  it('every stdout line is one JSON-RPC 2.0 object, and stdin closing exits 0', () => {
    const s = session([
      req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      req(2, 'tools/list'),
      req(3, 'ping'),
    ]);
    assert.equal(s.status, 0, `server must exit 0:\n${s.raw}`);
    assert.equal(s.stdout.length, 3, `exactly one response per request, no response to a notification:\n${s.stdout.join('\n')}`);
    for (const m of s.parsed) assert.equal(m.jsonrpc, '2.0', `not a JSON-RPC object: ${JSON.stringify(m)}`);
    assert.deepEqual(s.parsed.map((m) => m.id), [1, 2, 3], 'ids are echoed in order');
  });

  it('rejects malformed input without dying or writing prose', () => {
    const s = session(['{ not json', req(7, 'no/such/method')]);
    assert.equal(s.status, 0);
    assert.equal((s.parsed[0]!.error as { code: number }).code, -32700, 'parse error');
    assert.equal((s.parsed[1]!.error as { code: number }).code, -32601, 'method not found');
  });
});

describe('tools: a fixed template over operations the CLI already had', () => {
  const EXPECTED = ['canary_result', 'canary_status', 'canary_agents', 'canary_task', 'canary_doctor', 'canary_work', 'canary_finish'];

  it('exposes exactly the reviewed tool set', () => {
    const tools = resultOf(session([req(1, 'tools/list')]).parsed[0]!).tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools.map((t) => t.name), EXPECTED,
      'the tool surface is a deliberate list; adding one is a reviewable change to this assertion');
  });

  it('no tool accepts a field that could influence a verdict', () => {
    const tools = resultOf(session([req(1, 'tools/list')]).parsed[0]!).tools as Array<Record<string, unknown>>;
    const forbidden = ['status', 'verdict', 'result', 'accepted', 'promoted', 'pass', 'force', 'yes', 'skip', 'override', 'env'];
    for (const t of tools) {
      const props = Object.keys(((t.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {});
      for (const f of forbidden) {
        assert.ok(!props.includes(f), `${t.name} exposes "${f}" — a client must not be able to set a verdict`);
      }
      assert.equal((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, false,
        `${t.name} must refuse unknown arguments`);
      assert.ok(typeof t.description === 'string' && (t.description as string).length > 40, `${t.name} must explain itself`);
    }
  });

  it('declares which tools execute project code rather than reading', () => {
    const tools = resultOf(session([req(1, 'tools/list')]).parsed[0]!).tools as Array<Record<string, unknown>>;
    const byName = new Map(tools.map((t) => [t.name as string, t]));
    const ann = (n: string) => byName.get(n)!.annotations as { readOnlyHint: boolean };
    for (const readOnly of ['canary_result', 'canary_status', 'canary_agents']) {
      assert.equal(ann(readOnly).readOnlyHint, true, `${readOnly} writes nothing and must say so`);
    }
    assert.equal(ann('canary_doctor').readOnlyHint, false, 'doctor executes the sealed plan');
    assert.equal(ann('canary_task').readOnlyHint, false, 'task intake writes AGENT_REPORTED requirements');
    const taskSchema = byName.get('canary_task')!.inputSchema as {
      required: string[]; properties: { requirements: { minItems?: number; description?: string; items: { description?: string } } };
    };
    assert.deepEqual(taskSchema.required, ['intent', 'requirements']);
    assert.equal(taskSchema.properties.requirements.minItems, 1);
    assert.match(taskSchema.properties.requirements.description ?? '', /explicit user criteria.*one per item.*verbatim.*no summaries\/placeholders/i);
    assert.match(taskSchema.properties.requirements.items.description ?? '', /one verbatim user criterion/i);
    assert.match(String(byName.get('canary_task')!.description), /binding hints are operator-only/i);
    assert.equal(ann('canary_work').readOnlyHint, false);
    assert.equal(ann('canary_finish').readOnlyHint, false);
  });

  it('warns against repeating the full doctor gate when a completion hook is installed', () => {
    const tools = resultOf(session([req(1, 'tools/list')]).parsed[0]!).tools as Array<Record<string, unknown>>;
    const doctor = String(tools.find((t) => t.name === 'canary_doctor')!.description);
    assert.match(doctor, /when an automatic completion hook is installed/i);
    assert.match(doctor, /finish normally and let the hook verify once/i);
    assert.match(doctor, /early feedback or a focused repair/i);
    assert.match(doctor, /without a hook, use the full gate for final verification/i);
  });

  it('states the authority limit in the initialize instructions', () => {
    const r = resultOf(session([req(1, 'initialize', { protocolVersion: '2025-06-18' })], TMP, ['--profile', 'everyday']).parsed[0]!);
    const info = r.serverInfo as { name: string };
    assert.equal(info.name, 'canary');
    assert.equal(r.protocolVersion, '2025-06-18', 'a supported client revision is honoured');
    const instructions = String(r.instructions);
    assert.match(instructions, /mint a PASS/i);
    assert.match(instructions, /terminal gate/i);
    assert.match(instructions, /SUBJECTIVE/i);
    // v1.3 §A — the measured instruction. The `guarded` arm (agent works normally, told verification is
    // automatic and that it will be told what to fix) is the only recorded Canary configuration cheaper
    // than working without Canary: 92.7 % of plain, equal correctness, no false done. The RELIABILITY
    // half is deliberate — the aggressive variant that FORBADE self-verification produced a false done
    // and a false green — so the model keeps the decision to check and only loses the repetition.
    assert.match(instructions, /completion hook/i);
    assert.match(instructions, /file\/case filters/i);
    assert.match(instructions, /do not repeat a passed full gate/i);
    assert.match(instructions, /without a hook, use canary_doctor for the full gate/i);
    assert.match(instructions, /Use canary_result for a read-only summary/i);
    assert.match(instructions, /call canary_task before work and copy them verbatim/i);
    assert.match(instructions, /never use placeholders/i);
    assert.match(instructions, /AGENT_REPORTED input only/i);
    assert.match(instructions, /“bind it” is operator-only/i);
    assert.match(instructions, /If unbound, keep NOT PROVEN/i);
    assert.match(instructions, /do not alter checks, baseline or hooks, or run setup\/bind\/accept/i);
    assert.match(instructions, /Continue authorized work/i);
    assert.doesNotMatch(instructions, /canary_work|canary_finish/);
  });

  it('advertises the same nonblank doctor check constraint that the transport enforces', () => {
    const tools = resultOf(session([req(1, 'tools/list')]).parsed[0]!).tools as Array<Record<string, unknown>>;
    const schema = tools.find((t) => t.name === 'canary_doctor')!.inputSchema as {
      required?: string[]; properties: { check: { minLength?: number; pattern?: string; description: string } };
    };
    const check = schema.properties.check;
    assert.ok(!schema.required?.includes('check'), 'omitting check must remain the full gate');
    assert.match(check.description, /omit/i);
    for (const value of ['', ' ', '\t']) {
      const response = session([req(1, 'tools/call', {
        name: 'canary_doctor', arguments: { check: value },
      })]).parsed[0]!;
      assert.equal(resultOf(response).isError, true, 'blank must not silently run the full gate');
      assert.match(JSON.stringify(resultOf(response).content), /check must be a non-empty string/);
      assert.ok(value.length < (check.minLength ?? 0)
        || (check.pattern !== undefined && !new RegExp(check.pattern).test(value)),
      `tools/list must warn clients that ${JSON.stringify(value)} is refused`);
    }
    assert.ok(new RegExp(check.pattern!).test('test'));
  });

  it('everyday profile exposes common tools and keeps its base payload under 3.6 KB', () => {
    const messages = (profile: string[]) => session([
      req(1, 'initialize', { protocolVersion: '2025-06-18' }), req(2, 'tools/list'),
    ], TMP, profile).parsed;
    const everyday = messages(['--profile', 'everyday']);
    const expert = messages(['--profile', 'expert']);
    const everydayTools = resultOf(everyday[1]!).tools as Array<Record<string, unknown>>;
    const expertTools = resultOf(expert[1]!).tools as Array<Record<string, unknown>>;
    assert.deepEqual(everydayTools.map((t) => t.name), ['canary_result', 'canary_status', 'canary_task', 'canary_doctor']);
    assert.deepEqual(expertTools.map((t) => t.name), [...EXPECTED]);
    const bytes = (rows: Array<Record<string, unknown>>) => Buffer.byteLength(JSON.stringify({
      instructions: resultOf(rows[0]!).instructions, tools: resultOf(rows[1]!).tools,
    }));
    const everydayBytes = bytes(everyday);
    assert.ok(everydayBytes <= 3600,
      `everyday base initialize+tools payload should stay under 3,600 bytes (observed=${everydayBytes})`);
    assert.ok(everydayBytes <= bytes(expert) * 0.7,
      `everyday payload should be at least 30% smaller (everyday=${everydayBytes}, expert=${bytes(expert)})`);
    assert.match(String(resultOf(everyday[0]!).instructions), /Use canary_result/);
    assert.doesNotMatch(String(resultOf(everyday[0]!).instructions), /canary_work|canary_finish/);
    assert.match(String(resultOf(expert[0]!).instructions), /canary_work.*canary_finish/);
  });

  it('refuses expert-only tools in the everyday profile and rejects malformed profile options', () => {
    const refused = session([req(1, 'tools/call', { name: 'canary_work', arguments: { name: 'x', intent: 'isolate' } })], TMP, ['--profile', 'everyday']).parsed[0]!;
    assert.equal(resultOf(refused).isError, true);
    assert.match(String((resultOf(refused).content as Array<{ text: string }>)[0]!.text), /expert tool profile/);
    const invalid = spawnSync(process.execPath, [CLI, 'mcp', '--profile', 'unknown'], { input: '', encoding: 'utf8', timeout: 30_000 });
    assert.equal(invalid.status, 3);
    assert.match(invalid.stderr, /Nothing was run/);
  });

  it('honours an unknown protocol revision by answering with its own', () => {
    const r = resultOf(session([req(1, 'initialize', { protocolVersion: '1999-01-01' })]).parsed[0]!);
    assert.equal(typeof r.protocolVersion, 'string');
    assert.notEqual(r.protocolVersion, '1999-01-01');
  });

  it('does not expose acceptance, and says why when asked for it', () => {
    const tools = resultOf(session([req(1, 'tools/list')]).parsed[0]!).tools as Array<Record<string, unknown>>;
    assert.ok(!tools.some((t) => t.name === 'canary_accept'), 'acceptance must never be a tool');
    const m = session([req(1, 'tools/call', { name: 'canary_accept', arguments: { name: 'c' } })]).parsed[0]!;
    const out = resultOf(m);
    assert.equal(out.isError, true, 'a refused tool is an error result, not a silent success');
    assert.match(String((out.content as Array<{ text: string }>)[0]!.text), /human|terminal/i);
  });

  it('rejects an unknown tool and missing required arguments', () => {
    const unknown = session([req(1, 'tools/call', { name: 'canary_promote_everything', arguments: {} })]).parsed[0]!;
    assert.equal((unknown.error as { code: number }).code, -32602);
    const missing = session([req(1, 'tools/call', { name: 'canary_work', arguments: { intent: 'no name given' } })]).parsed[0]!;
    assert.match(String((resultOf(missing).content as Array<{ text: string }>)[0]!.text), /name must be a non-empty string/);
    const missingTask = session([req(1, 'tools/call', { name: 'canary_task', arguments: {} })]).parsed[0]!;
    assert.match(String((resultOf(missingTask).content as Array<{ text: string }>)[0]!.text), /intent must be a non-empty string/);
    const missingTaskRequirements = session([req(1, 'tools/call', { name: 'canary_task', arguments: { intent: 'a change' } })]).parsed[0]!;
    assert.match(String((resultOf(missingTaskRequirements).content as Array<{ text: string }>)[0]!.text), /requirements must include at least one explicit criterion/);
  });
});

describe('a real call relays Canary own words and exit code, unmodified', () => {
  it('initialize names the trusted sealed test entry without running it or accepting changed authority', () => {
    const root = path.join(TMP, 'upfront-test-entry');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    assert.equal(spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8' }).status, 0);
    const pkg = path.join(root, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: 'node check.cjs' } }));
    fs.writeFileSync(path.join(root, 'check.cjs'), "require('node:fs').appendFileSync('runs.txt', 'ran\\n');\n");
    const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
    const checkpoint = path.join(root, '.canary', 'last-checkpoint.json');
    const before = fs.readFileSync(checkpoint);
    const runs = fs.readFileSync(path.join(root, 'runs.txt'));
    const initialize = () => String(resultOf(session([req(1, 'initialize')], root, ['--profile', 'everyday']).parsed[0]!).instructions);
    assert.match(initialize(), /scripts\.test = "node check\.cjs"/,
      'the agent needs the real entry before writing a regression file that entry never runs');
    assert.match(initialize(), /observable behavior through the existing public API/);
    assert.match(initialize(), /do not export internals solely for tests/);
    assert.deepEqual(fs.readFileSync(checkpoint), before, 'initialization cannot certify completion');
    assert.deepEqual(fs.readFileSync(path.join(root, 'runs.txt')), runs, 'initialization cannot execute the test plan');

    fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: 'node different.cjs' } }));
    assert.doesNotMatch(initialize(), /scripts\.test = /, 'a changed script is not the sealed entry');
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: 'node check.cjs' } }));
    const configFile = path.join(root, '.canary', 'canary.local.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.planAuthority.at = '1970-01-01T00:00:00.000Z';
    fs.writeFileSync(configFile, JSON.stringify(config));
    assert.doesNotMatch(initialize(), /scripts\.test = /, 'a config outside the trusted record cannot advertise authority');
    config.cliPath = path.join(root, 'another-install', 'main.js');
    fs.writeFileSync(configFile, JSON.stringify(config));
    assert.doesNotMatch(initialize(), /scripts\.test = /, 'a copied config from another installation cannot advertise authority');
    assert.deepEqual(fs.readFileSync(checkpoint), before);
    assert.deepEqual(fs.readFileSync(path.join(root, 'runs.txt')), runs);
  });

  it('canary_task records exact requirements as untrusted input and cannot make an unbound task READY', () => {
    const root = path.join(TMP, 'task-intake-project');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    assert.equal(spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8' }).status, 0);
    const pass = path.join(REPO, 'tooling', 'test-support', 'fixtures', 'f-pass.js');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: `node "${pass}"` } }));
    assert.equal(spawnSync('git', ['-C', root, 'add', 'package.json'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Canary Regression', '-c', 'user.email=regression@canary.local', 'commit', '-m', 'sealed test baseline'], { encoding: 'utf8' }).status, 0);
    const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);

    const response = session([
      req(1, 'tools/call', { name: 'canary_task', arguments: {
        intent: 'Improve user name validation', requirements: ['reject whitespace in user names'],
      } }),
      req(2, 'tools/call', { name: 'canary_doctor', arguments: {} }),
    ], root, ['--profile', 'everyday']).parsed;
    const registered = textOf(response[0]!);
    assert.equal(registered.exitCode, 0, JSON.stringify(registered));
    assert.match(String(registered.stdout), /AGENT_REPORTED/);
    assert.match(String(registered.stdout), /needs proof or acceptance/);
    assert.match(String(registered.stdout), /operator action only/i);
    assert.match(String(registered.stdout), /agents must not run it/i);
    const task = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'task', 'current.json'), 'utf8')) as {
      taskDigest: string; trustClass: string; requirementCount: number; requirementDigests: string[];
    };
    assert.equal(task.trustClass, 'AGENT_REPORTED');
    assert.equal(task.taskDigest, materialDigest('Improve user name validation'));
    assert.equal(task.requirementCount, 1);
    assert.deepEqual(task.requirementDigests, [materialDigest('reject whitespace in user names')]);

    const doctor = textOf(response[1]!);
    assert.equal(doctor.verdict, 'NOT PROVEN');
    assert.notEqual(doctor.exitCode, 0);
  });
  it('canary_result returns the CLI envelope and tracks the child exit code', () => {
    const root = path.join(TMP, 'repo');
    fs.mkdirSync(root, { recursive: true });
    const g = spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    const s = session([req(1, 'tools/call', { name: 'canary_result', arguments: {} })], root);
    const out = textOf(s.parsed[0]!);
    assert.equal(typeof out.exitCode, 'number', 'the real exit code is reported');
    assert.match(String(out.authority), /cannot alter it/);
    const env = out.envelope as { schema?: string; status?: string } | undefined;
    assert.ok(env, 'the CLI envelope is passed through, not paraphrased');
    assert.equal(env.schema, 'canary-result/1');
    assert.equal(typeof env.status, 'string');
    assert.equal((resultOf(s.parsed[0]!).isError as boolean), out.exitCode !== 0,
      'isError must track the child exit code exactly');
  });

  it('canary_doctor relays a focused diagnostic as PARTIAL and leaves the completion checkpoint alone', () => {
    const root = path.join(TMP, 'focused-doctor-project');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    assert.equal(spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8' }).status, 0);
    const pass = path.join(REPO, 'tooling', 'test-support', 'fixtures', 'f-pass.js');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: `node "${pass}"` } }));
    assert.equal(spawnSync('git', ['-C', root, 'add', 'package.json'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Canary Regression', '-c', 'user.email=regression@canary.local', 'commit', '-m', 'sealed test baseline'], { encoding: 'utf8' }).status, 0);
    const setup = spawnSync(process.execPath, [CLI, 'setup', '--yes', root], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
    const checkpoint = path.join(root, '.canary', 'last-checkpoint.json');
    const before = fs.readFileSync(checkpoint);

    const response = session([req(1, 'tools/call', {
      name: 'canary_doctor', arguments: { path: root, check: 'test' },
    })], root).parsed[0]!;
    const out = textOf(response);
    assert.equal(resultOf(response).isError, false);
    assert.equal(out.verdict, 'PARTIAL');
    assert.equal(out.exitCode, 0);
    const envelope = out.envelope as { schema: string; status: string; partialCheck: { id: string; passed: boolean } };
    assert.equal(envelope.schema, 'canary-doctor-partial/1');
    assert.equal(envelope.status, 'PARTIAL');
    assert.deepEqual(envelope.partialCheck, { id: 'test', passed: true, ran: true, exitCode: 0 });
    assert.deepEqual(fs.readFileSync(checkpoint), before);

    for (const arguments_ of [{ path: root }, { path: root, fast: true }]) {
      const fullResponse = session([req(2, 'tools/call', {
        name: 'canary_doctor', arguments: arguments_,
      })], root).parsed[0]!;
      const full = textOf(fullResponse);
      assert.equal(resultOf(fullResponse).isError, false, JSON.stringify(full));
      assert.equal(full.exitCode, 0);
      assert.equal(full.verdict, 'READY', 'full doctor must relay the real JSON verdict');
      const fullEnvelope = full.envelope as { proof: { registeredRequirements: number; obligations: unknown[] } };
      assert.equal(fullEnvelope.proof.registeredRequirements, 0);
      assert.ok(Array.isArray(fullEnvelope.proof.obligations));
    }
  });

  it('a cancelled/unknown candidate in canary_finish relays the refusal, not a verdict of its own', () => {
    const root = path.join(TMP, 'repo2');
    fs.mkdirSync(root, { recursive: true });
    assert.equal(spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8' }).status, 0);
    const s = session([req(1, 'tools/call', { name: 'canary_finish', arguments: { name: 'never-created' } })], root);
    const result = resultOf(s.parsed[0]!);
    assert.equal(result.isError, true, 'a refusal is an error result');
    const out = textOf(s.parsed[0]!);
    assert.notEqual(out.exitCode, 0);
    assert.ok(!/PROMOTED/.test(JSON.stringify(out)), 'the transport must not report a promotion Canary did not make');
  });
});
