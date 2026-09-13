// Real fixture assertion: an overlaid expected value fails against the old implementation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const expected = path.join(process.cwd(), 'tests', 'regression.expected.json');
if (fs.existsSync(expected)) {
  assert.equal(require(path.join(process.cwd(), 'src', 'app.js')), JSON.parse(fs.readFileSync(expected, 'utf8')));
}
