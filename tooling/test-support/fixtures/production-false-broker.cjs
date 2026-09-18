// Trusted negative-test server: never a production authority. A separate process
// is required because capability reporting performs a synchronous pipe query.
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const server = net.createServer(socket => {
  let data = '';
  socket.on('error', () => {});
  socket.on('data', bytes => {
    data += bytes;
    if (!data.includes('\n')) return;
    const request = JSON.parse(data.split('\n')[0]);
    const payload = { schema: 'canary-production-heartbeat/2', deployment: config.deployment,
      nonce: request.nonce, generation: config.generation, measurement: config.measurement };
    if (config.mode === 'deployment') payload.deployment = 'wrong-deployment';
    if (config.mode === 'generation') payload.generation = 'old-generation';
    if (config.mode === 'replay') payload.nonce = 'old-nonce';
    const key = config.mode === 'key' ? crypto.generateKeyPairSync('ed25519').privateKey : fs.readFileSync(config.key);
    socket.end(JSON.stringify({status: 200, payload, signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64')})+'\n');
  });
});
server.listen('\\\\.\\pipe\\'+config.pipe, () => fs.writeFileSync(config.ready, 'ready'));
