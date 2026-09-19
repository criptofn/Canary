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

process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-mcp-${process.pid}`);

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mcp-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** One MCP session: feed these JSON-RPC lines, get back the parsed responses. */
function session(lines: unknown[], cwd = TMP): { stdout: string[]; parsed: Array<Record<string, unknown>>; status: number | null; raw: string } {
  assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);
  const input = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  const r = spawnSync(process.execPath, [CLI, 'mcp'], { cwd, input, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
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
  const EXPECTED = ['canary_result', 'canary_status', 'canary_agents', 'canary_doctor', 'canary_work', 'canary_finish'];

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
    assert.equal(ann('canary_work').readOnlyHint, false);
    assert.equal(ann('canary_finish').readOnlyHint, false);
  });

  it('states the authority limit in the initialize instructions', () => {
    const r = resultOf(session([req(1, 'initialize', { protocolVersion: '2025-06-18' })]).parsed[0]!);
    const info = r.serverInfo as { name: string };
    assert.equal(info.name, 'canary');
    assert.equal(r.protocolVersion, '2025-06-18', 'a supported client revision is honoured');
    const instructions = String(r.instructions);
    assert.match(instructions, /cannot mint a PASS/i);
    assert.match(instructions, /terminal gate/i);
    assert.match(instructions, /SUBJECTIVE/i);
    // v1.3 §A — the measured instruction. The `guarded` arm (agent works normally, told verification is
    // automatic and that it will be told what to fix) is the only recorded Canary configuration cheaper
    // than working without Canary: 92.7 % of plain, equal correctness, no false done. The RELIABILITY
    // half is deliberate — the aggressive variant that FORBADE self-verification produced a false done
    // and a false green — so the model keeps the decision to check and only loses the repetition.
    assert.match(instructions, /verification in this repository is AUTOMATIC/i);
    assert.match(instructions, /do not repeat a check you have just run/i);
    assert.match(instructions, /may, and should, call canary_doctor/i);
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
  });
});

describe('a real call relays Canary own words and exit code, unmodified', () => {
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
