const assert = require('node:assert/strict');
const ledger = require('./src/api').open();
ledger.put('one', 'id', 'hello');
assert.equal(ledger.get('one', 'id'), 'hello');
console.log('1 passing');
