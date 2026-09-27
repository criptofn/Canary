#!/usr/bin/env node
/**
 * Hidden, task-specific correctness oracle. It reads the measured project but
 * writes every helper and report outside it. These checks are independent of
 * tests authored or edited by the worker.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const label = arg('label');
const repo = path.resolve(arg('repo') ?? '.');
const outDir = path.resolve(arg('out') ?? '.');
const expected = arg('expected', 'pass');
const runtimeRoot = path.resolve(arg('runtime-root', repo));
const javac = path.resolve(arg('javac', 'javac.exe'));
const java = path.resolve(arg('java', 'java.exe'));
const projectMarker = label === 'S1' ? 'build.gradle.kts' : 'package.json';
if (!['H1', 'H2', 'H3', 'H5', 'R1', 'S1'].includes(label) || !['pass', 'fail'].includes(expected)
  || !fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()
  || !fs.statSync(path.join(repo, projectMarker), { throwIfNoEntry: false })?.isFile()
  || fs.existsSync(outDir)) {
  console.error('usage: --label H1|H2|H3|H5|R1|S1 --repo <measured project> --out <new external directory> [--expected pass|fail] [--runtime-root <repo with test runtime>] [--javac <path>] [--java <path>]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
const gitOut = (...args) => { const r = git(...args); return r.status === 0 ? (r.stdout ?? '').trim() : null; };
const sourceFiles = {
  H1: ['src/workflows/fileOrganizer.js'],
  H2: ['src/workflows/fileOrganizer.js'],
  H3: ['src/agent/matrixNormCore.js'],
  H5: ['src/agent/matrixNormCore.js'],
  R1: ['src/verify/failure-ids.ts', 'src/verify/summarize-vitest.ts'],
  S1: ['src/main/java/net/schniedelsmp/smp/util/IdLookup.java'],
}[label];
const start = {
  schema: 'canary-validation-oracle/1', label, expected,
  probe: 'tooling/probes/v15-validation-oracle.mjs',
  probeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  repo, runtimeRoot, startingHead: gitOut('rev-parse', 'HEAD'),
  startedAt: new Date().toISOString(),
  sourceFiles: sourceFiles.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(repo, relativePath)),
    sha256: fs.existsSync(path.join(repo, relativePath)) ? sha256(fs.readFileSync(path.join(repo, relativePath))) : null,
  })),
};
fs.writeFileSync(path.join(outDir, 'oracle-input.json'), `${JSON.stringify(start, null, 2)}\n`, { flag: 'wx' });
let command = null;
let generated = [];
let outcome;
let compileExitCode = null;
let runtimeExitCode = null;

const runNodeOracle = (file) => {
  command = { executable: process.execPath, args: [file], cwd: repo };
  return spawnSync(process.execPath, [file], { cwd: repo, encoding: 'utf8', timeout: 120_000, windowsHide: true });
};

if (label === 'H1') {
  const sourceUrl = pathToFileURL(path.join(repo, sourceFiles[0])).href;
  const file = path.join(outDir, 'oracle.mjs');
  fs.writeFileSync(file, `import assert from 'node:assert/strict';\nimport fs from 'node:fs/promises';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { previewOrganization } from ${JSON.stringify(sourceUrl)};\nconst root=await fs.mkdtemp(path.join(os.tmpdir(),'canary-oracle-h1-'));\ntry { const now=Date.now(); await fs.writeFile(path.join(root,'fresh.txt'),'x'); await fs.writeFile(path.join(root,'old.txt'),'x'); await fs.utimes(path.join(root,'fresh.txt'),new Date(now),new Date(now+120000)); await fs.utimes(path.join(root,'old.txt'),new Date(now),new Date(now-5*86400000)); const files=async options=>(await previewOrganization({root,...options})).moves.map(x=>x.file).sort(); assert.deepEqual(await files({maxAgeDays:0}),['fresh.txt']); assert.deepEqual(await files({maxAgeDays:1}),['fresh.txt']); for(const options of [{},{maxAgeDays:undefined},{maxAgeDays:null},{maxAgeDays:'5'},{maxAgeDays:true},{maxAgeDays:false},{maxAgeDays:Number.NaN}]) assert.deepEqual(await files(options),['fresh.txt','old.txt']); } finally { await fs.rm(root,{recursive:true,force:true}); }\nconsole.log('PASS H1 independent maxAgeDays contract');\n`, { flag: 'wx' });
  generated.push('oracle.mjs'); outcome = runNodeOracle(file);
} else if (label === 'H2') {
  const sourceUrl = pathToFileURL(path.join(repo, sourceFiles[0])).href;
  const file = path.join(outDir, 'oracle.mjs');
  fs.writeFileSync(file, `import assert from 'node:assert/strict';\nimport fs from 'node:fs/promises';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { previewOrganization } from ${JSON.stringify(sourceUrl)};\nconst root=await fs.mkdtemp(path.join(os.tmpdir(),'canary-oracle-h2-'));\ntry { const names=['Rechnung.txt','invoice.md','Beleg.doc','tax-report.pptx','invoice.pdf','receipt.docx','receipt.xlsx','notes.txt','README.md','summary.docx','photo.png','app.js','data.csv','archive.zip','mystery.xyz']; for(const name of names) await fs.writeFile(path.join(root,name),'x'); const page=await previewOrganization({root}); const got=Object.fromEntries(page.moves.map(x=>[x.file,x.group])); assert.deepEqual(got,{'Rechnung.txt':'invoices','invoice.md':'invoices','Beleg.doc':'invoices','tax-report.pptx':'invoices','invoice.pdf':'invoices','receipt.docx':'invoices','receipt.xlsx':'invoices','notes.txt':'documents','README.md':'documents','summary.docx':'documents','photo.png':'images','app.js':'code','data.csv':'code','archive.zip':'archives','mystery.xyz':'other'}); } finally { await fs.rm(root,{recursive:true,force:true}); }\nconsole.log('PASS H2 independent invoice classification contract');\n`, { flag: 'wx' });
  generated.push('oracle.mjs'); outcome = runNodeOracle(file);
} else if (label === 'H3') {
  const sourcePath = path.join(repo, sourceFiles[0]);
  const original = fs.readFileSync(sourcePath, 'utf8');
  const marker = /(^|\n)(?:export )?function quantizeSymmetric\(a, bits\) \{/g;
  const matches = [...original.matchAll(marker)];
  if (matches.length !== 1) throw new Error(`H3 oracle expected one quantizeSymmetric declaration, found ${matches.length}`);
  const modulePath = path.join(outDir, 'matrixNormCore.mjs');
  fs.writeFileSync(modulePath, original.replace(marker, '$1export function quantizeSymmetric(a, bits) {'), { flag: 'wx' });
  const file = path.join(outDir, 'oracle.mjs');
  fs.writeFileSync(file, `import assert from 'node:assert/strict';\nimport { quantizeSymmetric, buildMatrixNormBriefing } from './matrixNormCore.mjs';\nfor(const bits of [0,1,1.5,17,NaN,Infinity,'4',null]) assert.throws(()=>quantizeSymmetric([[1,-1]],bits),TypeError); for(let bits=2;bits<=16;bits++){const q=quantizeSymmetric([[0,1,-1],[0.5,-0.5,0]],bits); assert.ok(q.flat().every(Number.isFinite));} assert.equal(buildMatrixNormBriefing('matrixnorm').simulation.length,8); console.log('PASS H3 independent bit-width range contract');\n`, { flag: 'wx' });
  generated.push('matrixNormCore.mjs', 'oracle.mjs'); outcome = runNodeOracle(file);
} else if (label === 'H5') {
  const sourceUrl = pathToFileURL(path.join(repo, sourceFiles[0])).href;
  const file = path.join(outDir, 'oracle.mjs');
  fs.writeFileSync(file, `import assert from 'node:assert/strict';\nimport { buildMatrixNormBriefing } from ${JSON.stringify(sourceUrl)};\nconst report=buildMatrixNormBriefing('matrixnorm'); const expected=['dense 16x16','wide 8x32','rank-1 dominant','two close singular directions','dense 32x32','very wide 4x64']; assert.deepEqual([...new Set(report.simulation.map(x=>x.caseName))],expected); assert.equal(report.simulation.length,12); assert.deepEqual(report.simulation.map(x=>x.bits),expected.flatMap(()=>[8,4])); for(const name of expected.slice(4)) for(const bits of [8,4]) assert.ok(report.markdown.includes('| '+name+' | INT'+bits+' |')); console.log('PASS H5 independent ordered-case and markdown contract');\n`, { flag: 'wx' });
  generated.push('oracle.mjs'); outcome = runNodeOracle(file);
} else if (label === 'R1') {
  const sourceUrl = pathToFileURL(path.join(repo, sourceFiles[0])).href;
  const testFile = path.join(outDir, 'failure-ids.oracle.test.ts');
  fs.writeFileSync(testFile, `import { expect, it } from 'vitest';\nimport { extractFailureIds } from ${JSON.stringify(sourceUrl)};\nit('distinguishes parametrized pytest ids across the delta and preserves repr stability',()=>{ const before=extractFailureIds('FAILED tests/test_x.py::test_p[a - b] - assert 1 == 2'); const after=extractFailureIds(['FAILED tests/test_x.py::test_p[a - b] - assert 1 == 3','FAILED tests/test_x.py::test_p[a - c] - assert 1 == 2'].join('\\n')); expect([...after].filter(id=>!before.has(id))).toEqual(['tests/test_x.py::test_p[a - c]']); expect([...extractFailureIds('FAILED tests/test_x.py::test_p[a - b] - assert 1 == 2')]).toEqual([...extractFailureIds('FAILED tests/test_x.py::test_p[a - b] - assert 1 == 3')]); });\n`, { flag: 'wx' });
  generated.push('failure-ids.oracle.test.ts');
  const vitest = path.join(runtimeRoot, 'node_modules/vitest/vitest.mjs');
  command = { executable: process.execPath, args: [vitest, 'run', '--root', outDir, '--reporter=verbose', testFile], cwd: runtimeRoot };
  outcome = spawnSync(process.execPath, command.args, { cwd: runtimeRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true });
} else if (label === 'S1') {
  const sourcePath = path.join(repo, sourceFiles[0]);
  const testFile = path.join(outDir, 'IdLookupOracle.java');
  const classDir = path.join(outDir, 'classes');
  fs.mkdirSync(classDir);
  fs.writeFileSync(testFile, `import java.util.LinkedHashMap;\nimport java.util.Map;\nimport net.schniedelsmp.smp.util.IdLookup;\npublic final class IdLookupOracle { public static void main(String[] args) { String same = new String("same"); Map<String,String> shared = new LinkedHashMap<>(); shared.put("abc-111",same); shared.put("abc-222",same); require(IdLookup.uniquePrefix(shared,"abc",2)==null,"two keys sharing one value reference are ambiguous"); Map<String,String> equal = new LinkedHashMap<>(); equal.put("abc-111",new String("same")); equal.put("abc-222",new String("same")); require(IdLookup.uniquePrefix(equal,"abc",2)==null,"two keys with equal values are ambiguous"); require("same".equals(IdLookup.uniquePrefix(shared,"abc-111",2)),"exact key keeps priority"); Map<String,String> one = Map.of("abc-111","only"); require("only".equals(IdLookup.uniquePrefix(one,"abc",2)),"one matching key returns its value"); System.out.println("PASS S1 independent key-count ambiguity contract"); } private static void require(boolean ok,String message){ if(!ok) throw new AssertionError(message); } }\n`, { flag: 'wx' });
  generated.push('IdLookupOracle.java');
  command = { executable: javac, args: ['-d', classDir, sourcePath, testFile], cwd: repo };
  const compile = spawnSync(javac, command.args, { cwd: repo, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  compileExitCode = compile.status ?? null;
  fs.writeFileSync(path.join(outDir, 'javac.stdout.txt'), compile.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(outDir, 'javac.stderr.txt'), compile.stderr ?? '', { flag: 'wx' });
  if (compile.status !== 0) outcome = compile;
  else {
    command = { executable: java, args: ['-cp', classDir, 'IdLookupOracle'], cwd: repo };
    outcome = spawnSync(java, command.args, { cwd: repo, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    runtimeExitCode = outcome.status ?? null;
  }
}

const stdout = outcome?.stdout ?? '';
const stderr = outcome?.stderr ?? '';
fs.writeFileSync(path.join(outDir, 'oracle.stdout.txt'), stdout, { flag: 'wx' });
fs.writeFileSync(path.join(outDir, 'oracle.stderr.txt'), stderr, { flag: 'wx' });
const testPassed = outcome?.status === 0 && !outcome?.error;
const expectedFailureObserved = expected === 'fail' && !outcome?.error && outcome?.status !== null && outcome?.status !== 0 && (
  label === 'S1'
    ? compileExitCode === 0 && /AssertionError:/.test(stderr)
    : label === 'R1'
      ? /Test Files\s+1 failed/.test(stdout) && /failure-ids\.oracle\.test\.ts/.test(stdout)
      : /AssertionError/.test(stderr)
);
const metExpected = expected === 'pass' ? testPassed : expectedFailureObserved;
const record = {
  ...start, finishedAt: new Date().toISOString(), expected,
  command, generatedArtifacts: generated,
  exitCode: outcome?.status ?? null, signal: outcome?.signal ?? null,
  timedOut: outcome?.error?.code === 'ETIMEDOUT', spawnError: outcome?.error?.message ?? null,
  compileExitCode, runtimeExitCode, testPassed, expectedFailureObserved, metExpected,
  status: metExpected ? 'complete' : 'unexpected',
  stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
};
fs.writeFileSync(path.join(outDir, 'oracle-result.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
const names = fs.readdirSync(outDir, { recursive: true }).filter((name) => typeof name === 'string' && fs.statSync(path.join(outDir, name)).isFile()).sort();
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${names.map((name) => `${sha256(fs.readFileSync(path.join(outDir, name)))}  ${name.replaceAll('\\', '/')}`).join('\n')}\n`, { flag: 'wx' });
console.log(`${metExpected ? 'PASS' : 'FAIL'} ${label} independent oracle expected ${expected}; observed ${testPassed ? 'pass' : 'fail'}`);
process.exit(metExpected ? 0 : 1);
