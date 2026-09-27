import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewOrganization } from "file:///C:/Users/Johannes/AppData/Local/Temp/canary-v15-pilot-positive-controls-20260927/projects/H1/src/workflows/fileOrganizer.js";
const root=await fs.mkdtemp(path.join(os.tmpdir(),'canary-oracle-h1-'));
try { const now=Date.now(); await fs.writeFile(path.join(root,'fresh.txt'),'x'); await fs.writeFile(path.join(root,'old.txt'),'x'); await fs.utimes(path.join(root,'fresh.txt'),new Date(now),new Date(now+120000)); await fs.utimes(path.join(root,'old.txt'),new Date(now),new Date(now-5*86400000)); const files=async options=>(await previewOrganization({root,...options})).moves.map(x=>x.file).sort(); assert.deepEqual(await files({maxAgeDays:0}),['fresh.txt']); assert.deepEqual(await files({maxAgeDays:1}),['fresh.txt']); for(const options of [{},{maxAgeDays:undefined},{maxAgeDays:null},{maxAgeDays:'5'},{maxAgeDays:true},{maxAgeDays:false},{maxAgeDays:Number.NaN}]) assert.deepEqual(await files(options),['fresh.txt','old.txt']); } finally { await fs.rm(root,{recursive:true,force:true}); }
console.log('PASS H1 independent maxAgeDays contract');
