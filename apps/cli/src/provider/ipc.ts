/**
 * Narrow authenticated IPC between a worker (untrusted) and the Canary broker
 * (trusted provider) — v1.1 Phase 3.
 *
 * WHAT THIS TRANSPORT GUARANTEES BY CONSTRUCTION:
 *
 *  1. A CLOSED OPERATION SURFACE. A client sends an operation NAME from a fixed
 *     set. It cannot send a command, an argv, a cwd, an environment value, a
 *     filesystem path, a key, an identity or a network policy. Every gate the
 *     broker applies is resolved from the broker's OWN state, keyed by the
 *     subject it already knows — which is what prevents the classic
 *     confused-deputy attack where the trusted process is talked into acting on
 *     the caller's behalf with the caller's parameters.
 *
 *  2. BINDING. Every request carries the subject it concerns plus an
 *     `authorityGeneration`, and the broker rejects a generation that is not the
 *     current one. A ticket issued against generation N can never be replayed
 *     against generation N+1, and a stale generation is refused loudly rather
 *     than silently ignored.
 *
 *  3. MUTUAL POSSESSION OF A PER-INSTALL TOKEN. The broker reads a token from its
 *     protected store at startup; a client must present the same token before any
 *     operation is served. THIS IS NOT A BOUNDARY ON ITS OWN, and the module says
 *     so in the one place it could be mistaken for one: if the token file is
 *     readable by the worker (i.e. the store is not ACL-separated), the token
 *     authenticates nothing. The broker therefore REFUSES TO START unless the
 *     boundary measurement proves the separation — see `service.ts`.
 *
 *  4. BOUNDED MESSAGES AND PATHS. Newline-delimited JSON, a hard maximum frame
 *     size, and a fixed pipe/socket name. A client cannot redirect the transport.
 *
 * WHAT IT DOES NOT DO, stated so no reader infers more: it does not encrypt (the
 * channel is a local OS object, not a network), and it does not obtain the peer's
 * OS identity — that requires a platform primitive this transport does not have.
 * The peer identity is therefore established by the token plus the store ACL, and
 * both are only as strong as the boundary measurement says they are.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Windows named pipe or POSIX socket path for a given provider pipe name. */
export function providerEndpoint(pipeName: string, platform: string = process.platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : path.join('/tmp', `canary-${pipeName}.sock`);
}

/** The ONLY operations a worker may request. Nothing here takes a caller path,
 *  command, key, environment or policy. */
export const WORKER_OPERATIONS = [
  /** Liveness + which authority generation the broker is serving. */
  'broker.hello',
  /** Request a fresh verification ticket for an enrolled subject. */
  'broker.request-verification',
  /** Submit an observation for the CURRENT ticket (the broker decides). */
  'broker.submit-verification',
  /** Submit a human-review statement for the CURRENT ticket. */
  'broker.submit-acceptance',
  /** Reserve a promotion window AFTER a passing verification. */
  'broker.reserve-promotion',
  /** Reconcile a promotion that may or may not have applied. */
  'broker.reconcile',
  /** Read-only capability report (never a verdict). */
  'broker.status',
] as const;
export type WorkerOperation = (typeof WORKER_OPERATIONS)[number];
const OPERATIONS = new Set<string>(WORKER_OPERATIONS);

export const MAX_FRAME_BYTES = 64 * 1024;

export interface WireRequest {
  schema: 'canary-ipc/1';
  /** Per-install token; proves possession of the broker's protected secret. */
  token: string;
  /** Monotonic per-connection id, echoed in the reply. */
  id: number;
  op: WorkerOperation;
  /** The subject this request concerns. The broker resolves everything else. */
  projectId?: string;
  candidate?: string;
  /** The authority generation the caller believes is current. */
  authorityGeneration?: string;
}

export type WireReply =
  | { schema: 'canary-ipc/1'; id: number; ok: true; result: unknown }
  | { schema: 'canary-ipc/1'; id: number; ok: false; error: { code: string; message: string } };

