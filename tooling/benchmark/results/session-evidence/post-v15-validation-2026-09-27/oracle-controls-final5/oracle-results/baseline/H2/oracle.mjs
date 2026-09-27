import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewOrganization } from "file:///C:/Users/Johannes/AppData/Local/Temp/canary-v15-oracle-archives-20260927/baseline/H2/src/workflows/fileOrganizer.js";
const root=await fs.mkdtemp(path.join(os.tmpdir(),'canary-oracle-h2-'));
try { const names=['Rechnung.txt','invoice.md','Beleg.doc','tax-report.pptx','invoice.pdf','receipt.docx','receipt.xlsx','notes.txt','README.md','summary.docx','photo.png','app.js','data.csv','archive.zip','mystery.xyz']; for(const name of names) await fs.writeFile(path.join(root,name),'x'); const page=await previewOrganization({root}); const got=Object.fromEntries(page.moves.map(x=>[x.file,x.group])); assert.deepEqual(got,{'Rechnung.txt':'invoices','invoice.md':'invoices','Beleg.doc':'invoices','tax-report.pptx':'invoices','invoice.pdf':'invoices','receipt.docx':'invoices','receipt.xlsx':'invoices','notes.txt':'documents','README.md':'documents','summary.docx':'documents','photo.png':'images','app.js':'code','data.csv':'code','archive.zip':'archives','mystery.xyz':'other'}); } finally { await fs.rm(root,{recursive:true,force:true}); }
console.log('PASS H2 independent invoice classification contract');
