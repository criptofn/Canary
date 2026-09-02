#!/usr/bin/env node
'use strict';
// Entry point mirroring mocha's bin surface the pipeline actually uses:
//   mocha [spec files…] --require <preload>
// ORDER IS LOAD-BEARING: require('../index.js') runs BEFORE the preload is
// loaded, so the preload's path-anchored require.cache scan (design rule 4
// of observer-preload.ts) finds the Runner/Runnable classes under
// node_modules/mocha and patches the SAME prototypes the tests will execute
// through. Unknown options fail loud (exit 255) — a silently ignored flag
// would mean Canary's argv injection was not what ran.
const path = require('node:path');
const M = require('../index.js');

const argv = process.argv.slice(2);
const files = [];
const requires = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--require' || a === '-r') {
    if (i + 1 >= argv.length) { console.error('mocha-double: ' + a + ' needs a path'); process.exit(255); }
    requires.push(argv[++i]);
  } else if (a.startsWith('-')) {
    console.error('mocha-double: unsupported option ' + a);
    process.exit(255);
  } else {
    files.push(a);
  }
}
if (files.length === 0) { console.error('mocha-double: no spec files given'); process.exit(255); }
for (const r of requires) require(path.resolve(process.cwd(), r));

(async () => {
  const mocha = new M.Mocha();
  for (const f of files) mocha.addFile(path.resolve(process.cwd(), f));
  mocha.loadFiles();
  process.exitCode = await mocha.run();
})().catch((e) => {
  console.error('mocha-double: fatal ' + ((e && e.message) || String(e)));
  process.exitCode = 255;
});
