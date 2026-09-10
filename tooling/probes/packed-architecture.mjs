#!/usr/bin/env node
/** The complete attack matrix against the installed, self-contained tarball.
 * Fixture construction/inspection uses source helpers; every product command,
 * including terminal-adapted acceptance, executes the packaged main.js. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolveNpmCli} from '@canary-rn/support';
const repo=path.resolve(import.meta.dirname,'../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canary-packed-architecture-'));
try {
 const tar=path.join(repo,'pack',fs.readdirSync(path.join(repo,'pack')).find(f=>f.endsWith('.tgz')));
 const npm=resolveNpmCli();assert.ok(npm,'npm CLI must resolve');
 const install=spawnSync(process.execPath,[npm,'install','--prefix',temp,'--ignore-scripts','--no-audit','--no-fund',tar],{cwd:temp,encoding:'utf8',timeout:120000,windowsHide:true});
 assert.equal(install.status,0,install.stdout+install.stderr);
 const cli=path.join(temp,'node_modules/@canary-rn/cli/dist/main.js');
 const r=spawnSync(process.execPath,['tooling/probes/architecture-closure.mjs'],{cwd:repo,env:{...process.env,CANARY_TEST_CLI:cli,CANARY_TEST_HELPERS:path.join(repo,'apps/cli/dist/src')},encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024,windowsHide:true});
 console.log(r.stdout+r.stderr);assert.equal(r.status,0);
 console.log('PACKED ARCHITECTURE: PASS (all product commands used installed release bytes)');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
