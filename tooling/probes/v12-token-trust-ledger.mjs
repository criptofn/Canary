// Read-only reconstruction. Original records and streams are never rewritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const repo=path.resolve(import.meta.dirname,'../..');
const dir=path.join(repo,'tooling/benchmark/results');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sum=(xs,key)=>xs.reduce((n,x)=>n+(x[key]??0),0);
const usage=u=>({input:u.input_tokens??0,output:u.output_tokens??0,cacheRead:u.cache_read_input_tokens??0,cacheCreation:u.cache_creation_input_tokens??0});
const rows=[], traces=[];
const originals=Object.fromEntries(fs.readdirSync(dir).filter(f=>f.startsWith('v12tok-')).map(f=>[f,sha(fs.readFileSync(path.join(dir,f)))]));
for(const file of Object.keys(originals).filter(f=>/^v12tok-(main|guarded)-.+-(plain|workflow|guarded)-1\.json$/.test(f))) {
  const record=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  const streamFile=path.join(record.runRoot,'agent.stream.jsonl');
  if(!fs.existsSync(streamFile)) {
    const u=record.agentResult.usage;
    rows.push({file,task:record.task,arm:record.arm,input:u.inputTokens,output:u.outputTokens,cacheRead:u.cacheReadTokens,
      cacheCreation:u.cacheCreationTokens,total:u.totalTokens,turns:record.agentResult.numTurns,uniqueMessages:record.stream.messages,
      model:record.agent.model,cliVersion:null,rawAvailable:false,visibleBytes:record.stream.bytes.toolResultTotal,
      partialUsage:!record.stream.streamedUsageUsable,hidden:record.hidden,visible:record.visible,configMismatch:record.configMismatch,
      claimsDone:record.claimsDone,falseDone:record.falseDone,canaryVerdict:record.canary?.verdict});
    continue;
  }
  const raw=fs.readFileSync(streamFile,'utf8');
  const events=raw.split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
  const result=events.filter(e=>e.type==='result').at(-1);
  if(!result) throw new Error(`missing raw result: ${file}`);
  const u=usage(result.usage), total=Object.values(u).reduce((a,b)=>a+b,0);
  if(total!==record.agentResult.usage.totalTokens || result.num_turns!==record.agentResult.numTurns) throw new Error(`raw/record disagreement: ${file}`);
  const init=events.find(e=>e.type==='system'&&e.subtype==='init');
  const messages=new Map(), tools=new Map(), outputs=[];
  const texts=[];
  for(const [index,event] of events.entries()) {
    if(event.type==='assistant') {
      const m=event.message, blocks=m.content??[];
      if(!messages.has(m.id)) messages.set(m.id,{id:m.id,usage:m.usage,tools:[],text:[],firstEvent:index});
      const turn=messages.get(m.id);
      for(const b of blocks) {
        if(b.type==='tool_use'&&!tools.has(b.id)) {
          const input=b.input??{};
          const call={id:b.id,turn:messages.size-1,name:b.name,input,event:index};
          tools.set(b.id,call); turn.tools.push(call);
        }
        if(b.type==='text') turn.text.push(b.text);
      }
    }
    if(event.type==='user') for(const block of event.message?.content??[]) {
      if(block.type==='tool_result') {
        const text=typeof block.content==='string'?block.content:(block.content??[]).map(b=>b.text??'').join('');
        outputs.push({id:block.tool_use_id,text,bytes:text.length,event:index});
      } else if(block.type==='text') texts.push(block.text);
    }
  }
  const actions=[...tools.values()].map(t=>({...t,output:outputs.find(o=>o.id===t.id)?.text??''}));
  const selfBinding=actions.filter(t=>/proofs|\bbind\b/.test(JSON.stringify(t.input)));
  const unbound=outputs.filter(o=>o.text.includes('REQUIREMENT UNBOUND'));
  const modelNames=Object.keys(result.modelUsage??{});
  const row={file,task:record.task,arm:record.arm,...u,total,turns:result.num_turns,uniqueMessages:messages.size,
    model:init?.model??modelNames,cliVersion:init?.claude_code_version??init?.version??null,
    rawAvailable:true,rawHash:sha(raw),visibleBytes:sum(outputs,'bytes'),recordVisibleBytes:record.stream.bytes.toolResultTotal,
    candidateCorrect:record.hidden?.oracleError === false && record.hidden?.exitCode === 0 && record.hidden?.passing === record.hidden?.total,
    hidden:record.hidden,visible:record.visible,claimsDone:record.claimsDone,falseDone:record.falseDone,
    canaryVerdict:record.canary?.verdict,promoted:record.canary?.baseMoved === true && record.canary?.acceptedPromotionBundles?.length > 0,
    configMismatch:record.configMismatch,unboundResponses:unbound.length,bindingActions:selfBinding.length,
    partialUsage:[...messages.values()].some(m=>!m.usage?.output_tokens),
    initKeys:Object.keys(init??{}),resultKeys:Object.keys(result)};
  rows.push(row);
  traces.push({file,arm:record.arm,task:record.task,messages:[...messages.values()],actions,unbound,texts});
}
const totals={};
for(const arm of ['plain','workflow','guarded']) {
  const armRows=rows.filter(r=>r.arm===arm);
  totals[arm]=Object.fromEntries(['total','turns','input','output','cacheRead','cacheCreation','visibleBytes','uniqueMessages'].map(k=>[k,sum(armRows,k)]));
}
const delta=totals.workflow.total-totals.plain.total;
const stratumA=['bound-requirements','bug-sum','stateful-replay'];
const strata=Object.fromEntries(['plain','workflow','guarded'].map(arm=>[arm,sum(rows.filter(r=>r.arm===arm&&stratumA.includes(r.task)),'total')]));
const originalStrata=Object.fromEntries(['A-executable','B-unbound'].map(stratum=>[stratum,
  Object.fromEntries(['plain','workflow'].map(arm=>{
    const selected=rows.filter(r=>r.arm===arm&&(stratumA.includes(r.task)===(stratum==='A-executable')));
    return [arm,{tokens:sum(selected,'total'),turns:sum(selected,'turns'),
      oracleCorrect:selected.filter(r=>r.candidateCorrect).length,tasks:selected.map(r=>r.task)}];
  }))]));
