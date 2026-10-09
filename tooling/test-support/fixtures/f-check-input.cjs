const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const greet = require(path.join(process.cwd(), 'greet.cjs'));

exports.missingFixture = () => {
  const rows = fs.readdirSync(process.cwd()).map(name => ({ name, label: greet('  Ada') }));
  const row = rows.find(item => item.name === 'receipt.txt');
  assert.equal(row.label, 'hello Ada');
};

exports.assertExpected = () => assert.equal(greet('  Ada'), 'hello Ada');

exports.missingFixtureWrapped = () => assert.doesNotThrow(exports.missingFixture);
