/** Broker-side LOCAL store. A same-UID worker can replace key AND history.
 * Never import into a privileged process that also executes candidate code.
 * HARDENED requires separate OS custody of this store and all its ancestors.
 *
 * Merged with the 1.1 P0 review slice on this branch. Astra owns the seal
 * shape (strict ledger equality, CAS, fsync'd atomic writes, signed payloads
 * passed through authorityJson) and the SINGLE minting lock. This branch adds
 * back, on top of it:
 *   - the CANARY_TRUST_STORE pointer (storeFromEnv) and projectIdForRoot, the
 *     two names setup/status/doctor are wired through;
 *   - a BOUNDED WAIT plus an explicit busy REFUSAL folded into Astra's lock —
 *     one lock, no nesting, and a lock is still NEVER stolen (a killed writer
 *     needs operator recovery, never an automatic reclaim);
 *   - the writability probe with a unique filename and a read-back check, and
 *     this branch's user-visible level reasons;
 *   - custody refusals that walk only components AT or UNDER the store root
 *     (a link-redirected temp root must not refuse every store on the host)
 *     while still naming what was refused: inconsistent keypairs, symbolic
 *     link or junction key material, hard-linked key material, reserved
 *     Windows device names.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorityJson, isEnvelope, RECORD_SCHEMA, signedBytes, verifySeal, type RecordEnvelope } from './authority-envelope.js';
export { authorityJson, RECORD_SCHEMA, signedBytes, verifySeal, type RecordEnvelope } from './authority-envelope.js';

/** Store custody levels. HARDENED is deliberately unreachable in this build
 *  (no broker is installed as a separate identity) — see probeTrustLevel; it
 *  is NOT an empty option. */
export type TrustLevel = 'HARDENED' | 'LOCAL' | 'ADVISORY' | 'UNSUPPORTED';
/** Broker installation configuration, NEVER a worker request parameter. */
export interface TrustStore { root: string }
export function defaultStoreRoot(home: string = os.userInfo().homedir): string {
  return process.platform === 'win32' ? path.join(home, 'AppData', 'Local', 'canary', 'trust')
    : path.join(home, '.local', 'share', 'canary', 'trust');
}

/**
 * The store this process uses: the OS-home default, or an explicit
 * CANARY_TRUST_STORE pointer (test/dev steering — the same legitimate need the
 * fake-home test already serves, without touching git identity). The override
 * changes WHERE Canary looks, never WHETHER it verifies: it can only ever aim
 * at an empty or already-valid store. Aimed at an empty one, every read fails
 * closed (missing/unavailable) — records are never trusted more because a
 * pointer named them.
 */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): TrustStore {
  const v = env.CANARY_TRUST_STORE?.trim();
  return { root: v ? path.resolve(v) : defaultStoreRoot() };
}

/** Stable, path-free project identity: a safe id derived from the resolved
 *  repo root. Two checkouts of one folder share it; renames do not forge a
 *  new record shelf out of an old one (reads still bind to the sealed bytes). */
export function projectIdForRoot(root: string): string {
  return 'p-' + crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 32);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Windows resolves these as DEVICES even with an extension or trailing space,
 *  so a segment naming one can never become an ordinary directory entry. */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
function safeSegment(value: string, what: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value.endsWith('.')) throw new Error(`${what} "${value}" is not a safe identifier`);
  if (RESERVED_DEVICE.test(value)) throw new Error(`${what} "${value}" is not a safe identifier: it is a reserved Windows device name`);
  return value;
}
const keyPath = (s: TrustStore) => path.join(s.root, 'keys', 'ed25519');

/** A custody refusal: the path exists but is not a plain file/directory Canary
 *  may trust. Carries a marker so readers can report it as 'unavailable'
 *  (refused for cause) instead of 'malformed' (bytes that do not parse). */
function custody(message: string): Error {
  return Object.assign(new Error(message), { custody: true });
}

/**
 * Every path this module touches must resolve at or UNDER the store root, must
 * be absolute, and must be a PLAIN file/directory there:
 *   - a symbolic link or junction is a second name for bytes someone else can
 *     re-aim or share. A linked public half lets whoever controls the target
 *     swap in a key they own, after which records THEY signed verify as valid;
 *     a linked private half aims signing at bytes outside the store; a linked
 *     record file re-binds a shelf to foreign bytes. All refused, never
 *     followed;
 *   - a hardlink is not a copy. The same bytes appear under a second path the
 *     worker controls, so "the key never leaves the store" is false while
 *     every mode bit still looks right;
 *   - a path outside the root is never a store path at all.
 * The walk starts AT the store root and goes down. Components ABOVE the root
 * are deliberately never inspected: they are platform plumbing (macOS
 * /var -> /private/var, junctions inside os.tmpdir()), and refusing them would
 * break every store on those hosts while protecting nothing — the root's own
 * component IS checked, so a linked root (a second name for the whole store)
 * is still refused.
 * This is static redirection defense, NOT a same-UID race-proof jail.
 */
