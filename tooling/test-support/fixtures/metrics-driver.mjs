import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const cli=process.argv[2];
let spawns=0,writes=0;
for(const name of ['spawn','spawnSync','execFile','execFileSync']) {
 const original=cp[name];cp[name]=function(...args){spawns++;return original.apply(this,args);};
}
for(const name of ['writeFileSync','appendFileSync','mkdirSync','rmSync','renameSync','unlinkSync']) {
 const original=fs[name];fs[name]=function(...args){writes++;return original.apply(this,args);};
}
syncBuiltinESMExports();
process.on('exit',()=>process.stderr.write(`\nCANARY_METRIC ${JSON.stringify({spawns,writes})}\n`));
process.argv=[process.execPath,cli,...process.argv.slice(3)];
await import(pathToFileURL(cli));
