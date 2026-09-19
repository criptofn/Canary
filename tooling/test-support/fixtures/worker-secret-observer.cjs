const fs = require('node:fs');
const report = { apiCredential: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), brokerSecret: !!process.env.CANARY_BROKER_SECRET };
for (const file of process.argv.slice(2)) {
  try { fs.readFileSync(file); report[file] = 'READABLE'; }
  catch (error) { report[file] = error.code; }
}
console.log(JSON.stringify(report));
