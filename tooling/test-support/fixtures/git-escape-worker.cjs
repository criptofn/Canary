// Confined-Git escape battery. Runs IDENTICALLY as the unrestricted positive control
// and through the production confined executor (`canary provider ... productionTool`).
//
// Every vector's output is FILE-BACKED: no nested stdio pipes exist on any path, so a
// vector can neither stall on a pipe nor hide behind one. Each child has a hard
// timeout and is reported with `timedOut`, which the driver classifies as
// INCONCLUSIVE — a timeout is never counted as a blocked attack.
//
// Helper-execution vectors are attributed by a SIDE EFFECT the helper writes OUTSIDE
// the sandbox: if `ran-<id>.txt` never appears, the helper never ran. That signal does
// not depend on how git words its error.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const batch = process.argv[3];
// Scratch output lives beside the report — i.e. in the SANDBOX for a confined run and
// in the sandbox copy for a control run. Never in the repository the probe is run from.
const here = path.dirname(cfg.report);
const rows = [];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const TIMEOUT = Number(cfg.runTimeout || 8000);
const OUT = cfg.outside, OUT_SLASH = cfg.outsideSlash;
const cwdOf = () => { try { return process.cwd(); } catch (e) { return 'unavailable: ' + (e.code || e.message); } };
// Incremental: the report survives a vector that kills this process (the alias batch
// deletes the process's own current directory), so partial evidence is never lost.
const save = () => { try { fs.writeFileSync(cfg.report, JSON.stringify({ batch, cwd: cwdOf(), rows }, null, 1)); } catch { } };

// A descendant attempt: this same program, re-entered, must inherit the boundary.
if (batch === 'descendant') {
  const out = {};
  for (const [id, file] of Object.entries(cfg.descendantReads)) {
    try { out[id] = { allowed: true, digest: sha(fs.readFileSync(file)) }; }
    catch (e) { out[id] = { allowed: false, error: e.code || e.message }; }
  }
  fs.writeFileSync(cfg.descendantReport, JSON.stringify(out));
  process.exit(0);
}

function attempt(id, kind, fn, extra) {
  const row = Object.assign({ id, kind }, extra);
  try { row.executed = true; row.allowed = true; const v = fn(); if (v !== undefined) row.value = v; }
  catch (e) { row.executed = true; row.allowed = false; row.error = e.code || e.message; }
  rows.push(row); save();
}
const readFile = (id, file) => attempt(id, 'read', () => sha(fs.readFileSync(file)), { target: file });
const listDir = (id, dir) => attempt(id, 'read', () => fs.readdirSync(dir).sort().slice(0, 40), { target: dir });

