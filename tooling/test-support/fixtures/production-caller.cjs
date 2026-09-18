const fs = require('node:fs');
const net = require('node:net');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const observations = [];
const call = request => new Promise((resolve, reject) => {
  const s = net.connect('\\\\.\\pipe\\' + cfg.pipe); let buffer = '';
  s.setTimeout(120000);
  s.on('connect', () => s.write(JSON.stringify(request) + '\n'));
  s.on('data', bytes => { buffer += bytes; if(buffer.includes('\n')) { s.destroy(); resolve(JSON.parse(buffer.split('\n')[0])); } });
  s.on('error', reject); s.on('timeout', () => { s.destroy(); reject(new Error('broker timeout')); });
});
(async () => {
  const common = { deployment: cfg.id, project: cfg.project, candidate: cfg.candidate, challenge: cfg.challenge };
  for (const item of cfg.actions) {
    if (item.write) {
      try { fs.writeFileSync(item.write, item.body); observations.push({ id: item.id, executed: true, allowed: true }); }
      catch(e) { observations.push({ id: item.id, executed: true, allowed: false, error: e.code }); }
      continue;
    }
    let request = { ...common, ...item.request };
    if (item.useReview) {
      const review = observations.find(x => x.id === 'review')?.response;
      request = { ...request, receipt: review?.receipt, digest: review?.digest, ...item.override };
    }
    observations.push({ id: item.id, executed: true, response: await call(request) });
  }
  fs.writeFileSync(cfg.output, JSON.stringify(observations));
})().catch(e => { fs.writeFileSync(cfg.output, JSON.stringify({ error: e.stack, observations })); process.exitCode = 2; });