function checked(s: TrustStore, file: string): string {
  if (!path.isAbsolute(file)) throw new Error('trust store requires an absolute path');
  if (!path.isAbsolute(s.root)) throw new Error(`trust store root "${s.root}" is not an absolute path`);
  const root = path.resolve(s.root);
  const target = path.resolve(file);
  const rel = path.relative(root, target);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
    throw custody(`trust store refuses a path outside its root: ${target}`);
  }
  let cur = root;
  for (const part of ['.', ...rel.split(path.sep).filter(Boolean)]) {
    if (part !== '.') cur = path.join(cur, part);
    const what = part === '.' ? 'the trust store root' : cur;
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) throw custody(`${what} is a symbolic link or junction — a linked path is a second name for these bytes and is not trust material`);
      if (!st.isDirectory()) {
        if (!st.isFile()) throw custody(`${what} is a special path (not a regular file or directory) — the trust store trusts neither`);
        if (st.nlink !== 1) throw custody(`${what} has ${st.nlink} hard links — the same bytes have another name outside the store`);
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return target;
}
function read(s: TrustStore, file: string): string { return fs.readFileSync(checked(s, file), 'utf8'); }
/** Bounded wait for a concurrent minter, and the poll interval. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;
/** No async lives in this module (every caller is synchronous and must be able
 *  to fail closed mid-step), so a synchronous park is the honest primitive. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Cooperating writers serialize on ONE lock. A held lock is waited for up to
 *  LOCK_WAIT_MS and then REFUSED — never stolen and never removed: a killed
 *  broker needs operator recovery, and a malicious same-UID holder is not
 *  excluded either way (that is the documented LOCAL ceiling). The seq ledger
 *  is read-modify-write, so two concurrent seals of one lane could both claim
 *  generation N and one record would silently replace the other; the bounded
 *  wait converts that lost update into a refusal, and it never invents
 *  authority: if the lock cannot be taken this THROWS and the caller fails
 *  closed. */
