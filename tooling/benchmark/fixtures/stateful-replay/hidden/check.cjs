const path = require('node:path');
const assert = require('node:assert/strict');
let passed=0,total=0;
function check(fn) {total++;try{fn();passed++;}catch(e){console.log('FAIL '+e.message);}}
const {open}=require(path.join(process.argv[2],'src/api.js'));
// Independent reference model: nested maps, not the production key function or public check.
const keys=[['north','x'],['south','x'],['a:b','c'],['a','b:c'],['','x']];
const state=new Map();
const expected=(t,id)=>state.get(t)?.get(id);
let ledger=open();
function compare(){for(const [t,id] of keys)check(()=>assert.equal(ledger.get(t,id),expected(t,id)));}
for(let i=0;i<36;i++) {
  compare(); // warms positive and negative cached reads
  const [tenant,id]=keys[i%keys.length];
  const op=i%4===0?'delete':'put'; const value='value-'+i;
  const event={op,tenant,id,...(op==='put'?{value}:{})};
  if(!state.has(tenant))state.set(tenant,new Map());
  if(op==='delete')state.get(tenant).delete(id);else state.get(tenant).set(id,value);
  if(i%3===0)ledger.batch([event]);else if(op==='delete')ledger.remove(tenant,id);else ledger.put(tenant,id,value);
  compare();
  if(i%5===0){const history=ledger.exportJournal();ledger=open(history);compare();}
}
const history=ledger.exportJournal();
check(()=>{const copy=ledger.exportJournal();copy[0].tenant='changed';copy.push({});assert.deepEqual(ledger.exportJournal(),history);});
ledger=open(open(history).exportJournal()); compare();
console.log('hidden oracle: '+passed+'/'+total+' behaviour checks passed');
process.exitCode=passed===total?0:1;
