/** Trusted operator/controller lifecycle. Caller payloads are data, never commands.
 * The base, enrollment, receipts and private verification worktrees stay outside
 * the caller's package grant. Candidate code runs through the native runner. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cmdIsolate, controllerCandidate } from '../candidate.js';
import { candidateIdentity, configPath, gitCommand, readConfig, untrustedConfigReason, CLI_ENTRY } from '../onboarding.js';
import { controllerExecution, type ControllerExecution } from './execution.js';
import { enrollMeasurementAuthority, measurementGeneration, productionHost } from './production-measurement.js';

import { providerRoot } from './assets.js';
export const nativeRoot = path.join(providerRoot, 'tools/windows-boundary');
const sha = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');
export const quote = (value: string): string => {
  if (/["\r\n\0]/.test(value)) throw new Error('unsupported native argument');
  return `"${value.replace(/\\+$/, '$&$&')}"`;
};
export function plainFile(file: string): Buffer {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 16 * 1024 * 1024) throw new Error('unsafe authority file');
  return fs.readFileSync(file);
}
function noLinks(file: string): void {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('linked authority path refused');
    if (path.dirname(p) === p) break;
  }
}
export function read<T>(file: string): T { noLinks(file); return JSON.parse(plainFile(file).toString('utf8')) as T; }
export function write(file: string, value: unknown): void {
  noLinks(file);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temp, file);
}
export function native(store: string, request: Record<string, unknown>) {
  const file = path.join(store, `${crypto.randomUUID()}.native.json`);
  write(file, request);
  try {
    return spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(nativeRoot, 'production-native.ps1'), '-Request', file],
      { encoding: 'utf8', windowsHide: true, timeout: 150000, maxBuffer: 1024 * 1024 });
  } finally { fs.rmSync(file, { force: true }); }
}
export interface Enrollment {
  schema: 'canary-production/2'; id: string; store: string; base: string;
  project: string; package: string; verifier: string; pipe: string; profile: string;
  configDigest: string; gitConfigDigest: string; createdAt: string;
  owner: string;
}
interface Review {
  candidate: string; proposalDigest: string; head: string; baseHead: string;
  receipt: string; at: string; used: boolean;
}
export function enrollment(store: string): Enrollment {
  const e = read<Enrollment>(path.join(store, 'enrollment.json'));
  if (e.schema !== 'canary-production/2' || e.store !== fs.realpathSync(store)) throw new Error('foreign deployment');
  if (sha(plainFile(configPath(e.base))) !== e.configDigest ||
      sha(plainFile(path.join(e.base, '.git', 'config'))) !== e.gitConfigDigest) throw new Error('enrolled authority changed');
  noLinks(e.base);
  return e;
}
function git(root: string, args: string[]): string {
  const r = gitCommand(root, args, 120000);
  if (!r || r.status !== 0) throw new Error(`trusted git refused: ${r?.stderr ?? 'unavailable'}`);
  return r.stdout.trim();
}
function execution(e: Enrollment): ControllerExecution {
  return { hooksDirectory: path.join(e.store, 'empty-hooks'), run(argv, cwd, timeoutMs) {
    // A fresh verifier profile is distinct from the live builder's profile.
    // No caller can concurrently edit the private verification checkout.
    const scratch = fs.mkdtempSync(path.join(cwd, '.canary-exec-'));
    const side = path.join(e.store, `${crypto.randomUUID()}.token.jsonl`);
    let checkout = cwd;
    while (!fs.existsSync(path.join(checkout, '.git'))) {
      const parent = path.dirname(checkout);
      if (parent === checkout) throw new Error('private checkout metadata missing');
      checkout = parent;
    }
    const pointer = path.join(checkout, '.git'), originalPointer = plainFile(pointer);
    try {
      const child = path.join(scratch, 'child.cjs'), request = path.join(scratch, 'request.json');
      fs.copyFileSync(path.join(nativeRoot, 'production-child.cjs'), child);
      const runtime = path.join(e.store, 'runtime');
      const pinnedArgv = argv.map(arg => arg === process.execPath ? path.join(runtime, 'node.exe') :
        arg.startsWith(path.join(path.dirname(process.execPath), 'node_modules', 'npm') + path.sep)
          ? path.join(runtime, 'node_modules', 'npm', path.relative(path.join(path.dirname(process.execPath), 'node_modules', 'npm'), arg)) : arg);
      write(request, { argv: pinnedArgv, nodeDirectory: runtime, timeoutMs: Math.min(timeoutMs, 110000) });
      const r = native(e.store, { mode: 'run', command: [process.execPath, '--preserve-symlinks-main', '--preserve-symlinks', child, request].map(quote).join(' '),
        cwd, side, package: e.verifier, profile: scratch });
      const facts = plainFile(side).toString('utf8').split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x));
      if (r.error || facts.length !== 2 || facts[0].package !== e.verifier || !facts[0].appContainer ||
          !facts[0].restricted || facts[0].capabilities !== 0 || facts[0].integrity !== 'S-1-16-4096' ||
          facts[1].pid !== facts[0].pid || facts[1].exit !== r.status) throw new Error('restricted verification was not observed');
      // The native job has ceased before any candidate-authored output is read.
      const output = read<{ stdout: string; stderr: string; error?: string }>(path.join(scratch, 'output.json'));
      if (output.error) process.stderr.write(`confined subprocess infrastructure: ${output.error}\n`);
      return { status: output.error ? null : facts[1].exit as number, stdout: output.stdout, stderr: output.stderr + (output.error ?? ''),
        ...(output.error ? { error: new Error(output.error) } : {}) };
    } finally {
      // Before the verifier's next Git probe, restore a tampered gitdir pointer.
      // Otherwise even `git status` could execute a candidate-supplied filter.
      let altered = false;
      try { altered = !plainFile(pointer).equals(originalPointer); } catch { altered = true; }
      if (altered) {
        fs.rmSync(pointer, { recursive: true, force: true });
        fs.writeFileSync(pointer, originalPointer, { flag: 'wx' });
      }
      const removeLinks = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
          if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
            fs.rmSync(file, { force: true }); altered = true;
          } else if (stat.isDirectory()) removeLinks(file);
        }
      };
      removeLinks(checkout);
      // Only this fresh, validated scratch directory; never a candidate-selected path.
      noLinks(scratch);
      fs.rmSync(scratch, { recursive: true, force: true });
      if (altered) throw new Error('candidate changed private Git metadata or introduced linked paths');
    }
  } };
}
export async function enrollProduction(baseArg: string, storeArg: string): Promise<Enrollment> {
  if (process.platform !== 'win32') throw new Error('production native provider requires Windows');
  const base = fs.realpathSync(baseArg), store = path.resolve(storeArg);
  noLinks(base); noLinks(store);
  if (fs.existsSync(store)) throw new Error('deployment destination must be new');
  const cfg = readConfig(base);
  if (!cfg || cfg === 'corrupt' || untrustedConfigReason(base, cfg)) throw new Error('trusted setup enrollment required');
  if (!fs.lstatSync(path.join(base, '.git')).isDirectory()) throw new Error('enroll a standalone base repository');
  // Local Git config can invoke hooks, filters, fsmonitor, helpers, includes, etc.
  // This initial provider refuses such repositories rather than executing them.
  const config = plainFile(path.join(base, '.git', 'config')).toString('utf8');
  for (const line of config.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#') && !x.startsWith(';'))) {
    if (!/^(\[(core|user)\]|(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|name|email)\s*=)/i.test(line))
      throw new Error('unsupported executable or extended Git configuration');
  }
  fs.mkdirSync(store); fs.mkdirSync(path.join(store, 'empty-hooks')); fs.mkdirSync(path.join(store, 'reviews'));
  const id = crypto.randomUUID(), profile = `Canary.Confined.${id}`;
  const identity = (name: string): string => {
    const result = path.join(store, `${crypto.randomUUID()}.identity.json`);
    const r = native(store, { mode: 'identity', name, delete: false, result });
    if (r.status !== 0) throw new Error(`identity provisioning refused: ${r.stderr}`);
    return read<{ package: string }>(result).package;
  };
  const e: Enrollment = { schema: 'canary-production/2', id, store: fs.realpathSync(store), base,
    project: sha(base), package: identity(profile), verifier: identity(`${profile}.Verifier`),
    pipe: `canary-production-${id}`, profile, configDigest: sha(plainFile(configPath(base))),
    gitConfigDigest: sha(config), createdAt: new Date().toISOString(), owner: productionHost().user };
  const runtime = path.join(store, 'runtime');
  fs.mkdirSync(runtime);
  fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
  fs.cpSync(path.join(path.dirname(process.execPath), 'node_modules', 'npm'), path.join(runtime, 'node_modules', 'npm'), { recursive: true });
  const grant = spawnSync('C:\\Windows\\System32\\icacls.exe', [runtime, '/grant', `*${e.verifier}:(OI)(CI)(RX)`, `*${e.package}:(OI)(CI)(RX)`], { encoding: 'utf8', windowsHide: true });
  if (grant.status !== 0) throw new Error('read-only verifier runtime grant unavailable');
  const keys = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(store, 'producer.key'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx' });
  fs.writeFileSync(path.join(store, 'producer.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
  write(path.join(store, 'enrollment.json'), e);
  enrollMeasurementAuthority(store, id, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  return e;
}
export function serveProduction(store: string): Promise<number> {
  const e = enrollment(store);
  const request = path.join(store, 'broker-native.json');
  write(request, { mode: 'broker', argv: ['--pipe', e.pipe, '--store', e.store, '--target', e.base,
    '--package', e.package, '--identity', e.owner, '--controller', CLI_ENTRY, '--node', process.execPath] });
  const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(nativeRoot, 'production-native.ps1'), '-Request', request],
    { windowsHide: true, stdio: 'inherit' });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 2)); });
}
export function launchProductionCaller(store: string, cwd: string, argv: string[]): number {
  const e = enrollment(store);
  if (!argv.length) throw new Error('caller command required');
  noLinks(cwd);
  for (const authority of [e.base, e.store, path.resolve(nativeRoot, '../..')]) {
    const workPath = path.resolve(cwd).toLowerCase(), protectedPath = path.resolve(authority).toLowerCase();
    if (workPath === protectedPath || protectedPath.startsWith(workPath + path.sep) || workPath.startsWith(protectedPath + path.sep))
      throw new Error('caller work area overlaps protected authority');
  }
  const side = path.join(store, `${crypto.randomUUID()}.caller.jsonl`);
  const lock = path.join(store, 'caller.lock');
  const handle = fs.openSync(lock, 'wx');
  try {
    const r = native(store, { mode: 'run', command: argv.map(quote).join(' '), cwd, side, package: e.package });
    if (r.error) throw r.error;
    if (r.status !== 0 && r.stderr) process.stderr.write(r.stderr);
    return r.status ?? 2;
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
function proposal(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('proposal must be a file map');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 1000 || JSON.stringify(value).length > 3 * 1024 * 1024) throw new Error('proposal size refused');
  const names = new Set<string>();
  for (const [file, bytes] of entries) {
    if (!file.split('/').every(s => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(s) && !/[. ]$/.test(s) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) ||
        names.has(file.toLowerCase()) || (bytes !== null && (typeof bytes !== 'string' || Buffer.from(bytes, 'base64').toString('base64') !== bytes)))
      throw new Error('unsafe or ambiguous proposal file');
    names.add(file.toLowerCase());
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<string, string | null>;
}
/** Trusted transport entry: model data is never executed in this process.
 * No fallback. Hold the same launch lock while staging and reading the call;
 * a live worker must not race trusted writes through a substituted link. */
