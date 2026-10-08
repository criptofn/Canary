/**
 * 1.1 item D — a Model Context Protocol server, and the ONE rule that shapes it.
 *
 * THE RULE: this server has NO authority of its own. It is a transport. Every
 * tool it exposes runs the SAME trusted CLI as a child process, in the same
 * working directory, and reports back exactly what that CLI decided — its
 * verdict and its exit code, unmodified. There is no second decision path here,
 * no re-implementation of a gate, and no field a client can set to influence a
 * verdict. An MCP client may REQUEST work; it can never mint PASS, ACCEPTED or
 * PROMOTED, because those words are produced by `canary` and this file only
 * carries them.
 *
 * What is deliberately NOT exposed, and why: `canary accept`. Acceptance is the
 * human act that closes SUBJECTIVE duties, and it is gated on a real terminal
 * (`cmdAccept`). Exposing it through a machine channel would be a way to reach
 * the one step the whole design refuses to let an agent perform — so there is no
 * tool for it, and asking for one by name is refused explicitly rather than
 * silently absent, so a client learns WHY instead of guessing.
 *
 * Transport: JSON-RPC 2.0 over stdio, one JSON object per line (MCP's stdio
 * framing). stdout carries ONLY protocol messages — every diagnostic goes to
 * stderr — because a stray `console.log` on stdout corrupts the stream for the
 * client. Output from the child CLI is captured (piped), never inherited.
 */

import { spawnSync } from 'node:child_process';
import readline from 'node:readline';

import { CLI_ENTRY, selfArgv, projectTestEntryHint, type McpProfile } from './onboarding.js';
import { CANARY_VERSION } from './pipeline.js';

/** The MCP revision this server speaks. */
const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

/** Child runs can legitimately take minutes (a sealed plan executes). */
const CHILD_TIMEOUT_MS = 900_000;
/** How much of a child's stderr is echoed back. Bounded on purpose: a completion
 *  payload that pastes megabytes into a model's context is a token bug. */
const MAX_STDERR_CHARS = 4000;

/** Registry keys are filenames; mirror the CLI's own rule so an obviously bad
 *  name fails here. The CLI validates again — this is not the gate. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Standard MCP hints. `readOnlyHint: false` means the call may execute
   *  project code or write evidence — clients should be able to tell. */
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
}

/**
 * The tool set. Each entry is a thin, fixed argv template over an operation the
 * CLI already has — nothing here invents a command, and every one of them
 * existed and was reviewed before this server did.
 */
const TOOLS: readonly McpTool[] = [
  {
    name: 'canary_result',
    description:
      'Read-only summary of this repository: checks, protection level and next action (`canary result --json`).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repository root (defaults to server cwd).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Canary result (read-only)', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'canary_status',
    description: 'Read-only wiring status for this repository (`canary status --json`).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repository root (defaults to server cwd).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Canary status (read-only)', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'canary_agents',
    description: 'Lists available agent integrations and whether each can block completion or only advise.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repository root (defaults to server cwd).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Canary agent capabilities (read-only)', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'canary_task',
    description:
      'Record explicit acceptance criteria (`canary task`). AGENT_REPORTED input only: adds duties, never binds checks or proves them. Unbound duties stay NOT PROVEN.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', minLength: 1 },
        requirements: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      },
      required: ['intent', 'requirements'],
      additionalProperties: false,
    },
    annotations: { title: 'Canary task intake', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'canary_doctor',
    description:
      'Runs sealed checks and project code. Omit `check` for the full gate; an exact check id is PARTIAL only. '
      + 'When an automatic completion hook is installed, finish normally and let the hook verify once; use '
      + 'this for early feedback or a focused repair. Without a hook, use the full gate for final verification. '
      + 'Relay non-zero exits.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository root (defaults to server cwd).' },
        fast: { type: 'boolean', description: 'Opt-in adaptive fast path: leave out only the checks whose declared paths the change provably missed. Never available to promotion.' },
        check: { type: 'string', minLength: 1, pattern: '\\S', description: 'Exact nonblank sealed check id for a focused PARTIAL diagnostic; omit for the full gate.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Canary doctor (executes the sealed plan)', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'canary_work',
    description:
      'REQUEST a unit of work: register the intent and open an isolated candidate (runs `canary work`). '
      + 'Returns the candidate directory — do the work THERE, never in the base. The intent is a hint with '
      + 'zero authority: it can only ADD obligations, never remove one.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Candidate name (letters, digits, dot, dash, underscore).' },
        intent: { type: 'string', description: 'What the change is meant to do, in one line.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['bugfix', 'refactor', 'dependency', 'performance', 'ui', 'multi'] },
          description: 'Optional declared task kinds (e.g. bugfix, ui, dependency).',
        },
        requirements: { type: 'array', items: { type: 'string' }, description: 'Optional per-part requirements that must each be proven or accepted.' },
        path: { type: 'string', description: 'Repository directory to attach the work to.' },
      },
      required: ['name', 'intent'],
      additionalProperties: false,
    },
    annotations: { title: 'Canary work (opens a candidate)', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'canary_finish',
    description:
      'REQUEST completion: verify the committed candidate against the base\'s sealed authority and, ONLY '
      + 'if that live verification passes, fast-forward the trusted base (runs `canary finish`). Promotion '
      + 'is decided by Canary from live bytes; a stored or claimed PASS is never read back. A refusal means '
      + 'the base was untouched — fix exactly what was reported and call this again.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Candidate name to finish.' },
        path: { type: 'string', description: 'Repository directory.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { title: 'Canary finish (verify, then promote only if proven)', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
];

