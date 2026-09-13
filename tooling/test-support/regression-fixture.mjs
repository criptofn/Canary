import fs from 'node:fs';
import path from 'node:path';

// The fixture baseline already contains src/app.js exporting 1. This check
// travels onto that baseline during discrimination and must fail there.
export function addRegression(candidate) {
  fs.writeFileSync(path.join(candidate, 'src', 'app.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(candidate, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'tests', 'regression.expected.json'), '2\n');
  fs.writeFileSync(path.join(candidate, 'tests', 'regression.test.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('../src/app.js'), 2);\n");
}
