#!/usr/bin/env node
/** Deterministic release-closure attack matrix. All Git mutations are confined
 * to mkdtemp fixtures. CANARY_TEST_CLI selects a scratch mutation build ONLY. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { addRegression } from '../test-support/regression-fixture.mjs';
const REPO = path.resolve(import.meta.dirname,'../..');
const CLI = process.env.CANARY_TEST_CLI ?? path.join(REPO,'apps/cli/dist/src/main.js');
const helpers = process.env.CANARY_TEST_HELPERS ?? path.dirname(CLI);
const A = await import(pathToFileURL(path.join(helpers,'authorization.js')));
const O = await import(pathToFileURL(path.join(helpers,'onboarding.js')));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(),'canary-closure-'));
const driver = path.join(REPO,'tooling/test-support/fixtures/accept-review-driver.mjs');
const selected = process.argv[2];
let failed=0, passed=0, serial=0, spawns=0;
function run(exe,args,cwd,extra={}) { spawns++; return spawnSync(exe,args,{cwd,encoding:'utf8',timeout:120000,windowsHide:true,...extra}); }
function git(root,...args) { const r=run('git',['-C',root,...args],root); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); }
function cli(root,...args) { return run(process.execPath,[CLI,...args],root); }
function ok(r) { assert.equal(r.status,0,r.stdout+r.stderr); return r; }
function blocked(r) { assert.equal(r.status,2,r.stdout+r.stderr); assert.ok(!/PROMOTED/.test(r.stdout)); return r; }
function write(root,p,s) { fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true}); fs.writeFileSync(path.join(root,p),s); }
function commit(root) {git(root,'add','-A');git(root,'commit','-m','fixture');}
function task(root,text='make the dialog prettier',reqs=[]) {return cli(root,'task',text,...reqs.flatMap(r=>['--requirement',r]));}
function make({e2e=false,bench=false,bindings={}}={}) {
 const root=path.join(TMP,`case-${++serial}`);fs.mkdirSync(root);fs.mkdirSync(path.join(root,'.claude'));
 write(root,'.gitignore','.claude/\n');
 write(root,'screen.html','<button style="color:#D94141;width:240px">start</button>\n');
 write(root,'src/app.js','module.exports = 1;\n');
 write(root,'tests/check.cjs',"const a=require('node:assert/strict'),f=require('node:fs');a.ok(f.readFileSync('screen.html','utf8').includes('<button'));\n");
 write(root,'bench.cjs',"const a=require('node:assert/strict'),p=require('node:perf_hooks').performance;const t=p.now();JSON.stringify(Array(100).fill(1));a.ok(p.now()-t<100);\n");
 write(root,'e2e.cjs',"const a=require('node:assert/strict'),f=require('node:fs'),s=f.readFileSync('screen.html','utf8');a.ok(s.includes('#D94141')&&s.includes('width:240px'));\n");
 write(root,'package.json',JSON.stringify({name:'closure-fixture',private:true,scripts:{test:`node tests/check.cjs && node "${path.join(REPO,'tooling','test-support','fixtures','f-regression.cjs')}"`,...(e2e?{e2e:'node e2e.cjs'}:{}),...(bench?{bench:'node bench.cjs'}:{})},canary:{proofs:bindings}}));
 git(root,'init','-b','main');git(root,'config','user.email','closure@canary.local');git(root,'config','user.name','Closure');commit(root);ok(cli(root,'setup','--yes'));return root;
}
// Every isolated candidate carries a REAL discriminating check (the sealed plan
// must FAIL on the sealed base). These cases are about the closure laws, not the
// discrimination gate itself — but a green suite that cannot tell candidate from
// base is NOT PROVEN by design, so the fixture has to supply genuine proof.
function isolate(root,text,reqs=[]) {ok(task(root,text,reqs));ok(cli(root,'isolate','c'));const c=path.join(root,'.canary/candidates/c');fs.appendFileSync(path.join(c,'screen.html'),'<!-- candidate -->\n');addRegression(c);commit(c);return c;}
function accept(root,action='none') {return run(process.execPath,[driver,CLI,action],root);}
const accPath=r=>path.join(r,'.canary/acceptance/c.json');
function verify(root) {return cli(root,'isolate','--verify','c');}
function promote(root) {return cli(root,'isolate','--promote','c');}
function notMoved(root,fn) {const h=git(root,'rev-parse','HEAD');fn();assert.equal(git(root,'rev-parse','HEAD'),h);}
function check(id,fn) {if(selected&&selected!==id)return;try{fn();passed++;console.log(`PASS ${id}`);}catch(e){failed++;console.log(`FAIL ${id}: ${e.stack}`);}}
try {
check('A1',()=>{const r=make(),c=isolate(r);fs.appendFileSync(path.join(c,'screen.html'),'dirty');blocked(accept(r));assert.ok(!fs.existsSync(accPath(r)));});
check('A2',()=>{const r=make(),c=isolate(r);ok(accept(r));fs.appendFileSync(path.join(c,'screen.html'),'new');commit(c);blocked(verify(r));notMoved(r,()=>blocked(promote(r)));});
check('A3',()=>{const r=make();isolate(r);ok(accept(r));const a=JSON.parse(fs.readFileSync(accPath(r),'utf8'));a.subject.candidateTree='f'.repeat(40);a.subjectDigest=A.subjectDigest(a.subject);fs.writeFileSync(accPath(r),JSON.stringify(a));blocked(verify(r));});
check('A4',()=>{const r=make(),c=isolate(r);fs.appendFileSync(path.join(c,'screen.html'),'staged');git(c,'add','screen.html');blocked(accept(r));assert.ok(!fs.existsSync(accPath(r)));});
check('A5',()=>{const r=make(),c=isolate(r);ok(accept(r));fs.appendFileSync(path.join(c,'screen.html'),'dirty');blocked(verify(r));notMoved(r,()=>blocked(promote(r)));});
for(const action of ['head','dirty','task']) check(`A6-${action}`,()=>{const r=make();isolate(r);blocked(accept(r,action));assert.ok(!fs.existsSync(accPath(r)));});
check('A7',()=>{const r=make(),c=isolate(r);const h=git(c,'rev-parse','HEAD');ok(accept(r));fs.appendFileSync(path.join(c,'screen.html'),'new');commit(c);blocked(verify(r));git(c,'reset','--hard',h);ok(verify(r));});
check('A8',()=>{const r=make(),c=isolate(r);ok(accept(r));ok(promote(r));assert.equal(git(r,'rev-parse','HEAD^{tree}'),git(c,'rev-parse','HEAD^{tree}'));ok(promote(r));});
check('B1',()=>{const r=make();isolate(r,'make the dialog warm red');ok(accept(r));ok(task(r,'make the dialog cool blue'));notMoved(r,()=>blocked(promote(r)));blocked(accept(r));});
check('B2-B3',()=>{const r=make();isolate(r,'make the dialog prettier');ok(accept(r));ok(task(r,'  make  the dialog\nprettier '));ok(verify(r));});
check('B4',()=>{const r=make();ok(cli(r,'task','fix the crash and make the dialog prettier','--kind','refactor'));const t=O.readTaskRecord(r);assert.ok(t.kinds.includes('ui')&&t.kinds.includes('bugfix')&&t.kinds.includes('refactor'));});
check('B5-B6',()=>{const r=make();isolate(r);const p=path.join(r,'.canary/task/current.json');const original=JSON.parse(fs.readFileSync(p,'utf8'));for(const t of [{...original,taskDigest:undefined},{...original,taskDigest:'bad'},{...original,schema:'canary-task/1'}]){fs.writeFileSync(p,JSON.stringify(t));blocked(verify(r));blocked(accept(r));}});
check('C1',()=>{const r=make();isolate(r,'style dialog',['A']);ok(task(r,'style dialog',['B']));blocked(accept(r));notMoved(r,()=>blocked(promote(r)));});
check('C2',()=>{const r=make();isolate(r,'style dialog',['A']);ok(accept(r));ok(task(r,'style dialog',['A','B']));blocked(verify(r));ok(accept(r));ok(promote(r));});
check('C3',()=>{const r=make();isolate(r,'style dialog',['A','B']);ok(task(r,'style dialog',['A']));blocked(accept(r));blocked(verify(r));});
check('C4',()=>{const r=make();isolate(r,'style dialog',['A','B']);ok(accept(r));ok(task(r,'style dialog',['B','A']));ok(verify(r));});
check('C5-C6',()=>{const f=A.declaredTask('ui',['ui'],['A','A']);assert.equal(f.requirementCount,2);assert.ok(A.taskWeakening(f,A.declaredTask('ui',['ui'],['A'])).length);assert.equal(A.canonicalTask({...f,requirementDigests:['bad','bad']}),null);});
check('C7',()=>{const r=make(),rs=Array.from({length:64},(_,i)=>`r${i}`);ok(task(r,'ui',rs));const p=path.join(r,'.canary/task/current.json'),before=fs.readFileSync(p,'utf8');blocked(task(r,'ui',[...rs,'65']));assert.equal(fs.readFileSync(p,'utf8'),before);assert.equal(O.readTaskRecord(r).requirementCount,64);});
check('C8',()=>{const p='x'.repeat(4000),a=A.declaredTask('ui',['ui'],[p+'A']),b=A.declaredTask('ui',['ui'],[p+'B']);assert.notDeepEqual(a.requirementDigests,b.requirementDigests);});
check('D1',()=>{const r=make({e2e:true});isolate(r,'make my game prettier');const v=blocked(verify(r));assert.match(v.stdout,/SUBJECTIVE ACCEPTANCE: USER JUDGMENT REQUIRED/);assert.match(v.stdout,/subjective-visual-acceptance/);ok(accept(r));ok(promote(r));});
check('D2-D7',()=>{const r=make();isolate(r);blocked(verify(r));ok(accept(r));ok(promote(r));});
check('D3',()=>{const t='button must be #D94141 and width 240px';const r=make({e2e:true,bindings:{[A.materialDigest(t)]:'e2e'}});isolate(r,t);ok(promote(r));assert.ok(!fs.existsSync(accPath(r)));});
check('D4',()=>{const r=make({e2e:true}),c=isolate(r,'fix the crash and make the dialog prettier');const v=blocked(verify(r));assert.match(v.stdout,/SUBJECTIVE ACCEPTANCE: USER JUDGMENT REQUIRED/);ok(accept(r));ok(verify(r));fs.appendFileSync(path.join(c,'tests/check.cjs'),'// regression fixture\n');commit(c);blocked(verify(r));ok(accept(r));ok(promote(r));});
check('D5-D6',()=>{const r=make({e2e:true}),c=isolate(r);ok(accept(r));fs.writeFileSync(path.join(c,'screen.html'),'broken');commit(c);ok(accept(r));notMoved(r,()=>blocked(promote(r)));});
check('E1-E3-E5',()=>{const r=make({bench:true});isolate(r,'render latency under 100ms');ok(accept(r));const v=blocked(verify(r));assert.match(v.stdout,/objective target/);notMoved(r,()=>blocked(promote(r)));});
check('E2',()=>{const t='render latency under 100ms',r=make({bench:true,bindings:{[A.materialDigest(t)]:'bench'}});isolate(r,t);ok(promote(r));assert.ok(!fs.existsSync(accPath(r)));});
check('E4',()=>{for(const bench of [false,true]){const r=make({bench});isolate(r,'make scrolling feel faster');const v=blocked(verify(r));assert.match(v.stdout,/subjective performance feel requires human judgment/);ok(accept(r));ok(promote(r));}});
check('F1',()=>{const r=make();ok(cli(r,'isolate','c'));ok(task(r,'refactor'));blocked(verify(r));notMoved(r,()=>blocked(promote(r)));});
check('F2',()=>{const r=make();isolate(r);const p=path.join(r,'.canary/candidates/c.json'),rec=JSON.parse(fs.readFileSync(p,'utf8'));delete rec.intent;fs.writeFileSync(p,JSON.stringify(rec));blocked(verify(r));blocked(promote(r));});
check('F3-F4',()=>{const r=make();isolate(r);write(r,'.canary/evidence/planted/verification.json',JSON.stringify({status:'pass',trustClass:'CANARY_OBSERVED'}));notMoved(r,()=>blocked(promote(r)));});
check('F6',()=>{const r=make();isolate(r);ok(accept(r));write(r,'unrelated','human base commit');commit(r);notMoved(r,()=>blocked(promote(r)));});
check('F8',()=>{const r=make(),c=isolate(r);ok(accept(r));const p=path.join(c,'package.json'),pkg=JSON.parse(fs.readFileSync(p));pkg.scripts.test='node missing.cjs';fs.writeFileSync(p,JSON.stringify(pkg));commit(c);blocked(promote(r));});
check('G1-G6',()=>{const r=make(),c=isolate(r,'fix the crash');fs.appendFileSync(path.join(c,'tests/check.cjs'),'// evidence\n');commit(c);const poison=path.join(TMP,'poison');fs.mkdirSync(poison);for(const n of ['npm','git'])write(poison,n,'#!/bin/sh\nexit 97\n');for(const n of ['npm','git'])fs.chmodSync(path.join(poison,n),0o755);const env={...process.env,PATH:poison+path.delimiter+process.env.PATH,NODE_OPTIONS:'--require=missing-preload',NODE_PATH:poison,npm_config_script_shell:path.join(poison,'npm'),GIT_DIR:poison};delete env.NODE_OPTIONS; // Node itself has already started in the product-boundary test below.
 const script=path.join(REPO,'tooling/test-support/fixtures/environment-driver.mjs');ok(run(process.execPath,[script,CLI,r,poison],r,{env}));});
check('H1-H9',()=>{const r=make();const before=git(r,'status','--porcelain');const cfg=fs.readFileSync(path.join(r,'.canary/canary.local.json'),'utf8');write(r,'.canary/last-checkpoint.json',JSON.stringify({status:'pass',source:'past',at:'yesterday'}));const status=ok(cli(r,'status'));assert.match(status.stdout,/NOT a claim about now/);assert.match(cli(r).stdout,/CONNECTED/);assert.equal(git(r,'status','--porcelain'),before);assert.equal(fs.readFileSync(path.join(r,'.canary/canary.local.json'),'utf8'),cfg);console.log(`METRIC status_stdout_bytes=${Buffer.byteLength(status.stdout)} probe_spawns=${spawns}`);});
check('H3-H4-H5',()=>{const r=make(),p=path.join(r,'.canary/canary.local.json'),old=fs.readFileSync(p,'utf8');fs.writeFileSync(p,'bad');assert.match(blocked(cli(r,'status')).stdout,/NOT CONNECTED/);assert.match(cli(r).stdout,/NOT CONNECTED/);const c=JSON.parse(old);c.cliPath='foreign';fs.writeFileSync(p,JSON.stringify(c));assert.match(blocked(cli(r,'status')).stdout,/NOT CONNECTED/);assert.match(cli(r).stdout,/NOT CONNECTED/);fs.writeFileSync(p,old);fs.rmSync(path.join(r,'.claude/settings.json'));assert.match(blocked(cli(r,'status')).stdout,/NEEDS ATTENTION/);});
check('H6-H7-H8',()=>{const r=make(),c=isolate(r,'refactor');assert.match(blocked(cli(c,'status')).stdout,/NOT CONNECTED/);assert.match(cli(c).stdout,/NOT CONNECTED/);const nested=path.join(r,'nested');fs.mkdirSync(nested);git(nested,'init','-b','main');assert.match(blocked(cli(nested,'status')).stdout,/NOT CONNECTED/);assert.match(cli(nested).stdout,/NOT CONNECTED/);fs.rmSync(path.join(r,'package.json'));assert.match(blocked(cli(r,'status')).stdout,/NEEDS ATTENTION|NOT CONNECTED/);});
check('I1-storage',()=>{const r=make();isolate(r,'refactor');const p=path.join(r,'.canary/evidence');fs.rmSync(p,{recursive:true,force:true});fs.writeFileSync(p,'unavailable');const v=ok(verify(r));assert.match(v.stdout,/Evidence storage unavailable/);assert.ok(fs.statSync(p).isFile());});
} finally {fs.rmSync(TMP,{recursive:true,force:true});}
console.log(`ARCHITECTURE CLOSURE: PASS=${passed} FAIL=${failed} SKIP=0`);
process.exitCode=failed?1:0;