const SERVER_INSTRUCTIONS = [
  'The trusted CLI alone issues verdicts; relay its output and exit code. Agent-run tests are not Canary proof.',
  '',
  'No MCP call can mint a PASS or promotion, or bypass the terminal gate on `canary accept`; only a human may accept or close a SUBJECTIVE duty.',
  '',
  'With an automatic completion hook, finish normally and let it run the plan once. For early feedback, use the runner\'s file or case filter; do not repeat a passed full gate.',
  'Use canary_doctor for early feedback or a focused PARTIAL check; without a hook, use the full gate.',
  'Use canary_result for a read-only summary.',
  'For explicit criteria, call canary_task before editing and copy each verbatim. It records AGENT_REPORTED input only; if unbound, surface it before substantial work: NOT PROVEN.',
  'Preserve operator-approved checks, baseline and hooks. Do not run setup or bind to clear a verdict.',
  'Regression proof must test the implementation through the sealed test entry; copied code is not proof.',
  'A worker caveat records provenance, not failure. When READY, finish normally and report it.',
].join('\n');

const EXPERT_INSTRUCTIONS = '\n\nFor work that must be isolated, `canary_work` opens a candidate and `canary_finish` verifies it and promotes only if the proof holds.';

function toolsFor(profile: McpProfile): readonly McpTool[] {
  return profile === 'expert' ? TOOLS : TOOLS.filter((t) => t.name !== 'canary_agents' && t.name !== 'canary_work' && t.name !== 'canary_finish');
}

function parseMcpProfile(args: readonly string[]): McpProfile | null {
  if (args.length === 0) return 'expert'; // preserve the original hand-configured CLI surface
  let profile: McpProfile | null = null;
  let seen = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = arg === '--profile' ? args[++i] : arg.startsWith('--profile=') ? arg.slice('--profile='.length) : undefined;
    if (value === undefined) return null;
    if (seen) return null;
    seen = true;
    if (value !== 'everyday' && value !== 'expert') return null;
    if (profile !== null && profile !== value) return null;
    profile = value;
  }
  return profile;
}

/** Tools a client may ask for by name even though they do not exist. Saying WHY
 *  is better than a bare "unknown tool": the absence of `accept` is a design
 *  decision, not an oversight. */
const REFUSED_TOOLS: Record<string, string> = {
  canary_accept: 'canary_accept is deliberately NOT exposed. Acceptance closes SUBJECTIVE duties and is a '
    + 'human act gated on a real terminal; exposing it to a machine channel would defeat the one step the '
    + 'design refuses to let an agent perform. A human must run `canary accept <candidate>` themselves.',
  accept: 'see canary_accept: acceptance is a human terminal act and is not exposed over MCP.',
};

interface RpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

interface ChildOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be launched or timed out. */
  failure: string | null;
}

/** Run the trusted CLI. argv is built from a FIXED template plus validated
 *  values — nothing a client sends is ever passed through as a flag. Under a
 *  single-executable build `selfArgv` drops the `main.js` path, because the
 *  executable is the CLI and there is no script to name. */
