const { spawn } = require('node:child_process');
const path = require('node:path');
const child = spawn(process.execPath, [path.join(__dirname, 'process-tree-survivor.cjs')], {
  stdio: 'ignore', windowsHide: true,
});
child.unref();
console.log(String(child.pid));
setTimeout(() => {}, 300_000);