export function productionTool(store: string, cwd: string, request: unknown): unknown {
  const e = enrollment(store);
  noLinks(cwd);
  const work = fs.realpathSync(cwd).toLowerCase();
  for (const authority of [e.base, e.store, path.resolve(nativeRoot, '../..')]) {
    const protectedPath = path.resolve(authority).toLowerCase();
    if (work === protectedPath || work.startsWith(protectedPath + path.sep) || protectedPath.startsWith(work + path.sep))
      throw new Error('worker overlaps authority');
  }
  const payload = JSON.stringify(request);
  if (!payload || payload.length > 1024 * 1024) throw new Error('tool request size refused');
  const lock = path.join(store, 'caller.lock'), handle = fs.openSync(lock, 'wx');
  let call: string | undefined;
  try {
    call = fs.mkdtempSync(path.join(cwd, 'canary-tool-'));
    const script = path.join(call, 'tool.cjs'), side = path.join(store, `${crypto.randomUUID()}.tool-token.jsonl`);
    fs.copyFileSync(path.join(nativeRoot, 'production-tool.cjs'), script);
    fs.writeFileSync(path.join(call, 'request.json'), JSON.stringify({ request, runtime: path.join(e.store, 'runtime') }), { flag: 'wx' });
    const launched = native(store, { mode: 'run', command: [process.execPath, '--preserve-symlinks-main', script].map(quote).join(' '),
      cwd, side, package: e.package, gitDirectoryAlias: true });
    if (launched.error || launched.status !== 0) throw new Error(`confined tool launch failed; no fallback: ${launched.stderr}`);
    const facts = plainFile(side).toString('utf8').trim().split(/\r?\n/).map(x => JSON.parse(x));
    if (launched.error || launched.status !== 0 || facts.length !== 2 || facts[0].package !== e.package ||
        facts[0].appContainer !== true || facts[0].restricted !== true || facts[0].capabilities !== 0 ||
        facts[0].integrity !== 'S-1-16-4096' || facts[1].pid !== facts[0].pid || facts[1].exit !== 0)
      throw new Error('confined tool execution unproven; no fallback');
    // The output is untrusted model context, NEVER a verification verdict.
    return { observation: facts, output: read<unknown>(path.join(call, 'result.json')) };
  } finally {
    try { if (call) { noLinks(call); fs.rmSync(call, { recursive: true, force: true }); } }
    finally { fs.closeSync(handle); fs.unlinkSync(lock); }
  }
}
/** A builder may propose implementation bytes, never a new binding source for
 * a future operator seal. Check both declaration surfaces, even the one not
 * currently selected by discovery, and Windows case aliases. */
