// Test fixture: setup --check must inventory the planned command without executing it.
const fs = require('node:fs');
const marker = process.argv[2];
if (typeof marker !== 'string' || marker.length === 0) process.exit(2);
fs.writeFileSync(marker, 'project command ran\n');
