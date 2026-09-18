const fs = require('node:fs');
const [outside, evidence, nonce] = process.argv.slice(2);
const result = { pid: process.pid, nonce, executed: true };
try { fs.writeFileSync(outside, nonce); result.result = 'ALLOWED'; }
catch (error) { result.result = error.code; }
fs.writeFileSync(evidence, JSON.stringify(result));
