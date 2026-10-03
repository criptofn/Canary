// A no-model control for producer survival after its launcher exits.
const fs = require('node:fs');
setTimeout(() => {
  fs.writeFileSync(process.argv[2], JSON.stringify({ status: 'complete', pid: process.pid }));
  console.log('PASS detached producer completed; no model was called');
}, 15000);
