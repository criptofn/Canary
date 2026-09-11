// The declared check: `npm test` runs exactly this file.
import assert from 'node:assert/strict';
import { add } from './mini.js';

assert.equal(add(2, 3), 5);
console.log('node-mini: ok');
