#!/usr/bin/env node
/** Behavioral guard removals in private scratch builds. Production dist is
 * never mutated. Syntax errors and runtime loader errors are NOT kills. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-closure-mutants-'));
const mutants = [
 ['M1','A1',[['candidate',' || cid.dirty !== false','']]],
 ['M2','A6-head',[['candidate',"typeof after === 'string' || headToken(root) !== baseToken || subjectDigest(after.subject) !== subjectDigest(subject)",'false']]],
 ['M3','A3',[['authorization','candidateTree: subject.candidateTree,','']]],
 ['M4','B1',[['authorization','taskDigest: t.taskDigest,',"taskDigest: digest(''),"]]],
 ['M5','C1',[['authorization','for (const d of frozen.requirementDigests)','for (const d of [])']]],
 ['M6','B1',[['authorization','if (frozen.taskDigest !== live.taskDigest)','if (false)'],['candidate',"typeof context !== 'string' && acc.subjectDigest === subjectDigest(context.subject)",'true']]],
 ['M7','D1',[['onboarding','if (task?.subjectiveVisual)','if (false)']]],
 ['M8','E1-E3-E5',[['onboarding','const bound = script !== undefined && authority.plan.some','const bound = target.kind === "bench" || script !== undefined && authority.plan.some']]],
 ['M9','C7',[['authorization','if (requirements.length > MAX_REQUIREMENTS)','if (false)'],['authorization','const parts = [text, ...requirements];','requirements = requirements.slice(0, MAX_REQUIREMENTS); const parts = [text, ...requirements];']]],
 ['M10','C8',[['authorization','digest(canonicalText(s))','digest(canonicalText(s).slice(0, 4000))']]],
 ['M11','E1-E3-E5',[['candidate',"obligations.filter((x) => x.mode === 'non-objective' && x.status === 'unproven')","obligations.filter((x) => x.status === 'unproven')"]]],
 ['M12','B4',[['onboarding','[kindFlag, ...inferred]','[kindFlag]']]],
 ['M13','F1',[['candidate','if (!frozenKinds.length || !canonicalTask(frozenTask))','if (false)']]],
];
const run = (args, env = process.env) => spawnSync(process.execPath,args,{cwd:repo,env,encoding:'utf8',timeout:240000,windowsHide:true,maxBuffer:8*1024*1024});
let failures=0;
try {
 const baseline=run(['tooling/probes/architecture-closure.mjs']);
 assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);
 console.log('PASS baseline architecture matrix');
 fs.writeFileSync(path.join(temp,'package.json'),'{"type":"module"}');
 fs.symlinkSync(path.join(repo,'node_modules'),path.join(temp,'node_modules'),process.platform==='win32'?'junction':'dir');
 for(const [id,test,changes] of mutants) {
  const scratch=path.join(temp,id);fs.cpSync(path.join(repo,'apps/cli/dist/src'),scratch,{recursive:true});
  try {
   for(const [module,from,to] of changes) {
    const file=path.join(scratch,module+'.js'),source=fs.readFileSync(file,'utf8');
    assert.equal(source.split(from).length-1,1,`${id}: anchor ${from}`);
    fs.writeFileSync(file,source.replace(from,to));
    const syntax=run(['--check',file]);assert.equal(syntax.status,0,syntax.stderr);
   }
   const r=run(['tooling/probes/architecture-closure.mjs',test],{...process.env,CANARY_TEST_CLI:path.join(scratch,'main.js')});
   assert.equal(r.status,1,`SURVIVED ${id}: ${r.stdout}${r.stderr}`);
   assert.match(r.stdout,/AssertionError/,`non-behavioral failure: ${r.stdout}${r.stderr}`);
   assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError|ReferenceError|TypeError|ERR_MODULE_NOT_FOUND/);
   console.log(`PASS ${id} CAUGHT by ${test} (behavioral assertion)`);
  } catch(e) {failures++;console.log(`FAIL ${id}: ${e.stack}`);}
 }
} finally {fs.rmSync(temp,{recursive:true,force:true});}
console.log(`ARCHITECTURE MUTATIONS: ${13-failures}/13 CAUGHT; ${failures} FAIL`);
process.exitCode=failures?1:0;
