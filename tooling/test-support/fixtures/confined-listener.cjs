// Independent trusted observer. Its journal is outside the confined work area.
const fs = require('node:fs');
const net = require('node:net');
const [ready, journal, host = '127.0.0.1'] = process.argv.slice(2);
const server = net.createServer(socket => {
  fs.appendFileSync(journal, JSON.stringify({ event: 'connected', at: Date.now(), port: socket.remotePort }) + '\n');
  socket.end('observed\n');
});
fs.writeFileSync(journal, '');
server.listen(0, host, () => fs.writeFileSync(ready, String(server.address().port)));