function runCli(argv: readonly string[], cwd: string): ChildOutcome {
  const r = spawnSync(process.execPath, selfArgv(argv), {
    cwd, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return {
    exitCode: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    failure: timedOut ? `timed out after ${CHILD_TIMEOUT_MS} ms`
      : (r.error !== undefined ? `could not run canary: ${r.error.message}` : null),
  };
}

function tail(s: string, max = MAX_STDERR_CHARS): string {
  if (s.length <= max) return s;
  return `…(${s.length - max} earlier characters omitted)…\n` + s.slice(s.length - max);
}

/** The MCP tool result for one plain CLI invocation. The envelope (when the
 *  child was asked for JSON) is passed through VERBATIM — no field is added,
 *  renamed, or recomputed. */
function cliToolResult(o: ChildOutcome): { content: Array<{ type: 'text'; text: string }>; isError: boolean; structuredContent?: Record<string, unknown> } {
  const text = o.stdout.trim();
  let envelope: unknown = null;
  if (text !== '') { try { envelope = JSON.parse(text); } catch { envelope = null; } }
  const status = (envelope !== null && typeof envelope === 'object' && typeof (envelope as { status?: unknown }).status === 'string')
    ? (envelope as { status: string }).status
    : null;
  const payload = {
    // Facts only. `status` is Canary's own word, echoed; `exitCode` is the real
    // process exit code. Nothing here is derived from anything the client sent.
    ...(status !== null ? { verdict: status } : {}),
    exitCode: o.exitCode,
    ...(o.signal !== null ? { signal: o.signal } : {}),
    ...(o.failure !== null ? { failure: o.failure } : {}),
    ...(envelope !== null ? { envelope } : (text !== '' ? { stdout: tail(text) } : {})),
    ...(o.stderr.trim() !== '' ? { stderr: tail(o.stderr.trim()) } : {}),
    authority: 'produced by the trusted canary CLI; this server relays it and cannot alter it',
  };
  const isError = o.exitCode !== 0 || o.failure !== null;
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError, structuredContent: payload };
}

function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(v: unknown, what: string): string | { error: string } {
  if (typeof v !== 'string' || v.trim() === '') return { error: `${what} must be a non-empty string` };
  return v;
}
function asStringArray(v: unknown, what: string): string[] | { error: string } {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) return { error: `${what} must be an array of non-empty strings` };
  return v as string[];
}
function cwdFor(args: Record<string, unknown>): string {
  const p = args.path;
  return typeof p === 'string' && p.trim() !== '' ? p : process.cwd();
}

/** Validate + dispatch one tools/call. Returns null for an unknown tool. */
function callTool(name: string, args: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; isError: boolean; structuredContent?: Record<string, unknown> } {
  switch (name) {
    case 'canary_result':
      return cliToolResult(runCli(['result', '--json'], cwdFor(args)));
    case 'canary_status':
      return cliToolResult(runCli(['status', '--json'], cwdFor(args)));
    case 'canary_agents':
      return cliToolResult(runCli(['agents', '--json'], cwdFor(args)));
    case 'canary_task': {
      const intent = asString(args.intent, 'intent');
      if (typeof intent !== 'string') return errorResult(intent.error);
      const requirements = asStringArray(args.requirements, 'requirements');
      if (!Array.isArray(requirements)) return errorResult(requirements.error);
      if (requirements.length === 0) return errorResult('requirements must include at least one explicit criterion');
      const argv = ['task', intent];
      for (const requirement of requirements) argv.push('--requirement', requirement);
      return cliToolResult(runCli(argv, process.cwd()));
    }
    case 'canary_doctor': {
      if (args.fast === true && args.check !== undefined) return errorResult('fast and check cannot be combined');
      const check = args.check === undefined ? undefined : asString(args.check, 'check');
      if (check !== undefined && typeof check !== 'string') return errorResult(check.error);
      const argv = args.fast === true ? ['doctor', '--fast', '--json']
        : typeof check === 'string' ? ['doctor', '--check', check, '--json']
          : ['doctor', '--json'];
      return cliToolResult(runCli(argv, cwdFor(args)));
    }
    case 'canary_work': {
      const n = asString(args.name, 'name');
      if (typeof n !== 'string') return errorResult(n.error);
      const intent = asString(args.intent, 'intent');
      if (typeof intent !== 'string') return errorResult(intent.error);
      if (!NAME_RE.test(n)) return errorResult(`name "${n}" is not a valid candidate name (letters, digits, dot, dash, underscore; max 64)`);
      const kinds = asStringArray(args.kinds, 'kinds');
      if (!Array.isArray(kinds)) return errorResult(kinds.error);
      const reqs = asStringArray(args.requirements, 'requirements');
      if (!Array.isArray(reqs)) return errorResult(reqs.error);
      const argv = ['work', n, intent];
      for (const k of kinds) argv.push('--kind', k);
      for (const r of reqs) argv.push('--requirement', r);
      return cliToolResult(runCli(argv, cwdFor(args)));
    }
    case 'canary_finish': {
      const n = asString(args.name, 'name');
      if (typeof n !== 'string') return errorResult(n.error);
      if (!NAME_RE.test(n)) return errorResult(`name "${n}" is not a valid candidate name`);
      return cliToolResult(runCli(['finish', n], cwdFor(args)));
    }
    default:
      return null as never;
  }
}

