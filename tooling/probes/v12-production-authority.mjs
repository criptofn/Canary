// Exercises installed CLI verbs and the production broker transport; no fake broker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cliIndex = process.argv.indexOf('--cli');
const cli = cliIndex < 0 ? path.join(repo, 'apps/cli/dist/src/main.js') : path.resolve(process.argv[cliIndex + 1]);
const installedStatus = store => {
  const r = spawnSync(process.execPath, [cli, 'provider', 'status', '--json'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, CANARY_TRUST_STORE: store },
  });
  let envelope;
  try { envelope = JSON.parse(r.stdout); } catch { return { valid: false, reason: `invalid status envelope: ${r.stderr}` }; }
  return { valid: r.status === 0 && envelope.security?.level === 'HARDENED', reason: JSON.stringify(envelope.problems),
    payload: fs.existsSync(path.join(store, 'production-measurement.json')) ? JSON.parse(fs.readFileSync(path.join(store, 'production-measurement.json'))).payload : undefined };
};
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
/** v1.4: the --capability verdict, carried out of the try block so the cleanup
 *  in `finally` cannot overwrite it with the battery's pass/fail code. */
class CapabilityVerdict extends Error { constructor(code, message) { super(message); this.code = code; } }
let capabilityVerdict = null;
try {
  fs.mkdirSync(base); fs.mkdirSync(work);
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  // A sealed ordinary Node assertion program; no unmeasured test-runner IPC dependency.
  fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({name:'production-authority-test',version:'1.0.0',scripts:{test:'node sum.test.cjs'}}));
  fs.writeFileSync(path.join(base,'index.cjs'),'module.exports = (a,b) => a+b;\n');
  fs.writeFileSync(path.join(base,'sum.test.cjs'),"const assert=require('node:assert/strict'); const sum=require('./index.cjs'); assert.equal(sum(1,2),3);\n");
  git(['init']); git(['config','user.name','Canary fixture']); git(['config','user.email','canary@localhost']);
  git(['add','.']); git(['commit','-m','base']);
  canary(['setup','--yes',base]);
  git(['add','.']); git(['commit','--allow-empty','-m','operator setup artifacts']);
  command(process.execPath,[cli,'bind','test','--requirement','Handle numeric string operands','--reseal'],base);
  command(process.execPath,[cli,'task','Handle numeric string operands','--kind','bugfix','--requirement','Handle numeric string operands'],base);
  const operatorPackage = JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'));
  const operatorProofs = operatorPackage.canary.proofs;
  const sealed = JSON.parse(fs.readFileSync(path.join(base,'.canary','canary.local.json'),'utf8'));
  check('trusted-binding-seal-control',Object.keys(operatorProofs).length===1 &&
    JSON.stringify(sealed.planAuthority.proofBindings)===JSON.stringify(operatorProofs),
    'operator bind --reseal creates the legitimate frozen binding before enrollment');
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
  const intendedFiles = {
    'index.cjs': Buffer.from('module.exports = (a,b) => Number(a)+Number(b);\n').toString('base64'),
    'sum.test.cjs': Buffer.from("const assert=require('node:assert/strict'); const sum=require('./index.cjs'); assert.equal(sum(1,2),3); assert.equal(sum('1','2'),3);\n").toString('base64'),
  };
  // Trusted preflight creates an independent implementation repository. No
  // linked worktree, borrowed object store, or authority metadata is exposed.
  command('C:\\Program Files\\Git\\cmd\\git.exe',['init'],work);
  for (const file of ['package.json','index.cjs','sum.test.cjs'])
    fs.copyFileSync(path.join(base,file),path.join(work,file));
  command('C:\\Program Files\\Git\\cmd\\git.exe',['add','.'],work);
  command('C:\\Program Files\\Git\\cmd\\git.exe',['-c','user.name=Worker baseline','-c','user.email=baseline@localhost','commit','-m','trusted starting bytes'],work);
  const {productionTool}=await import('../../apps/cli/dist/src/provider/production.js');
  for (const [file,body] of Object.entries(intendedFiles)) {
    const edit=productionTool(store,work,{op:'write',path:file,text:Buffer.from(body,'base64').toString()});
    check('confined-implementation-'+file,edit.output?.result==='written' && edit.observation[0].package===enrollment.package,'real production tool execution');
  }
  for (const args of [['rev-parse','--show-toplevel'],['status','--porcelain'],['diff'],['diff','--cached'],['add','--','index.cjs','sum.test.cjs']]) {
    const result=productionTool(store,work,{op:'exec',argv:['C:\\Program Files\\Git\\cmd\\git.exe',...args]});
    check('confined-git-'+args.join('-'),result.output?.result?.status===0,JSON.stringify(result.output));
  }
  // v1.4 — CAPABILITY MODE: answer ONE host question and stop.
  //
  // `confined-activation.test.ts` needs a host that can EXECUTE a program inside
  // the native confinement. Whether a host can is not a guess: it is what these
  // five probes just measured. MEASURED on the GitHub-hosted Windows image (run
  // 35695885086): the write probes above PASS while every exec probe reports
  // `spawnSync C:\Program Files\Git\cmd\git.exe EPERM` — so the signal is the
  // EXEC probes specifically, never "some confined probe worked".
  //
  // Exit 0 = this host can. Exit 3 = measured refusal to execute (the raw OS
  // error is printed and travels into the suite's SKIP reason). Exit 1 = the
  // probes failed for some OTHER reason, which is a real failure and must not be
  // laundered into a skip: the suite then runs and fails loudly.
  if (process.argv.includes('--capability')) {
    const execs = report.tests.filter(t => t.name.startsWith('confined-git-'));
    const ran = execs.filter(t => t.ok).length;
    const refusals = execs.map(t => String(t.detail ?? '')).filter(d => /EPERM|EACCES/.test(d));
    const oneLine = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (ran === execs.length && ran > 0) {
      throw new CapabilityVerdict(0, `CAPABILITY: this host CAN execute inside the native confinement (${ran}/${execs.length} confined exec probes ran)`);
    }
    if (ran === 0 && refusals.length > 0) {
      throw new CapabilityVerdict(3, `CAPABILITY: this host CANNOT execute inside the native confinement (${refusals.length}/${execs.length} probes refused: ${oneLine(refusals[0])})`);
    }
    throw new CapabilityVerdict(1, `CAPABILITY: inconclusive — ${ran}/${execs.length} confined exec probes ran and ${refusals.length} carried an OS refusal; not a host-capability verdict`);
  }
  // Broker receives the actual implementation bytes, not the test's desired
  // output. Existing review, promotion and independent readback assertions follow.
  const files=Object.fromEntries(Object.keys(intendedFiles).map(file=>[file,fs.readFileSync(path.join(work,file)).toString('base64')]));
  const output=path.join(work,'output.json');
  const forgedClient={identity:enrollment.owner,appContainer:false};
  const forgedRequest={verb:'heartbeat',project:enrollment.project,deployment:enrollment.id,nonce:'a'.repeat(64)};
  const injected='{"verb":"hello"},"client":'+JSON.stringify(forgedClient)+',"request":'+JSON.stringify(forgedRequest);
  const unsafe=JSON.parse('{"client":{"appContainer":true},"request":'+injected+'}');
  const {productionAuthority}=await import('../../apps/cli/dist/src/provider/production.js');
  const unsafeResult=await productionAuthority(store,unsafe);
  check('framing-positive-control',unsafe.client.appContainer===false && unsafeResult.status===200 &&
    crypto.verify(null,Buffer.from(JSON.stringify(unsafeResult.payload)),fs.readFileSync(path.join(store,'producer.pub')),Buffer.from(unsafeResult.signature,'base64')),
    'unrestricted old-framing control actually obtains a signed owner heartbeat');
  const actions=[
    {id:'framing-injection',raw:injected},
    {id:'direct-apply',write:path.join(base,'index.cjs'),body:'not-reviewed'},
    {id:'enrollment-bypass',request:{verb:'enroll',base:work}},
    // A separate challenge keeps these focused binding attacks separate from
    // the existing fixed measurement transcript; none is activation evidence.
    {id:'binding-create',request:{verb:'review',challenge:'binding-audit',files:{'package.json':Buffer.from(JSON.stringify({...operatorPackage,
      canary:{proofs:{...operatorProofs,['b'.repeat(64)]:'test'}}})).toString('base64')}}},
    {id:'binding-modify',request:{verb:'review',challenge:'binding-audit',files:{'package.json':Buffer.from(JSON.stringify({...operatorPackage,
      canary:{proofs:Object.fromEntries(Object.keys(operatorProofs).map(d=>[d,'other']))}})).toString('base64')}}},
    {id:'binding-setup-seal',request:{verb:'setup',challenge:'binding-audit'}},
    {id:'binding-source-write',write:path.join(base,'package.json'),body:'worker-owned binding source'},
    {id:'binding-source-substitution',request:{verb:'review',challenge:'binding-audit',files:{'canary.project.json':Buffer.from(JSON.stringify({proofs:operatorProofs})).toString('base64')}}},
    {id:'binding-alternate-api',request:{verb:'bind',challenge:'binding-audit',proofs:operatorProofs}},
    {id:'binding-repository-alias',request:{verb:'review',challenge:'binding-audit',files:{'PACKAGE.JSON':Buffer.from(JSON.stringify({scripts:operatorPackage.scripts})).toString('base64')}}},
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
  for(const file of [path.join(base,'index.cjs'),path.join(base,'package.json'),path.join(os.tmpdir(),`canary-production-${enrollment.id}-fix`,'index.cjs')]) {
    const original=fs.readFileSync(file);
    try { fs.writeFileSync(file,'unrestricted-write-control'); check('write-control',fs.readFileSync(file,'utf8')==='unrestricted-write-control',file); }
    finally { fs.writeFileSync(file,original); }
  }
  if(failed===0) {
    canary(['provider','measure-production',store]);
    const measurement=await import('../../apps/cli/dist/src/provider/production-measurement.js');
    const {anchorPath,PRODUCTION_MEASUREMENT}=measurement;
    const readProductionMeasurement=cliIndex < 0 ? measurement.readProductionMeasurement : installedStatus;
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
        ['missing-framing-observation',r=>{delete r.payload.observations.framing;}],
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
      const status=cliIndex < 0 ? providerStatus({root:store}) : {hardened:installedStatus(store).valid,unavailable:[],pipe:enrollment.pipe};
      check('production-HARDENED-status',status.hardened,status.unavailable.join('; ')||status.pipe);
      if (cliIndex >= 0) {
        const helper=path.resolve(path.dirname(cli),'../tools/windows-boundary/production-child.cjs');
        const original=fs.readFileSync(helper);
        try {
          fs.appendFileSync(helper,'\n// toolchain substitution attack\n');
          check('installed-toolchain-substitution',!installedStatus(store).valid,'modified shipped native tool invalidates measurement');
        } finally { fs.writeFileSync(helper,original); }
        check('installed-toolchain-restored',installedStatus(store).valid,'exact measured bytes restored');
      }
      const nativeCount=measured.payload.observations.native.reduce((n,a)=>n+a.restricted.attempts.length+1,0);
      console.log(`Production native attacks: ${nativeCount} executed, ${nativeCount} blocked; ${nativeCount} unrestricted controls`);
      const negatives=results.filter(r=>r.response?.status===403);
      const direct=results.filter(r=>r.allowed===false && ['EPERM','EACCES'].includes(r.error));
      const environment=measured.payload.observations.native.filter(n=>n.control.environment==='trusted-parent-only-test-value' && n.restricted.environment===null).length;
      report.attackCounts={native:nativeCount,protocol:negatives.length,directWrites:direct.length,pipe:1,environment,
        executed:nativeCount+negatives.length+direct.length+1+environment,
        blocked:nativeCount+negatives.length+direct.length+1+environment,
        positiveControls:nativeCount+direct.length+1+environment+results.filter(r=>r.response?.status===200).length+1,
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
} catch(e) {
  if (e instanceof CapabilityVerdict) { capabilityVerdict = e; console.log(e.message); }
  else check('infrastructure',false,e.stack);
}
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
  process.exitCode=capabilityVerdict ? capabilityVerdict.code : (failed?1:0);
}
