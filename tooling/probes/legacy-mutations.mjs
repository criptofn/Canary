#!/usr/bin/env node
/** Preserve the M7-M10 behavioral mutation batteries in independent scratch
 * repositories so they cannot alter the build being verified elsewhere. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
const repo=path.resolve(import.meta.dirname,'../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canary-legacy-mutations-'));
const selected=process.argv.slice(2).map(Number),ids=selected.length?selected:[7,8,9,10];
let failures=0;
async function run(id) {
 const root=path.join(temp,`m${id}`);
 fs.cpSync(repo,root,{recursive:true,filter:p=>!path.relative(repo,p).split(path.sep).some(s=>['.git','node_modules','.canary','pack','.claude'].includes(s))});
 fs.symlinkSync(path.join(repo,'node_modules'),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
 // Rebuild from source: another battery may temporarily mutate the source
 // repository's dist. A copied incremental build cache is not proof of bytes.
 const build=spawnSync(process.execPath,[path.join(repo,'node_modules/typescript/lib/tsc.js'),'-b','--force'],{cwd:root,encoding:'utf8',timeout:120000,windowsHide:true});
 if(build.status!==0){failures++;console.log(`FAIL M${id} scratch build: ${build.stdout}${build.stderr}`);return;}
 return new Promise(resolve=>{
  const child=spawn(process.execPath,[`tooling/probes/m${id}-mutation-battery.mjs`],{cwd:root,windowsHide:true});
  let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
  child.on('close',code=>{console.log(`\n=== M${id}: exit ${code} ===\n${out}`);if(code!==0)failures++;resolve();});
 });
}
try {for(let i=0;i<ids.length;i+=2)await Promise.all(ids.slice(i,i+2).map(run));}
finally {fs.rmSync(temp,{recursive:true,force:true});}
process.exitCode=failures?1:0;