const category=m=>{
  const calls=m.tools.map(t=>JSON.stringify(t.input)).join('\n');
  if(!m.tools.length) return 'narration';
  if(/proofs|\bbind\b/.test(calls)) return 'binding';
  if(/apps[\\/]+cli[\\/]+src|onboarding\.(ts|js)|candidate\.(ts|js)/.test(calls)) return 'canary-source-investigation';
  if(/\bsetup\b/.test(calls)&&/main\.js|canary/.test(calls)) return 'setup-reseal';
  if(/\bwork\s/.test(calls)&&/main\.js|canary/.test(calls)) return 'candidate-creation-or-refusal';
  if(/\bfinish\b|--promote/.test(calls)&&/main\.js|canary/.test(calls)) return 'finish-or-retry';
  if(/\b(doctor|checkpoint|result|status)\b/.test(calls)&&/main\.js/.test(calls)) return 'status-verification';
  if(/\b(stash|restore|reset|checkout|clean)\b/.test(calls)&&/git/.test(calls)) return 'git-recovery';
  if(/npm (?:run )?test|node .*run-tests|--verify|checks[\\/]/.test(calls)) return 'tests-verification';
  if(/git\s+(?:[^\n]*? )?commit\b/.test(calls)) return 'commit';
  if(m.tools.some(t=>['Write','Edit','MultiEdit'].includes(t.name))||/writeFile|Set-Content|Add-Content/.test(calls)) return 'implementation';
  return 'inspection-other';
};
const categories={};
for(const trace of traces) for(const message of trace.messages) {
  message.category=category(message);
  const bucket=categories[message.category]??={plain:0,workflow:0,tokenCost:null};
  bucket[trace.arm]++;
}
for(const bucket of Object.values(categories)) bucket.delta=bucket.workflow-bucket.plain;
categories['CLI-turns-without-unique-message']={plain:totals.plain.turns-totals.plain.uniqueMessages,
  workflow:totals.workflow.turns-totals.workflow.uniqueMessages,
  delta:(totals.workflow.turns-totals.workflow.uniqueMessages)-(totals.plain.turns-totals.plain.uniqueMessages),tokenCost:null};
if(sum(Object.values(categories),'delta')!==totals.workflow.turns-totals.plain.turns) throw new Error('turn delta reconciliation failed');
const report={originals,totals,originalStrata,delta,deltaPercent:100*delta/totals.plain.total,cacheShare:100*(totals.workflow.cacheRead-totals.plain.cacheRead)/delta,
  guardedDeltaPercent:100*(totals.guarded.total/totals.plain.total-1),stratumA:strata,guardedStratumADeltaPercent:100*(strata.guarded/strata.plain-1),categories,
  accountingLimit:'Categories assign unique assistant message IDs by explicit command precedence, not causal counterfactual turns. The remaining CLI count is unattributable; all per-category billed token costs are unavailable, not zero.',rows,traces};
const out=path.join(os.tmpdir(),'canary-v12-token-trust-ledger.json');
fs.writeFileSync(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,originals:undefined,traces:undefined,rows:rows.map(({file,task,arm,total,turns,uniqueMessages,model,cliVersion,visibleBytes,unboundResponses,bindingActions,partialUsage})=>({file,task,arm,total,turns,uniqueMessages,model,cliVersion,visibleBytes,unboundResponses,bindingActions,partialUsage}))},null,2));
console.log(`PASS raw result/record reconciliation for ${rows.filter(r=>r.rawAvailable).length} trials; ${rows.filter(r=>!r.rawAvailable).length} have stored records ONLY. Ledger: ${out}`);