function locked<T>(s: TrustStore, action: () => T): T {
  const root = checked(s, path.resolve(s.root));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  checked(s, root); // re-verify what the kernel actually created
  const lock = checked(s, path.join(root, '.authority-lock'));
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw new Error(`the trust store is busy: another Canary process holds ${lock} — refusing to mint a record that could overwrite a concurrent seal; the lock is never stolen, so a killed writer needs the lock directory removed`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try { return action(); } finally { if (acquired) fs.rmdirSync(lock); }
}
function writeAtomic(s: TrustStore, file: string, text: string): void {
  const target = checked(s, file);
  fs.mkdirSync(checked(s, path.dirname(target)), { recursive: true, mode: 0o700 });
  const tmp = checked(s, `${target}.tmp-${crypto.randomUUID()}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, target); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  // Windows Node cannot fsync directories; power-loss durability there is a gap.
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}
function key(s: TrustStore): { publicKey: string } {
  const privPath = checked(s, keyPath(s)), pubPath = checked(s, `${keyPath(s)}.pub`);
  const hasPub = fs.existsSync(pubPath), hasPriv = fs.existsSync(privPath);
  // half a keypair: refusing beats "regenerate and orphan every record".
  if (hasPub !== hasPriv) throw new Error('trust store key material is incomplete (the public and private halves must coexist) — refusing to regenerate a key that sealed records already name');
  if (!hasPub) {
    if (fs.existsSync(path.join(s.root, 'ledger.json')) || fs.existsSync(path.join(s.root, 'records'))) throw new Error('trust store key material is missing from an initialized store; operator recovery is required, never silent re-minting');
    const pair = crypto.generateKeyPairSync('ed25519');
    writeAtomic(s, privPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    writeAtomic(s, pubPath, pair.publicKey.export({ type: 'spki', format: 'pem' }) as string);
    writeAtomic(s, path.join(s.root, 'ledger.json'), '{}');
  }
  const priv = crypto.createPrivateKey(read(s, privPath)), pub = crypto.createPublicKey(read(s, pubPath));
  // Does the private half actually derive the stored public half? A store whose
  // halves disagree signs records that verify as `forged` and reports every past
  // record as `forged` too — a failure indistinguishable from an attack, and one
  // that would tempt a caller to "fix" it by re-minting. Refuse it up front.
  if (priv.asymmetricKeyType !== 'ed25519' || pub.asymmetricKeyType !== 'ed25519'
    || !crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).equals(pub.export({ type: 'spki', format: 'der' }))) throw new Error('trust store key material is inconsistent: the private half does not match the public half — refusing to sign or verify with a mismatched keypair');
  return { publicKey: read(s, pubPath) };
}
export function ensureStoreKey(s: TrustStore): { publicKey: string } { return locked(s, () => key(s)); }
function readLedger(s: TrustStore): Record<string, number> {
  const raw: unknown = JSON.parse(read(s, path.join(s.root, 'ledger.json')));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('authority ledger malformed');
  for (const [lane, seq] of Object.entries(raw)) {
    const parts = lane.split('/');
    if (parts.length !== 2) throw new Error('authority ledger lane malformed');
    parts.forEach(p => safeSegment(p, 'ledger segment'));
    if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw new Error('authority ledger sequence malformed');
  }
  return raw as Record<string, number>;
}
/** Reserve seq BEFORE record publication. Interrupted writes deny, never pass.
 * CAS is optional for legacy callers; mandatory for broker state transitions. */
export function sealRecord(s: TrustStore, input: {
  projectId: string; kind: string; payload: unknown; canaryVersion: string;
}, expectedSeq?: number): RecordEnvelope {
  const projectId = safeSegment(input.projectId, 'project id'), kind = safeSegment(input.kind, 'record kind');
  const payload = JSON.parse(authorityJson(input.payload));
  return locked(s, () => {
    key(s);
    const ledger = readLedger(s), lane = `${projectId}/${kind}`;
    const previous = ledger[lane] ?? 0;
    const recordExists = fs.existsSync(checked(s, path.join(s.root, 'records', projectId, `${kind}.json`)));
    if ((previous === 0 && recordExists) || (previous > 0 && openSealed(s, { projectId, kind }).status !== 'valid')) throw new Error('authority history inconsistent; operator recovery required');
    if (expectedSeq !== undefined && expectedSeq !== previous) throw new Error('authority compare-and-swap conflict');
    const seq = previous + 1;
    if (!Number.isSafeInteger(seq)) throw new Error('authority sequence exhausted');
    const body = { schema: RECORD_SCHEMA, projectId, kind, seq, issuedAt: new Date().toISOString(), canaryVersion: input.canaryVersion, payload };
    const signature = crypto.sign(null, signedBytes(body), crypto.createPrivateKey(read(s, keyPath(s)))).toString('base64');
    const envelope = { ...body, signature };
    ledger[lane] = seq;
    writeAtomic(s, path.join(s.root, 'ledger.json'), authorityJson(ledger));
    writeAtomic(s, path.join(s.root, 'records', projectId, `${kind}.json`), authorityJson(envelope));
    return envelope;
  });
}
export type OpenStatus = 'valid' | 'missing' | 'malformed' | 'forged' | 'mismatch' | 'stale' | 'unavailable';
export interface OpenResult { status: OpenStatus; envelope?: RecordEnvelope; reason: string }
export function openSealed(s: TrustStore, want: { projectId: string; kind: string }): OpenResult {
  let projectId: string, kind: string;
  try { projectId = safeSegment(want.projectId, 'project id'); kind = safeSegment(want.kind, 'record kind'); }
  catch { return { status: 'malformed', reason: 'not a safe identifier' }; }
  let pub: string;
  try { pub = read(s, `${keyPath(s)}.pub`); }
  catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === 'ENOENT'
      ? { status: 'unavailable', reason: 'the trust store has no verification key — nothing can be certified from it' }
      : { status: 'unavailable', reason: `the trust store key material is not usable here: ${err.message}` };
  }
  let env: unknown;
  try { env = JSON.parse(read(s, path.join(s.root, 'records', projectId, `${kind}.json`))); }
  catch (e) {
    const err = e as NodeJS.ErrnoException & { custody?: boolean };
    if (err.custody) return { status: 'unavailable', reason: `the sealed ${kind} record is not usable here: ${err.message}` };
    return { status: err.code === 'ENOENT' ? 'missing' : 'malformed', reason: err.code === 'ENOENT' ? `no sealed ${kind} record for project ${projectId}` : 'sealed record unavailable or malformed' };
  }
  if (!isEnvelope(env)) return { status: 'malformed', reason: 'sealed record shape or schema malformed' };
  if (!verifySeal(env, pub)) return { status: 'forged', reason: 'signature does not match the store key' };
  if (env.projectId !== projectId || env.kind !== kind) return { status: 'mismatch', reason: 'a moved file re-binds nothing' };
  let seq: number | undefined;
  try { seq = readLedger(s)[`${projectId}/${kind}`]; }
  catch { return { status: 'unavailable', reason: 'authority ledger unavailable or malformed; recovery required' }; }
  if (seq !== env.seq) return { status: 'stale', reason: 'record sequence must equal committed ledger sequence' };
  return { status: 'valid', envelope: env, reason: 'valid' };
}
/**
 * Measure the boundary — never infer it. The CLI shares its uid with the
 * worker, so a successful store write PROVES the worker could write it too
 * (that is LOCAL, named plainly). Write failure is the only observation that
 * could ever precede a stronger word, and this build installs no broker that
 * could make one, so failure here can only report UNSUPPORTED.
 */
export function probeTrustLevel(s: TrustStore): { level: TrustLevel; reasons: string[] } {
  // Unique per call: a pid-only probe name is itself a race — two probes in
  // flight would read each other's bytes, one would see a foreign pid, and the
  // store would be reported UNSUPPORTED for no reason (a false NEGATIVE that
  // would hide a real store).
  let probeFile: string | null = null;
  try {
    const root = checked(s, path.resolve(s.root)); // a linked root is not a store this probe may bless
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    probeFile = checked(s, path.join(root, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`));
    fs.writeFileSync(probeFile, String(process.pid), { flag: 'wx', mode: 0o600 });
    const back = fs.readFileSync(probeFile, 'utf8');
    if (back !== String(process.pid)) return { level: 'UNSUPPORTED', reasons: ['the trust store write probe did not read back — authority cannot live here'] };
  } catch {
    return { level: 'UNSUPPORTED', reasons: [`the trust store at ${s.root} is not writable by this process — authority-changing operations fail closed here`] };
  } finally {
    if (probeFile !== null) { try { fs.unlinkSync(probeFile); } catch { /* never created, or already gone */ } }
  }
  return { level: 'LOCAL', reasons: [
    'records are sealed outside the repo with an Ed25519 key this store owns',
    'the same uid that runs the worker can also write this store — sealing detects, it does not prevent; HARDENED requires a broker with a different identity and is NOT claimed',
  ] };
}