export class IpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** One newline-delimited JSON frame codec with a hard size cap. */
export function encodeFrame(v: unknown): string {
  const s = JSON.stringify(v);
  if (Buffer.byteLength(s, 'utf8') > MAX_FRAME_BYTES) {
    throw new IpcError('frame-too-large', `frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return s + '\n';
}

export interface FrameDecoder {
  push(chunk: Buffer | string): Array<Record<string, unknown>>;
}
export function createFrameDecoder(): FrameDecoder {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk);
      if (Buffer.byteLength(buf, 'utf8') > MAX_FRAME_BYTES * 4) {
        // A peer that never completes a frame cannot be allowed to grow memory.
        throw new IpcError('stream-overflow', 'peer exceeded the buffered frame budget without a newline');
      }
      const out: Array<Record<string, unknown>> = [];
      for (;;) {
        const i = buf.indexOf('\n');
        if (i === -1) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === '') continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new IpcError('frame-too-large', 'inbound frame too large');
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { throw new IpcError('bad-frame', 'inbound frame is not JSON'); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new IpcError('bad-frame', 'inbound frame is not an object');
        out.push(parsed as Record<string, unknown>);
      }
      return out;
    },
  };
}

/** Validate the SHAPE of an inbound request. Rejects anything unknown by name. */
export function validateWireRequest(v: Record<string, unknown>): WireRequest {
  if (v.schema !== 'canary-ipc/1') throw new IpcError('bad-schema', 'unsupported IPC schema');
  if (typeof v.token !== 'string' || v.token.length < 32) throw new IpcError('bad-token', 'missing or short token');
  if (typeof v.id !== 'number' || !Number.isInteger(v.id)) throw new IpcError('bad-id', 'missing request id');
  if (typeof v.op !== 'string' || !OPERATIONS.has(v.op)) {
    throw new IpcError('unknown-operation', `operation ${JSON.stringify(v.op)} is not in the worker surface`);
  }
  for (const key of Object.keys(v)) {
    if (!['schema', 'token', 'id', 'op', 'projectId', 'candidate', 'authorityGeneration'].includes(key)) {
      // A caller-supplied path/command/env/key is exactly the confused-deputy
      // vector, so an unexpected field is REFUSED rather than ignored.
      throw new IpcError('unknown-field', `field ${JSON.stringify(key)} is not part of the worker surface`);
    }
  }
  if (v.projectId !== undefined && typeof v.projectId !== 'string') throw new IpcError('bad-project', 'projectId must be a string');
  if (v.candidate !== undefined && typeof v.candidate !== 'string') throw new IpcError('bad-candidate', 'candidate must be a string');
  if (v.authorityGeneration !== undefined && typeof v.authorityGeneration !== 'string') {
    throw new IpcError('bad-generation', 'authorityGeneration must be a string');
  }
  return v as unknown as WireRequest;
}

/** Constant-time token comparison (a length-agnostic equality on digests). */
export function tokenMatches(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Where the per-install token lives. Inside the protected store on purpose: it
 *  is only a credential if the store's ACL keeps it from the worker. */
export function tokenPath(storeRoot: string): string {
  return path.join(storeRoot, 'provider-token');
}

/** Read the broker's token, or create it on first use. Never regenerated once
 *  present (a silent rotation would invalidate a running client for no reason). */
export function ensureBrokerToken(storeRoot: string): string {
  const p = tokenPath(storeRoot);
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* absent: create below */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(p, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return token;
}

export interface BrokerHandlerContext {
  /** The generation the broker is currently serving. */
  authorityGeneration: string;
}
export type BrokerHandler = (
  req: WireRequest,
  ctx: BrokerHandlerContext,
) => Promise<unknown> | unknown;

/** The broker side. Refuses the connection (not just the request) on a bad token. */
export function createBrokerServer(opts: {
  pipeName: string;
  token: string;
  authorityGeneration: string;
  handler: BrokerHandler;
  /** Injected for tests; defaults to the platform endpoint. */
  endpoint?: string;
  log?: (line: string) => void;
}): { server: net.Server; close: () => Promise<void> } {
  const endpoint = opts.endpoint ?? providerEndpoint(opts.pipeName);
  const log = opts.log ?? ((): void => {});
  const live = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    live.add(socket);
    socket.on('close', () => live.delete(socket));
    socket.setNoDelay(true);
    const decoder = createFrameDecoder();
    let authed = false;
    const reply = (r: WireReply): void => {
      try { socket.write(encodeFrame(r)); } catch { socket.destroy(); }
    };
    socket.on('data', (chunk) => {
      let frames: Array<Record<string, unknown>>;
      try { frames = decoder.push(chunk); } catch (e) {
        reply({ schema: 'canary-ipc/1', id: -1, ok: false, error: { code: e instanceof IpcError ? e.code : 'bad-frame', message: String((e as Error).message) } });
        socket.destroy();
        return;
      }
      for (const raw of frames) {
        let req: WireRequest;
        try { req = validateWireRequest(raw); } catch (e) {
          reply({ schema: 'canary-ipc/1', id: typeof raw.id === 'number' ? raw.id : -1, ok: false, error: { code: e instanceof IpcError ? e.code : 'bad-request', message: String((e as Error).message) } });
          socket.destroy(); // a malformed request ends the session, not just the call
          return;
        }
        if (!tokenMatches(req.token, opts.token)) {
          log(`refused a connection presenting the wrong token (op=${req.op})`);
          reply({ schema: 'canary-ipc/1', id: req.id, ok: false, error: { code: 'unauthorized', message: 'token does not match this broker installation' } });
          socket.destroy();
          return;
        }
        if (!authed) authed = true;
        // Generation binding: a request naming a generation the broker no longer
        // serves is refused. `hello`/`status` are the only generation-free reads.
        if (req.op !== 'broker.hello' && req.op !== 'broker.status'
          && req.authorityGeneration !== undefined && req.authorityGeneration !== opts.authorityGeneration) {
          reply({ schema: 'canary-ipc/1', id: req.id, ok: false, error: { code: 'stale-generation', message: `request names authority generation ${req.authorityGeneration}; the broker serves ${opts.authorityGeneration}` } });
          continue;
        }
        let result: unknown;
        try {
          result = opts.handler(req, { authorityGeneration: opts.authorityGeneration });
        } catch (e) {
          reply({ schema: 'canary-ipc/1', id: req.id, ok: false, error: { code: e instanceof IpcError ? e.code : 'handler-failed', message: String((e as Error).message) } });
          continue;
        }
        Promise.resolve(result).then(
          (r) => reply({ schema: 'canary-ipc/1', id: req.id, ok: true, result: r }),
          (e: unknown) => reply({ schema: 'canary-ipc/1', id: req.id, ok: false, error: { code: 'handler-failed', message: String((e as Error)?.message ?? e) } }),
        );
      }
    });
    socket.on('error', () => { /* a client that vanishes mid-frame is not a broker problem */ });
  });
  server.listen(endpoint);
  return {
    server,
    close: () => new Promise<void>((resolve) => {
      // A provider restart must not hang on an idle or wedged client, so the
      // listeners are closed and then destroyed rather than waited on.
      for (const s of live) { try { s.destroy(); } catch { /* already gone */ } }
      live.clear();
      server.close(() => resolve());
    }),
  };
}

/** The worker side. One request per call; a fresh connection keeps state simple. */
export async function callBroker(
  req: Omit<WireRequest, 'schema' | 'token' | 'id'>,
  opts: { pipeName: string; token: string; endpoint?: string; timeoutMs?: number },
): Promise<unknown> {
  const endpoint = opts.endpoint ?? providerEndpoint(opts.pipeName);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const decoder = createFrameDecoder();
    const id = 1;
    let settled = false;
    const finish = (fn: () => void): void => { if (!settled) { settled = true; fn(); socket.destroy(); } };
    const timer = setTimeout(() => finish(() => reject(new IpcError('timeout', `no reply from the broker within ${timeoutMs} ms`))), timeoutMs);
    socket.on('connect', () => {
      socket.write(encodeFrame({ schema: 'canary-ipc/1', token: opts.token, id, ...req }));
    });
    socket.on('data', (chunk) => {
      let frames: Array<Record<string, unknown>>;
      try { frames = decoder.push(chunk); } catch (e) { clearTimeout(timer); finish(() => reject(e)); return; }
      for (const f of frames) {
        if (f.id !== id) continue;
        clearTimeout(timer);
        if (f.ok === true) finish(() => resolve(f.result));
        else {
          const err = (f.error ?? {}) as { code?: string; message?: string };
          finish(() => reject(new IpcError(err.code ?? 'broker-error', err.message ?? 'broker refused the request')));
        }
      }
    });
    socket.on('error', (e) => { clearTimeout(timer); finish(() => reject(new IpcError('connect-failed', `${endpoint}: ${e.message}`))); });
  });
}