/** Run one program with file-backed stdio, a hard timeout and no shell. */
function run(id, argv, env, cwd) {
  const outPath = path.join(here, 'run-' + id + '.out'), errPath = path.join(here, 'run-' + id + '.err');
  const row = { id, kind: 'exec', argv: argv.slice(0, 6) };
  let out, err;
  try { out = fs.openSync(outPath, 'w'); err = fs.openSync(errPath, 'w'); }
  catch (e) { row.executed = false; row.error = e.code || e.message; rows.push(row); return; }
  let r;
  try {
    r = spawnSync(argv[0], argv.slice(1), { cwd: cwd || process.cwd(), windowsHide: true, timeout: TIMEOUT,
      killSignal: 'SIGKILL', shell: false, stdio: ['ignore', out, err], env: Object.assign({}, process.env, env || {}) });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  const stdout = fs.readFileSync(outPath, 'utf8'), stderr = fs.readFileSync(errPath, 'utf8');
  const timedOut = !!r.error && (r.error.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(r.error.message)));
  Object.assign(row, { executed: !r.error || timedOut, timedOut, status: r.status, stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 4000), error: r.error ? (r.error.code || r.error.message) : undefined,
    // Content signal only on a clean exit: a filename inside an error message is not
    // evidence that the content was read.
    escaped: r.status === 0 && /ESCAPE_CANARY/.test(stdout + stderr) });
  rows.push(row); save();
}
const git = (id, args, env) => run(id, [cfg.git].concat(args), Object.assign({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' }, env || {}));

// Attribution readbacks first, in EVERY batch: a denial is attributable only from
// evidence observed by THIS process in THIS run, never from another run's rows.
if (batch !== 'descendant') {
  for (const [id, spec] of Object.entries(cfg.readbacks)) {
    if (spec.dir) listDir(id, spec.path); else readFile(id, spec.path);
  }
}

if (batch === 'reads') {
  for (const [id, file] of Object.entries(cfg.reads)) readFile(id, file);
  for (const [id, dir] of Object.entries(cfg.listings)) listDir(id, dir);
  readFile('trusted-launcher-source', path.join(cfg.repo, 'tools', 'windows-boundary', 'CanaryConfinedLauncher.cs'));
  readFile('nt-device-path', cfg.ntSecret);
  if (cfg.shortSecret) readFile('short-name-path', cfg.shortSecret);
  if (cfg.uncSecret) readFile('unc-path', cfg.uncSecret);
  readFile('drive-relative', 'C:' + OUT.slice(2) + '\\secret.config');
  // Descendant process attempts: the boundary must be inherited, not just held by
  // the first process. Both a Node grandchild and a cmd.exe shell.
  run('descendant-node-launch', [process.execPath, __filename, process.argv[2], 'descendant']);
  run('descendant-cmd', ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'type', path.join(OUT, 'secret.config')]);
}

if (batch === 'git-paths') {
  git('git-C', ['-C', OUT, 'config', '--local', '--get', 'canary.probe']);
  git('git-C-slash', ['-C', OUT_SLASH, 'config', '--local', '--get', 'canary.probe']);
  git('git-dir', ['--git-dir=' + OUT_SLASH + '/.git', 'show', 'HEAD:ESCAPE_CANARY']);
  git('git-dir-config', ['--git-dir=' + OUT_SLASH + '/.git', 'config', '--local', '--get', 'canary.probe']);
  git('GIT_DIR', ['show', 'HEAD:ESCAPE_CANARY'], { GIT_DIR: OUT_SLASH + '/.git' });
  git('git-dir-work-tree', ['--git-dir=' + OUT_SLASH + '/.git', '--work-tree=' + OUT_SLASH, 'status', '--porcelain']);
  git('GIT_WORK_TREE', ['ls-files', '--others', '--exclude-standard'], { GIT_WORK_TREE: OUT_SLASH });
  git('GIT_OBJECT_DIRECTORY', ['cat-file', '-p', cfg.secretObject], { GIT_OBJECT_DIRECTORY: OUT_SLASH + '/.git/objects' });
  git('alternate-objects', ['cat-file', '-p', cfg.secretObject], { GIT_ALTERNATE_OBJECT_DIRECTORIES: OUT_SLASH + '/.git/objects' });
  git('include.path', ['-c', 'include.path=' + OUT_SLASH + '/secret.config', 'config', '--get', 'canary.probe']);
  git('includeIf', ['-c', 'includeIf.gitdir:**/.git.path=' + OUT_SLASH + '/secret.config', 'config', '--get', 'canary.probe']);
  git('core.worktree', ['-c', 'core.worktree=' + OUT_SLASH, 'status', '--porcelain', '--untracked-files=all']);
  git('core.worktree-config', ['config', 'core.worktree', OUT_SLASH]);
  git('core.worktree-status', ['status', '--porcelain', '--untracked-files=all']);
}

if (batch === 'git-exec') {
  // A real change is required before external diff, textconv and the clean filter can run.
  fs.writeFileSync(path.join(process.cwd(), 'implementation.txt'), 'confined change\n');
  const helper = id => cfg.helperDirSlash + '/ran-' + id + '.sh';
  git('hooksPath-hookrun', ['-c', 'core.hooksPath=' + cfg.helperDirSlash, 'hook', 'run', 'pre-commit']);
  git('hooksPath-commit', ['-c', 'core.hooksPath=' + cfg.helperDirSlash, 'commit', '--allow-empty', '-m', 'escape probe']);
  git('external-diff', ['-c', 'diff.external=' + helper('external-diff'), 'diff', '--ext-diff']);
  git('GIT_EXTERNAL_DIFF', ['diff'], { GIT_EXTERNAL_DIFF: helper('GIT_EXTERNAL_DIFF') });
  git('textconv', ['-c', 'diff.probe.textconv=' + helper('textconv'), 'diff', '--textconv']);
  git('filter-clean', ['-c', 'filter.probe.clean=' + helper('filter-clean'), 'add', '--', 'implementation.txt']);
  git('fsmonitor', ['-c', 'core.fsmonitor=' + helper('fsmonitor'), 'status', '--porcelain']);
  // `core.pager` is NOT tested: git invokes the pager only when stdout is a terminal,
  // and the confined executor always captures to a file, so no positive control could
  // establish that vector by construction. This is recorded as non-coverage, not a pass.
  git('gpgProgram', ['-c', 'gpg.program=' + helper('gpgProgram'), '-c', 'gpg.format=openpgp', 'commit', '-S', '--allow-empty', '-m', 'signed']);
  git('editor', ['-c', 'core.editor=' + helper('editor'), 'commit', '--allow-empty']);
  git('sshCommand', ['-c', 'core.sshCommand=' + helper('sshCommand'), 'ls-remote', 'ssh://probe.invalid/x']);
}

if (batch === 'alias') {
  const subst = 'C:\\Windows\\System32\\subst.exe';
  const p = (id, file) => attempt(id, 'read', () => sha(fs.readFileSync(file)), { target: file });
  run('subst-list', [subst]);
  p('alias-self-read', 'Z:\\implementation.txt');
  run('subst-create-y-trusted', [subst, 'Y:', cfg.repo]);
  p('alias-created-read', 'Y:\\package.json');
  run('subst-create-w-outside', [subst, 'W:', OUT]);
  p('alias-outside-read', 'W:\\secret.config');
  run('subst-list-after', [subst]);
}

if (batch === 'alias-retarget-cwd') {
  // Isolated last: the confined process's OWN cwd IS the alias root, so retargeting
  // it is the sharpest alias attack, and a successful one can kill this process.
  // `subst` refuses to overwrite an existing substitution, so each create is preceded
  // by an explicit delete — which is itself the attempt to unmap the trusted alias.
  const subst = 'C:\\Windows\\System32\\subst.exe';
  run('subst-delete-z', [subst, 'Z:', '/D']);
  run('subst-create-z-trusted', [subst, 'Z:', cfg.repo]);
  attempt('alias-retarget-read', 'read', () => sha(fs.readFileSync('Z:\\package.json')), { target: 'Z:\\package.json' });
  run('subst-delete-z-again', [subst, 'Z:', '/D']);
  run('subst-create-z-outside', [subst, 'Z:', OUT]);
  attempt('alias-retarget-outside-read', 'read', () => sha(fs.readFileSync('Z:\\secret.config')), { target: 'Z:\\secret.config' });
  run('subst-list-after', [subst]);
}

save();
process.exit(0);
