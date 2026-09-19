// Runs ONLY inside the AppContainer. Records what the live sandbox drive alias
// actually exposes, then holds the alias open for a measured interval so the TRUSTED
// side can observe the session device namespace while it is live.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [seconds, startedFile, reportFile, otherWork, authorityJson, exitCode] = process.argv.slice(2);
const sha = (p, kind) => { try { return { kind, path: p, allowed: true, digest: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }; }
  catch (e) { return { kind, path: p, allowed: false, error: e.code || e.message }; } };
const out = { pid: process.pid };
try { out.cwd = process.cwd(); } catch (e) { out.cwd = 'unavailable: ' + (e.code || e.message); }
try { out.entries = fs.readdirSync('.').sort(); } catch (e) { out.entries = 'error: ' + (e.code || e.message); }
try { out.parent = path.resolve('..'); } catch (e) { out.parent = 'error: ' + (e.code || e.message); }
// The alias root is whatever letter the trusted launcher chose; the process's own cwd
// IS that root, so nothing here hardcodes a drive letter.
out.relativeMarker = sha(path.join('.', 'sandbox-marker.txt'), 'sandbox-marker-relative');
out.aliasRootMarker = sha(path.join(out.cwd, 'sandbox-marker.txt'), 'sandbox-marker-through-alias-root');
out.aliasRootListing = (() => { try { return { kind: 'listing', allowed: true, names: fs.readdirSync(out.cwd).sort() }; }
  catch (e) { return { kind: 'listing', allowed: false, error: e.code || e.message }; } })();
out.otherSandboxMarker = sha(path.join(otherWork, 'sandbox-marker.txt'), 'other-sandbox-marker');
out.authority = Object.fromEntries(Object.entries(JSON.parse(authorityJson)).map(([name, p]) => [name, sha(p, name)]));
fs.writeFileSync(startedFile, JSON.stringify(out));
if (exitCode === 'kill') { process.kill(process.pid, 'SIGKILL'); }
// Deterministic wait with no child process and no shell.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(seconds) * 1000);
out.heldMs = Number(seconds) * 1000;
fs.writeFileSync(reportFile, JSON.stringify(out));
process.exit(Number(exitCode) || 0);
