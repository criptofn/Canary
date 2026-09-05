// F6a mechanical probe: does a runner-ROOT symlink (or junction) bypass the
// "a symlink anywhere throws -> pin miss" claim of treeSha256/locateRunnerPackage?
// Run: node .night-run/f6a-probe.mjs   (fresh unique scratch dir every time)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = 'C:/Users/Johannes/Desktop/canary-observation-hardening';
const require = createRequire(REPO + '/packages/support/package.json');
const kr = require(REPO + '/packages/support/dist/src/knownRunners.js');
const { treeSha256, locateRunnerPackage } = kr;

const DOUBLE = path.join(REPO, 'apps/cli/test/fixtures/mocha-double');
const PIN_DOUBLE = '12e47c3604c2e808a2112ff806cdfdcf68b1c80cb7f88fd11f8ba974440e7e9f';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f6a-probe-'));
console.log('scratch:', tmp);

// sanity: the real double hashes to its pin
const realHash = treeSha256(DOUBLE);
console.log('plain treeSha256(real double) == pin:', realHash === PIN_DOUBLE);

function layout(kind) {
  // tmp/<kind>/fixture/node_modules/mocha  ->  link/copy of DOUBLE
  const root = path.join(tmp, kind);
  const nm = path.join(root, 'fixture', 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  const link = path.join(nm, 'mo' + 'cha');
  let made = null;
  try { fs.symlinkSync(DOUBLE, link, kind === 'junction' ? 'junction' : 'dir'); made = kind; }
  catch (e) { console.log(kind, ': symlink creation FAILED:', e.code); return null; }
  return { root, link };
}

for (const kind of ['symlink', 'junction']) {
  const L = layout(kind);
  if (!L) continue;
  const st = fs.lstatSync(L.link);
  console.log(`\n[${kind}] lstat(link).isSymbolicLink():`, st.isSymbolicLink());
  const mochaDir = L.link;
  const nm = path.join(L.root, 'fixture', 'node_modules');
  // 1) does treeSha256 on the symlinked ROOT throw?
  let threw = null, hash = null;
  try { hash = treeSha256(mochaDir); } catch (e) { threw = e.message; }
  console.log(`[${kind}] treeSha256(symlinked root) threw:`, threw, '| hash==pin:', hash === PIN_DOUBLE);
  // 2) does locateRunnerPackage accept it at the fixture-lexical path?
  const bin = path.join(mochaDir, 'bin', 'mocha'); // whatever exists under the double
  const located = locateRunnerPackage(fs.existsSync(bin) ? bin : path.join(mochaDir, 'index.js'), 'mocha');
  console.log(`[${kind}] locateRunnerPackage ->`, located ? { dir: located.dir === mochaDir ? '== link path (lexical)' : located.dir, version: located.version, treeSha256: located.treeSha256 === PIN_DOUBLE ? '== PIN' : located.treeSha256 } : null);
}

// 3) ancestor case: node_modules itself as a link, mocha a REAL dir inside the target
{
  const root = path.join(tmp, 'ancestor');
  const outside = path.join(tmp, 'ancestor-target');
  fs.cpSync(DOUBLE, path.join(outside, 'mocha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });
  const nmLink = path.join(root, 'fixture', 'node_modules');
  try { fs.symlinkSync(outside, nmLink, 'junction'); } catch (e) { console.log('\n[ancestor] junction failed:', e.code); process.exit(0); }
  const mochaDir = path.join(nmLink, 'mocha');
  console.log('\n[ancestor] lstat(mochaDir).isSymbolicLink():', fs.lstatSync(mochaDir).isSymbolicLink());
  let threw = null, hash = null;
  try { hash = treeSha256(mochaDir); } catch (e) { threw = e.message; }
  console.log('[ancestor] treeSha256(root is REAL inside, ancestor is link) threw:', threw, '| hash==pin:', hash === PIN_DOUBLE);
  const located = locateRunnerPackage(path.join(mochaDir, 'index.js'), 'mocha');
  console.log('[ancestor] locate ->', located ? { eqLexicalCanonical: located.dir === path.resolve(mochaDir), hash: located.treeSha256 === PIN_DOUBLE ? '== PIN' : '?' } : null);
}
console.log('\nscratch left at', tmp, '(unique name; not recycled)');
