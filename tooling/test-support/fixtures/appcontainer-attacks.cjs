const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const [root, port, nonce] = process.argv.slice(2);
const evidence = path.join(process.cwd(), 'evidence.json');
const report = { nonce, started: true, attempts: [] };
function record(id, operation) {
  try { operation(); report.attempts.push({ id, executed: true, result: 'ALLOWED' }); }
  catch (e) { report.attempts.push({ id, executed: true, result: e.code }); }
}
fs.writeFileSync(evidence, JSON.stringify(report));
record('work-write', () => fs.writeFileSync('allowed.txt', nonce));
record('work-read', () => fs.readFileSync('allowed.txt'));
record('authority-read', () => fs.readFileSync(path.join(root, 'authority', 'secret.txt')));
record('authority-write', () => fs.writeFileSync(path.join(root, 'authority', 'secret.txt'), 'attacked'));
record('junction-read', () => fs.readFileSync(path.join(process.cwd(), 'escape', 'secret.txt')));
report.attempts.push({ id: 'environment-secret', executed: true,
  result: process.env.CANARY_PROBE_SECRET === nonce ? 'EXPOSED' : 'ABSENT' });
const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  socket.destroy();
  report.attempts.push({ id: 'tcp-loopback', executed: true, result });
  fs.writeFileSync(evidence, JSON.stringify(report));
}
socket.once('connect', () => finish('CONNECTED'));
socket.once('error', e => finish(e.code));
socket.setTimeout(5000, () => finish('TIMEOUT'));
