// Exercises installed CLI verbs and the production broker transport; no fake broker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-production-e2e-'));
const base = path.join(root, 'base'), store = path.join(root, 'store'), work = path.join(root, 'caller');
let broker, enrollment; let failed = 0;
const report = { tests: [], observations: null };
const check = (name, ok, detail) => { report.tests.push({ name, ok, detail }); console.log(`${ok?'PASS':'FAIL'} ${name}: ${detail}`); if(!ok) failed++; };
const command = (exe,args,cwd=root,timeout=180000) => {
  const r = spawnSync(exe,args,{cwd,encoding:'utf8',windowsHide:true,timeout});
  if(r.status!==0) throw new Error(`${exe} ${args.join(' ')}: ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const canary = args => command(process.execPath,[cli,...args]);
const git = args => command('C:\\Program Files\\Git\\cmd\\git.exe',args,base);
try {
  fs.mkdirSync(base); fs.mkdirSync(work);
  // A sealed ordinary Node assertion program; no unmeasured test-runner IPC dependency.
  fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({name:'production-authority-test',version:'1.0.0',scripts:{test:'node sum.test.cjs'}}));
  fs.writeFileSync(path.join(base,'index.cjs'),'module.exports = (a,b) => a+b;\n');
  fs.writeFileSync(path.join(base,'sum.test.cjs'),"const assert=require('node:assert/strict'); const sum=require('./index.cjs'); assert.equal(sum(1,2),3);\n");
  git(['init']); git(['config','user.name','Canary fixture']); git(['config','user.email','canary@localhost']);
  git(['add','.']); git(['commit','-m','base']);
  canary(['setup','--yes',base]);
  command(process.execPath,[cli,'task','Handle numeric string operands','--kind','bugfix'],base);
  git(['add','.']); git(['commit','--allow-empty','-m','operator setup artifacts']);
  enrollment = JSON.parse(canary(['provider','enroll',base,store]));
  const { challenge } = JSON.parse(canary(['provider','measurement-begin',store]));
  broker = spawn(process.execPath,[cli,'provider','serve-production',store],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let brokerLog=''; broker.stdout.on('data', x => brokerLog+=x); broker.stderr.on('data', x=>brokerLog+=x);
  // Native compilation happens before listening; use a read-only pipe exchange for readiness.
  const net = await import('node:net');
  let ready=false;
  for(let i=0;i<100&&!ready;i++) {
    ready=await new Promise(resolve=>{const s=net.connect('\\\\.\\pipe\\'+enrollment.pipe);s.on('connect',()=>s.write('{"verb":"hello"}\n'));s.on('data',()=>{s.destroy();resolve(true);});s.on('error',()=>resolve(false));});
    if(!ready) await new Promise(r=>setTimeout(r,100));
  }
  if(!ready) throw new Error(`production broker unavailable: ${brokerLog}`);
  const files = {
    'index.cjs': Buffer.from('module.exports = (a,b) => Number(a)+Number(b);\n').toString('base64'),
    'sum.test.cjs': Buffer.from("const assert=require('node:assert/strict'); const sum=require('./index.cjs'); assert.equal(sum(1,2),3); assert.equal(sum('1','2'),3);\n").toString('base64'),
  };
  const output=path.join(work,'output.json');
  const actions=[
    {id:'direct-apply',write:path.join(base,'index.cjs'),body:'not-reviewed'},
    {id:'enrollment-bypass',request:{verb:'enroll',base:work}},
    {id:'unreviewed',request:{verb:'promote',receipt:'forged',digest:'0'.repeat(64)}},
    {id:'review',request:{verb:'review',files}},
    {id:'post-review-mutation',write:path.join(os.tmpdir(),`canary-production-${enrollment.id}-fix`,'index.cjs'),body:'not-reviewed'},
    {id:'body-substitution',request:{verb:'promote',body:'other'},useReview:true},
    {id:'digest-substitution',request:{verb:'promote'},useReview:true,override:{digest:'0'.repeat(64)}},
    {id:'foreign-project',request:{verb:'promote'},useReview:true,override:{project:'foreign'}},
    {id:'foreign-candidate',request:{verb:'promote'},useReview:true,override:{candidate:'foreign'}},
    {id:'forged-receipt',request:{verb:'promote'},useReview:true,override:{receipt:'forged'}},
    {id:'promote',request:{verb:'promote'},useReview:true},
    {id:'replay',request:{verb:'promote'},useReview:true},
  ];
  const config=path.join(work,'request.json'), caller=path.join(work,'caller.cjs');
  fs.writeFileSync(config,JSON.stringify({...enrollment,challenge,candidate:'fix',output,actions}));
  fs.copyFileSync(path.join(repo,'tooling/test-support/fixtures/production-caller.cjs'),caller);
  try { canary(['provider','launch',store,work,process.execPath,'--preserve-symlinks-main',caller,config]); }
  catch(e) {
    report.observations=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{brokerLog};
    throw new Error(`${e.message}\n${JSON.stringify(report.observations)}`);
  }
  const results=JSON.parse(fs.readFileSync(output,'utf8')); report.observations=results;
  if(!Array.isArray(results)) throw new Error(JSON.stringify(results));
  const reviewed=results.find(x=>x.id==='review')?.response?.status===200;
  for(const r of results) {
    const ok=actions.find(x=>x.id===r.id)?.write ? !r.allowed && ['EPERM','EACCES'].includes(r.error) :
      ['review','promote'].includes(r.id) ? r.response?.status===200 : r.response?.status===403;
    const prerequisite=(!actions.find(x=>x.id===r.id)?.useReview && r.id!=='post-review-mutation') || reviewed;
    check(r.id,r.executed && ok && prerequisite,JSON.stringify(r.response??r));
  }
  if(!reviewed) console.log(fs.readFileSync(path.join(store,'controller.log'),'utf8'));
  check('promoted-byte-readback',fs.readFileSync(path.join(base,'index.cjs'),'utf8')===Buffer.from(files['index.cjs'],'base64').toString(),git(['rev-parse','HEAD']).trim());
  // Paired unrestricted writes to these exact files, restored immediately.
  for(const file of [path.join(base,'index.cjs'),path.join(os.tmpdir(),`canary-production-${enrollment.id}-fix`,'index.cjs')]) {
    const original=fs.readFileSync(file);
    try { fs.writeFileSync(file,'unrestricted-write-control'); check('write-control',fs.readFileSync(file,'utf8')==='unrestricted-write-control',file); }
    finally { fs.writeFileSync(file,original); }
  }
  if(failed===0) {
    canary(['provider','measure-production',store]);
    const {readProductionMeasurement,anchorPath,PRODUCTION_MEASUREMENT}=await import('../../apps/cli/dist/src/provider/production-measurement.js');
    const measured=readProductionMeasurement(store);
    check('production-linked-measurement',measured.valid,measured.reason);
    if(measured.valid) {
      const recordPath=path.join(store,PRODUCTION_MEASUREMENT), anchorFile=anchorPath(store);
      const record=JSON.parse(fs.readFileSync(recordPath,'utf8')), anchor=JSON.parse(fs.readFileSync(anchorFile,'utf8'));
      // Keep non-secret raw observations after disposable deployment cleanup.
      report.productionMeasurement=record;
      const key=fs.readFileSync(path.join(store,'producer.key'));
      const cases = [
        ['caller-created',r=>{},true],
        ['tampered',r=>{r.payload.host='tampered';},false,true],
        ['stale',r=>{r.payload.startedAt-=3600000;r.payload.finishedAt-=3600000;}],
        ['future',r=>{r.payload.startedAt+=3600000;r.payload.finishedAt+=3600000;}],
        ['foreign-store',r=>{r.payload.store=work;}],
        ['foreign-host',r=>{r.payload.host='foreign';}],
        ['foreign-toolchain',r=>{r.payload.tools='0'.repeat(64);}],
        ['missing-observation',r=>{delete r.payload.observations.pipeNegative;}],
        ['zero-attacks',r=>{r.payload.observations.native[0].restricted.attempts=[];}],
        ['failed-battery',r=>{r.payload.observations.native[0].restricted.attempts[0].allowed=true;}],
        ['inconclusive-battery',r=>{r.payload.observations.native[0].restricted.network.isolationError=0;}],
        ['mismatched-deployment',r=>{r.payload.deployment=crypto.randomUUID();}],
        ['replayed-generation',r=>{r.payload.nonce=crypto.randomUUID();}],
        ['foreign-native-target',r=>{r.payload.observations.native[0].restricted.attempts.find(x=>x.id==='authority-write-0').target=work;}],
      ];
      for(const [name,mutate,foreignKey,keepSignature] of cases) {
        const attack=structuredClone(record); mutate(attack);
        if(!keepSignature) attack.signature=crypto.sign(null,Buffer.from(JSON.stringify(attack.payload)),foreignKey?crypto.generateKeyPairSync('ed25519').privateKey:key).toString('base64');
        // Trusted fixture re-signs negative raw transcripts so validation, not just
        // a broken signature, must reject stale/foreign/incomplete evidence.
        fs.writeFileSync(recordPath,JSON.stringify(attack));
        fs.writeFileSync(anchorFile,JSON.stringify({...anchor,current:crypto.createHash('sha256').update(JSON.stringify(attack)).digest('hex')}));
        const result=readProductionMeasurement(store);
        check(`custody-${name}`,!result.valid,result.reason);
      }
      fs.writeFileSync(recordPath,JSON.stringify(record)); fs.writeFileSync(anchorFile,JSON.stringify(anchor));
      const copied=path.join(root,'copied-store');fs.mkdirSync(copied);fs.copyFileSync(recordPath,path.join(copied,PRODUCTION_MEASUREMENT));
      check('custody-copied-record',!readProductionMeasurement(copied).valid,'foreign store has no enrolled producer anchor');
      check('custody-restored-positive',readProductionMeasurement(store).valid,'original real deployment transcript still validates');
      const { providerStatus } = await import('../../apps/cli/dist/src/provider/service.js');
      const status=providerStatus({root:store});
      check('production-HARDENED-status',status.hardened,status.unavailable.join('; ')||status.pipe);
      const nativeCount=measured.payload.observations.native.reduce((n,a)=>n+a.restricted.attempts.length+1,0);
      console.log(`Production native attacks: ${nativeCount} executed, ${nativeCount} blocked; ${nativeCount} unrestricted controls`);
      const negatives=results.filter(r=>r.response?.status===403);
      const direct=results.filter(r=>r.allowed===false && ['EPERM','EACCES'].includes(r.error));
      const environment=measured.payload.observations.native.filter(n=>n.control.environment==='trusted-parent-only-test-value' && n.restricted.environment===null).length;
      report.attackCounts={native:nativeCount,protocol:negatives.length,directWrites:direct.length,pipe:1,environment,
        executed:nativeCount+negatives.length+direct.length+1+environment,
        blocked:nativeCount+negatives.length+direct.length+1+environment,
        positiveControls:nativeCount+direct.length+1+environment+results.filter(r=>r.response?.status===200).length,
        failures:failed,inconclusive:0};
      console.log('Production battery counts: '+JSON.stringify(report.attackCounts));
    }
  }
  const holdIndex=process.argv.indexOf('--hold-file');
  if(failed===0 && holdIndex>=0) {
    const holdFile=path.resolve(process.argv[holdIndex+1]??'');
    if(!holdFile.startsWith(path.resolve(os.tmpdir())+path.sep)) throw new Error('fixture handoff must be in OS temp');
    fs.writeFileSync(holdFile,JSON.stringify({store,base,enrollment,brokerPid:broker.pid}));
    await new Promise(resolve=>process.stdin.once('data',resolve));
  }
} catch(e) { check('infrastructure',false,e.stack); }
finally {
  if(broker && broker.exitCode===null) spawnSync('taskkill',['/PID',String(broker.pid),'/T','/F'],{windowsHide:true});
  // Keep no live profile or fixture repository after the test.
  if(enrollment) {
    const {removeMeasurementAuthority}=await import('../../apps/cli/dist/src/provider/production-measurement.js');
    removeMeasurementAuthority(store,enrollment.id);
    for(const name of [enrollment.profile,`${enrollment.profile}.Verifier`]) {
      const file=path.join(root,'cleanup.json');
      fs.writeFileSync(file,JSON.stringify({mode:'identity',name,delete:true,result:path.join(root,'deleted.json')}));
      spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(repo,'tools/windows-boundary/production-native.ps1'),'-Request',file],{windowsHide:true});
    }
    const candidate=path.join(os.tmpdir(),`canary-production-${enrollment.id}-fix`);
    if(fs.existsSync(candidate)) fs.rmSync(candidate,{recursive:true,force:true});
  }
  fs.writeFileSync(path.join(os.tmpdir(),'v12-production-authority.json'),JSON.stringify(report,null,2));
  fs.rmSync(root,{recursive:true,force:true});
  console.log(`production authority: ${report.tests.length-failed} pass, ${failed} fail`);
  process.exitCode=failed?1:0;
}