export function unchangedBindingSources(base: string, files: Record<string, string | null>): void {
  for (const [file, bytes] of Object.entries(files)) {
    const name = file.toLowerCase();
    if (name !== 'package.json' && name !== 'canary.project.json') continue;
    const source = path.join(base, name);
    const extract = (text: string | null): string => {
      if (text === null) return '{}';
      const value = JSON.parse(text);
      const proofs = name === 'package.json' ? value?.canary?.proofs : value?.proofs;
      if (proofs === undefined) return '{}';
      if (!proofs || typeof proofs !== 'object' || Array.isArray(proofs) ||
          !Object.values(proofs).every(v => typeof v === 'string')) throw new Error('invalid binding source');
      return JSON.stringify(Object.fromEntries(Object.entries(proofs).sort(([a], [b]) => a.localeCompare(b))));
    };
    const original = fs.existsSync(source) ? plainFile(source).toString('utf8') : null;
    if (extract(original) !== extract(bytes === null ? null : Buffer.from(bytes, 'base64').toString('utf8')))
      throw new Error('builder cannot create, replace or remove operator binding declarations');
  }
}
export async function productionAuthority(store: string, envelope: unknown): Promise<unknown> {
  const e = enrollment(store);
  const { client, request: req } = envelope as { client: Record<string, unknown>; request: Record<string, unknown> };
  if (client?.identity === e.owner && client.appContainer === false && req?.verb === 'heartbeat' &&
      req.project === e.project && req.deployment === e.id && typeof req.nonce === 'string' && /^[0-9a-f]{64}$/.test(req.nonce)) {
    const payload = { schema: 'canary-production-heartbeat/2', deployment: e.id, nonce: req.nonce, ...measurementGeneration(store) };
    return { status: 200, payload, signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), plainFile(path.join(store, 'producer.key'))).toString('base64') };
  }
  if (!client || client.identity !== e.owner || client.package !== e.package || client.appContainer !== true || client.restricted !== true ||
      client.capabilities !== 0 || client.integrity !== 'S-1-16-4096') throw new Error('unauthenticated caller');
  if (!req || req.project !== e.project || req.deployment !== e.id) throw new Error('foreign enrollment');
  if (req.verb === 'hello') return { status: 200, deployment: e.id, project: e.project };
  if (typeof req.candidate !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(req.candidate)) throw new Error('candidate identifier refused');
  const name = req.candidate;
  const record = path.join(store, 'reviews', `${name}.json`);
  return controllerExecution.run(execution(e), async () => {
    if (req.verb === 'review') {
      if (Object.keys(req).some(k => !['verb', 'project', 'deployment', 'candidate', 'files', 'challenge'].includes(k))) throw new Error('unexpected review field');
      if (fs.existsSync(record)) throw new Error('candidate already enrolled');
      const files = proposal(req.files), proposalDigest = sha(JSON.stringify(files));
      unchangedBindingSources(e.base, files);
      const baseHead = candidateIdentity(e.base).head;
      if (!baseHead) throw new Error('base identity unavailable');
      const work = path.join(os.tmpdir(), `canary-production-${e.id}-${name}`);
      // The controller creates a private worktree; the builder receives NO grant.
      if (await cmdIsolate([name, '--path', work, e.base]) !== 0) throw new Error('candidate isolation refused');
      const modes = git(work, ['ls-tree', '-r', 'HEAD']).split('\n').filter(Boolean);
      if (modes.some(x => !/^100(644|755) blob /.test(x))) throw new Error('linked/submodule candidate unsupported');
      for (const [file, bytes] of Object.entries(files)) {
        const dest = path.join(work, file); noLinks(dest);
        if (bytes === null) fs.rmSync(dest);
        else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from(bytes, 'base64')); }
      }
      git(work, ['add', '--all']);
      git(work, ['-c', 'user.name=Canary broker', '-c', 'user.email=canary@localhost', 'commit', '-m', `Reviewed proposal ${name}`]);
      const head = candidateIdentity(work).head;
      if (!head || await controllerCandidate(e.base, name, head, baseHead, false) !== 0) {
        process.stderr.write(`private candidate status: ${git(work, ['status', '--porcelain'])}\n`);
        throw new Error('candidate verification refused');
      }
      const at = new Date().toISOString();
      const payload = JSON.stringify({ deployment: e.id, project: e.project, candidate: name, proposalDigest, head, baseHead, at, nonce: crypto.randomUUID() });
      const receipt = Buffer.from(payload).toString('base64url') + '.' + crypto.sign(null, Buffer.from(payload), plainFile(path.join(store, 'producer.key'))).toString('base64url');
      write(record, { candidate: name, proposalDigest, head, baseHead, at, receipt, used: false } satisfies Review);
      return { status: 200, candidate: name, digest: proposalDigest, head, receipt };
    }
    if (req.verb !== 'promote' || Object.keys(req).some(k => !['verb', 'project', 'deployment', 'candidate', 'digest', 'receipt', 'challenge'].includes(k)))
      throw new Error('unrecognized authority operation or substituted body');
    const r = read<Review>(record);
    if (r.used || req.receipt !== r.receipt || req.digest !== r.proposalDigest || Date.now() - Date.parse(r.at) > 600000)
      throw new Error('missing, stale, substituted or replayed review');
    // Consume before apply; an interrupted operation never makes a receipt reusable.
    write(record, { ...r, used: true });
    if (await controllerCandidate(e.base, name, r.head, r.baseHead, true) !== 0) throw new Error('protected promotion refused');
    const result = candidateIdentity(e.base);
    if (result.head !== r.head || result.dirty !== false) throw new Error('promotion readback failed');
    return { status: 200, appliedBy: 'broker', head: result.head, tree: result.tree };
  });
}