/**
 * The READ-ONLY companion to probeTrustLevel.
 *
 * `canary status` and `canary result` promise to write nothing, and the write
 * probe above would silently break that promise: the productization metrics
 * probe caught exactly that — three write syscalls on a command documented as
 * zero-write (the probe file is created and unlinked, so the bytes on disk are
 * unchanged and only a counter can see it).
 *
 * So the read-only surfaces use an ACCESS check plus the presence of a store,
 * write nothing, and SAY SO in the reasons. The stronger, writing measurement
 * stays where writing is already part of the job (`setup`, `doctor`), and no
 * path here can report a level it did not measure: neither variant can return
 * HARDENED, because no installed provider establishes a separate identity.
 */
export function probeTrustLevelReadOnly(s: TrustStore): { level: TrustLevel; reasons: string[] } {
  let root: string;
  try { root = checked(s, path.resolve(s.root)); }
  catch (e) { return { level: 'UNSUPPORTED', reasons: [`the trust store root cannot be trusted as a store: ${(e as Error).message}`] }; }
  if (!fs.existsSync(root)) {
    return { level: 'UNSUPPORTED', reasons: [`no trust store at ${root} yet — run setup to create and seal one; nothing was written to check this`] };
  }
  try { fs.accessSync(root, fs.constants.W_OK); }
  catch {
    return { level: 'UNSUPPORTED', reasons: [`the trust store at ${root} is not writable by this process — authority-changing operations fail closed here`] };
  }
  return { level: 'LOCAL', reasons: [
    'records are sealed outside the repo with an Ed25519 key this store owns',
    'the same uid that runs the worker can also write this store — sealing detects, it does not prevent; HARDENED requires a broker with a different identity and is NOT claimed',
    'read-only assessment: this command wrote nothing, so writability was checked by access rather than by a write probe (canary doctor measures it by writing)',
  ] };
}