/** The ONLY way this file writes to stdout. MCP's stdio framing is
 *  newline-delimited JSON: a missing "\n" does not fail loudly, it silently
 *  concatenates two responses into one unparseable line. So the newline is part
 *  of the single send path, never a thing a call site remembers. */
function send(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + '\n');
}
function rpcResult(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}
function rpcError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/**
 * The server loop. Reads newline-delimited JSON-RPC from stdin, writes responses
 * to stdout — and nothing else ever touches stdout.
 */
export async function cmdMcp(rawArgs: string[]): Promise<number> {
  // stdout is the protocol channel. Anything that would write prose there is a
  // bug, so route our own diagnostics to stderr explicitly.
  const log = (s: string): void => { process.stderr.write(`canary mcp: ${s}\n`); };
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stderr.write('usage: canary mcp [--profile everyday|expert] — run the MCP server on stdio (JSON-RPC 2.0, one object per line)\n');
    return 0;
  }
  const profile = parseMcpProfile(rawArgs);
  if (profile === null) {
    process.stderr.write('REFUSED — use exactly one MCP profile: --profile everyday or --profile expert. Nothing was run.\n');
    return 3;
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let msg: RpcRequest;
    try { msg = JSON.parse(trimmed) as RpcRequest; } catch { rpcError(null, -32700, 'parse error: not a JSON object'); continue; }
    if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') {
      rpcError(msg?.id, -32600, 'invalid request: "method" must be a string'); continue;
    }
    const id = msg.id;
    const isNotification = id === undefined || id === null;
    const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>;

    switch (msg.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        const version = typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION;
        if (!isNotification) {
          rpcResult(id, {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'canary', version: CANARY_VERSION, title: 'Canary verification layer' },
            instructions: SERVER_INSTRUCTIONS + projectTestEntryHint(process.cwd()) + (profile === 'expert' ? EXPERT_INSTRUCTIONS : ''),
          });
        }
        break;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break; // notifications: no response, ever
      case 'ping':
        if (!isNotification) rpcResult(id, {});
        break;
      case 'tools/list':
        if (!isNotification) {
          rpcResult(id, {
            tools: toolsFor(profile).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
          });
        }
        break;
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string') { if (!isNotification) rpcError(id, -32602, 'invalid params: "name" is required'); break; }
        const refusal = REFUSED_TOOLS[name];
        if (refusal !== undefined) { if (!isNotification) rpcResult(id, errorResult(refusal)); break; }
        if ((name === 'canary_agents' || name === 'canary_work' || name === 'canary_finish') && profile === 'everyday') {
          if (!isNotification) rpcResult(id, errorResult(`"${name}" is available in the expert tool profile. Enable it with: canary setup --mcp-profile expert`));
          break;
        }
        if (!toolsFor(profile).some((t) => t.name === name)) {
          if (!isNotification) rpcError(id, -32602, `unknown tool "${name}" — see tools/list`);
          break;
        }
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        let out: ReturnType<typeof callTool>;
        try { out = callTool(name, args); } catch (e) {
          out = errorResult(`tool "${name}" failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!isNotification) rpcResult(id, out);
        break;
      }
      default:
        if (!isNotification) rpcError(id, -32601, `method not found: ${msg.method}`);
        break;
    }
  }
  log('stdin closed — server exiting');
  return 0;
}
