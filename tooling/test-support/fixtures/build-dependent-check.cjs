// A project whose tests exercise its built artifact, rather than its source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const action = process.argv[2];
assert.ok(['build', 'test'].includes(action));
fs.appendFileSync('check-order.txt', `${action}\n`);
if (action === 'build') {
  assert.notEqual(fs.readFileSync('implementation.json', 'utf8').trim(), 'BUILD_ERROR');
  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync('implementation.json', path.join('dist', 'implementation.json'));
} else {
  assert.equal(JSON.parse(fs.readFileSync(path.join('dist', 'implementation.json'), 'utf8')), true,
    'compiled implementation must meet the regression assertion');
  console.log('1 test passed');
}
