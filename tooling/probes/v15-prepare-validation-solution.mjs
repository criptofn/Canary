#!/usr/bin/env node
/** Apply one already-recorded, reviewed task solution to its independent snapshot. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};
const label = arg('label');
const repo = path.resolve(arg('repo') ?? '.');
const baselineHead = arg('baseline-head');
const outDir = path.resolve(arg('out') ?? '.');
const taskFile = path.resolve(arg('task-file') ?? '.');
const cli = path.resolve(arg('cli') ?? '');
const artifactSha256 = arg('artifact-sha256')?.toLowerCase() ?? '';
const evidenceRoot = path.resolve(arg('evidence-root') ?? '.');

if (!['H1', 'H2', 'H3', 'H5', 'R1', 'S1'].includes(label)
  || !baselineHead || !fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()
  || !fs.statSync(taskFile, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(cli, { throwIfNoEntry: false })?.isFile()
  || !/^[0-9a-f]{64}$/.test(artifactSha256)
  || !fs.statSync(evidenceRoot, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('usage: --label H1|H2|H3|H5|R1|S1 --repo <independent copy> --baseline-head <sealed setup commit> --task-file <task text> --out <new immutable output directory> --cli <installed main.js> --artifact-sha256 <64 hex> --evidence-root <v15-realworld evidence directory>');
  process.exit(2);
}
if (fs.existsSync(outDir)) {
  console.error(`REFUSED: output directory already exists: ${outDir}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(outDir), { recursive: true });
fs.mkdirSync(outDir);

const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
const gitOut = (...args) => {
  const r = git(...args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stdout ?? '')}${(r.stderr ?? '')}`);
  return (r.stdout ?? '').trim();
};
const identity = () => ({
  head: gitOut('rev-parse', 'HEAD'), tree: gitOut('rev-parse', 'HEAD^{tree}'),
  status: gitOut('status', '--porcelain'),
});
const before = identity();
if (before.head.toLowerCase() !== baselineHead.toLowerCase() || before.status) {
  console.error(`REFUSED: expected a clean sealed base ${baselineHead}; found ${before.head}\n${before.status}`);
  process.exit(1);
}

const taskDiffByLabel = {
  H2: 'H2-hermes-invoices/agent.diff',
  R1: 'R1-refactron-pytest-ids/agent.diff',
  H5: 'H5-hermes-simulation-cases/agent.diff',
};
const sourceCommitByLabel = {
  H1: '4f35b9c51d787b3a2f05c91a2ae0c8377a2b5840',
  H3: '64ab5d4eb9b68149ee06f858161db31395172496',
  S1: '761b863760af4ad81df3e27529ab694259f2012d',
};
const sourcePaths = taskDiffByLabel[label]
  ? [path.join(evidenceRoot, 'runs', taskDiffByLabel[label])]
  : [path.join('C:\\Users\\Johannes\\Desktop\\canary-ws5-scratch', label === 'S1' ? 'schniedelsmp' : 'hermes-agent')];
const inputHashes = [];
let operation;

function applyPatch(patch, name) {
  const result = spawnSync('git', ['-C', repo, 'apply', '--whitespace=nowarn'], {
    input: patch, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${name}: git apply exit ${String(result.status)}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}
function sectionFromRaw(text, rel) {
  const marker = `diff --git a/${rel} b/${rel}`;
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`recorded candidate diff does not contain ${rel}`);
  const next = text.indexOf('\ndiff --git ', start + marker.length);
  return text.slice(start, next === -1 ? text.length : next).trimEnd();
}
function applyFilteredFiles(raw, paths, name) {
  const args = ['-C', repo, 'apply', '--whitespace=nowarn', ...paths.map((p) => `--include=${p}`)];
  const result = spawnSync('git', args, { input: raw, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`${name}: filtered git apply exit ${String(result.status)}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}
function selectedHunk(section, marker) {
  const lines = section.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('@@ ')) starts.push(i);
  const selected = starts.findIndex((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).some((line) => line.includes(marker)));
  if (selected === -1) throw new Error(`recorded candidate patch has no hunk containing ${marker}`);
  const header = lines.slice(0, starts[0]);
  const hunk = lines.slice(starts[selected], starts[selected + 1] ?? lines.length);
  return [...header, ...hunk].join('\n') + '\n';
}
function replaceOnce(file, beforeText, afterText, labelText) {
  let text = fs.readFileSync(file, 'utf8');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const needle = beforeText.replaceAll('\n', newline);
  const replacement = afterText.replaceAll('\n', newline);
  if (text.split(needle).length !== 2) throw new Error(`${labelText}: expected exactly one source anchor`);
  text = text.replace(needle, replacement);
  fs.writeFileSync(file, text);
}

let candidateSourceSha256;
if (sourceCommitByLabel[label]) {
  const sourceRepo = sourcePaths[0];
  const commit = sourceCommitByLabel[label];
  const show = spawnSync('git', ['-C', sourceRepo, 'show', '--format=', '--binary', commit], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (show.status !== 0 || !show.stdout) throw new Error(`cannot read recorded solution commit ${commit}: ${show.stderr ?? ''}`);
  candidateSourceSha256 = sha256(show.stdout);
  operation = { kind: 'cherry-pick recorded solution commit', sourceCommit: commit };
  const cherry = git('cherry-pick', '--no-edit', commit);
  if (cherry.status !== 0) throw new Error(`cherry-pick ${commit} failed: ${cherry.stdout}${cherry.stderr}`);
} else if (label === 'H2') {
  const diffPath = sourcePaths[0];
  const raw = fs.readFileSync(diffPath, 'utf8');
  candidateSourceSha256 = sha256(raw);
  operation = { kind: 'filtered recorded diff; excluded the unrelated simulation-length hunk and matrix change', sourcePath: diffPath };
  // H2 starts independently: these imports must not come from an earlier H1 run.
  const smokeFile = path.join(repo, 'scripts/smoke-test.js');
  const smokeText = fs.readFileSync(smokeFile, 'utf8');
  const imports = [
    ['fs', 'node:fs/promises'], ['os', 'node:os'], ['path', 'node:path'],
  ].filter(([name, module]) => !smokeText.includes(`import ${name} from "${module}";`))
    .map(([name, module]) => `import ${name} from "${module}";`);
  if (imports.length) fs.writeFileSync(smokeFile, `${imports.join('\n')}\n${smokeText}`);
  replaceOnce(path.join(repo, 'src/workflows/fileOrganizer.js'), `const EXT_GROUPS = [
  { group: "code", test: (name, ext) => [".js", ".ts", ".py", ".ipynb", ".json", ".csv", ".r", ".rs", ".go"].includes(ext) },
  { group: "invoices", test: (name, ext) => [".pdf", ".docx", ".xlsx"].includes(ext) && /(rechnung|invoice|receipt|beleg|tax)/i.test(name) },
  { group: "documents", test: (name, ext) => [".pdf", ".doc", ".docx", ".txt", ".md", ".xlsx", ".pptx"].includes(ext) },`, `const DOCUMENT_EXTS = [".pdf", ".doc", ".docx", ".txt", ".md", ".xlsx", ".pptx"];

const EXT_GROUPS = [
  { group: "code", test: (name, ext) => [".js", ".ts", ".py", ".ipynb", ".json", ".csv", ".r", ".rs", ".go"].includes(ext) },
  { group: "invoices", test: (name, ext) => DOCUMENT_EXTS.includes(ext) && /(rechnung|invoice|receipt|beleg|tax)/i.test(name) },
  { group: "documents", test: (name, ext) => DOCUMENT_EXTS.includes(ext) },`, 'H2 invoice implementation');
  const invoiceTest = `// Invoice classification contract: an invoice-style name wins over the generic
// documents group for every document extension (.pdf .doc .docx .txt .md .xlsx .pptx),
// and no other group's classification changes.
const invoiceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-invoice-classify-"));
try {
  const names = [
    "Rechnung_2026-03.txt", "invoice-2026.md", "Beleg.doc", "tax-report.pptx",
    "Rechnung-2024.pdf", "invoice.docx", "receipt.xlsx",
    "notes.txt", "README.md", "summary.docx",
    "photo.png", "app.js", "data.csv", "archive.zip", "mystery.xyz"
  ];
  for (const name of names) await fs.writeFile(path.join(invoiceRoot, name), "x");
  const page = await previewOrganization({ root: invoiceRoot });
  const groups = Object.fromEntries(page.moves.map((move) => [move.file, move.group]));
  assert.deepEqual(groups, {
    "Rechnung_2026-03.txt": "invoices",
    "invoice-2026.md": "invoices",
    "Beleg.doc": "invoices",
    "tax-report.pptx": "invoices",
    "Rechnung-2024.pdf": "invoices",
    "invoice.docx": "invoices",
    "receipt.xlsx": "invoices",
    "notes.txt": "documents",
    "README.md": "documents",
    "summary.docx": "documents",
    "photo.png": "images",
    "app.js": "code",
    "data.csv": "code",
    "archive.zip": "archives",
    "mystery.xyz": "other"
  });
} finally {
  await fs.rm(invoiceRoot, { recursive: true, force: true });
}

`;
  replaceOnce(path.join(repo, 'scripts/smoke-test.js'), 'console.log("Hermes smoke test passed");', `${invoiceTest}console.log("Hermes smoke test passed");`, 'H2 invoice regression test');
  const add = git('add', '--', 'src/workflows/fileOrganizer.js', 'scripts/smoke-test.js');
  if (add.status !== 0) throw new Error(`git add H2 files failed: ${add.stderr}`);
  const commit = git('commit', '-m', 'validation: expand invoice classification');
  if (commit.status !== 0) throw new Error(`git commit H2 failed: ${commit.stderr}`);
} else if (label === 'R1') {
  const diffPath = sourcePaths[0];
  const raw = fs.readFileSync(diffPath, 'utf8');
  candidateSourceSha256 = sha256(raw);
  operation = { kind: 'filtered recorded diff; only task source and its regression tests', sourcePath: diffPath };
  applyFilteredFiles(raw, ['src/verify/failure-ids.ts', 'tests/unit/verify/failure-ids.test.ts'], 'R1 task-only patch');
  const add = git('add', '--', 'src/verify/failure-ids.ts', 'tests/unit/verify/failure-ids.test.ts');
  if (add.status !== 0) throw new Error(`git add R1 files failed: ${add.stderr}`);
  const commit = git('commit', '-m', 'validation: preserve distinct pytest parameter ids');
  if (commit.status !== 0) throw new Error(`git commit R1 failed: ${commit.stderr}`);
} else if (label === 'H5') {
  const evidence = fs.readFileSync(sourcePaths[0], 'utf8');
  candidateSourceSha256 = sha256(evidence);
  const matrix = path.join(repo, 'src/agent/matrixNormCore.js');
  const smoke = path.join(repo, 'scripts/smoke-test.js');
  replaceOnce(matrix,
    '    { name: "two close singular directions", rows: 16, cols: 16, mode: "two-close" }\n  ];',
    '    { name: "two close singular directions", rows: 16, cols: 16, mode: "two-close" },\n    { name: "dense 32x32", rows: 32, cols: 32, mode: "dense" },\n    { name: "very wide 4x64", rows: 4, cols: 64, mode: "dense" }\n  ];',
    'H5 matrix case additions reconstructed from the task specification');
  replaceOnce(smoke, 'assert.equal(math.simulation.length, 8);', 'assert.equal(math.simulation.length, 12);', 'H5 simulation row-count assertion');
  operation = { kind: 'task-spec reconstruction; added only the two requested simulation cases and row-count regression' };
  const add = git('add', '--', 'src/agent/matrixNormCore.js', 'scripts/smoke-test.js');
  if (add.status !== 0) throw new Error(`git add H5 files failed: ${add.stderr}`);
  const commit = git('commit', '-m', 'validation: add two matrix stability cases');
  if (commit.status !== 0) throw new Error(`git commit H5 failed: ${commit.stderr}`);
}

const after = identity();
const diff = spawnSync('git', ['-C', repo, 'diff', '--binary', baselineHead, 'HEAD'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
if (diff.status !== 0 || !diff.stdout) throw new Error(`candidate diff could not be recorded: ${diff.stderr ?? ''}`);
fs.writeFileSync(path.join(outDir, 'candidate.diff'), diff.stdout, { flag: 'wx' });
fs.writeFileSync(path.join(outDir, 'git-before.json'), `${JSON.stringify(before, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(outDir, 'git-after.json'), `${JSON.stringify(after, null, 2)}\n`, { flag: 'wx' });
const attempt = {
  schema: 'canary-release-validation-solution/1', label,
  probe: 'tooling/probes/v15-prepare-validation-solution.mjs',
  probeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  canaryPath: cli, canaryBinarySha256: sha256(fs.readFileSync(cli)),
  publishedArtifactSha256: artifactSha256, taskPath: taskFile,
  taskSha256: sha256(fs.readFileSync(taskFile)), baselineHead,
  operation, candidateSourceSha256,
  startingRepoIdentity: before, finalRepoIdentity: after,
  finishedAt: new Date().toISOString(), status: after.head !== before.head && after.status === '' ? 'complete' : 'incomplete',
};
fs.writeFileSync(path.join(outDir, 'attempt-result.json'), `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'wx' });
const sums = fs.readdirSync(outDir).filter((name) => name !== 'SHA256SUMS').sort()
  .map((name) => `${sha256(fs.readFileSync(path.join(outDir, name)))}  ${name}`);
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`, { flag: 'wx' });
console.log(`${attempt.status === 'complete' ? 'PASS' : 'FAIL'} ${label}: ${before.head} -> ${after.head}; ${operation.kind}`);
process.exit(attempt.status === 'complete' ? 0 : 1);
