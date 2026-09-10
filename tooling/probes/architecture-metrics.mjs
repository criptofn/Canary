#!/usr/bin/env node
/** Compare baseline/final in fresh real Git fixtures. Instrument Node's spawn
 * APIs (includes probe subprocesses, not their grandchildren) and fs write APIs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const repo=path.resolve(import.meta.dirname,'../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'canary-metrics-'));
const builds=[['final',path.join(repo,'apps/cli/dist/src/main.js')],...(process.argv[2]?[['baseline',process.argv[2]]]:[])];
try { for(const [label,cli] of builds) {
 const root=path.join(temp,label);fs.mkdirSync(root);fs.mkdirSync(path.join(root,'.claude'));
 fs.writeFileSync(path.join(root,'.gitignore'),'.claude/\n');
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'metrics',private:true,scripts:{test:'node test.cjs'}}));
 fs.writeFileSync(path.join(root,'test.cjs'),"require('node:assert/strict').equal(1+1,2);\n");
 const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
 git(root,'init','-b','main');git(root,'config','user.name','Metrics');git(root,'config','user.email','metrics@local');git(root,'add','.');git(root,'commit','-m','fixture');
 let total=0;
 function run(args,expected=0){const r=spawnSync(process.execPath,[path.join(repo,'tooling/test-support/fixtures/metrics-driver.mjs'),cli,...args],{cwd:root,encoding:'utf8',timeout:120000});assert.equal(r.status,expected,r.stdout+r.stderr);const metrics=JSON.parse(r.stderr.match(/CANARY_METRIC (.*)/)[1]);total+=metrics.spawns;console.log(JSON.stringify({build:label,command:args.join(' '),...metrics,stdoutBytes:Buffer.byteLength(r.stdout)}));return metrics;}
 run(['setup','--yes']);const before=git(root,'status','--porcelain');const status=run(['status']);if(label==='final')assert.equal(status.writes,0);assert.equal(git(root,'status','--porcelain'),before);
 run(['task','refactor']);run(['isolate','c']);const c=path.join(root,'.canary/candidates/c');fs.writeFileSync(path.join(c,'new.txt'),'candidate');git(c,'add','.');git(c,'commit','-m','candidate');run(['isolate','--verify','c']);run(['isolate','--promote','c']);console.log(JSON.stringify({build:label,canonicalWorkflowSpawns:total}));
 run(['task','make my game prettier']);run(['isolate','pretty']);run(['isolate','--verify','pretty'],2);
 }}finally{fs.rmSync(temp,{recursive:true,force:true});}
