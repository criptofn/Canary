/**
 * The Canary OBSERVER PRELOAD — the exact source text Canary writes (byte-
 * stable) into the workspace root and injects into a pinned-bytes mocha via
 * `--require` inside Recorder.expandArgv. This file IS the trusted copy: the
 * on-disk artifact is disposable output of these bytes, and nothing else can
 * make the subject load it — a round's argv either contains the injected
 * --require (expandArgv put it there; prove re-derives that fact) or the
 * observer never exists in that process.
 *
 * Design rules encoded below (probes on mocha@10.8.2, 2026-09-01/02; panel
 * decisions F + I):
 *  1. Lifecycle ground truth is Runnable.prototype.run + Runner.prototype.emit
 *     TOGETHER: a pass/fail event for a Test object whose run() Canary never
 *     watched execute is REJECTED (reject frame — which fails the round
 *     closed). Printing or emitting is not execution.
 *  2. The preload must never alter subject behavior: every hook body is
 *     try/caught; a broken hook emits one adapter-error frame (⇒ INVALID) and
 *     degrades silently afterwards.
 *  3. Byte purity: wrapping Runnable#run would insert OUR frame into every
 *     printed stack — shifting stderr bytes and invalidating the byte-pinned
 *     golden proof. The done-callback wrapper scrubs own-filename lines from
 *     err.stack (proven necessary and sufficient on this host; residual:
 *     paths where mocha prints OUR frame directly — those streams already
 *     fail VALID elsewhere).
 *  4. PATH-ANCHORED MOCHA LOCATION (panel I): the Mocha class is found via
 *     require.cache entries under <cwd>/node_modules/mocha — the exact
 *     directory the injection decision HASHED (expandArgv refuses to inject
 *     unless the pinned package sits canonically there). It is NEVER located
 *     by require('mocha'): resolution from the workspace path would miss
 *     FIXTURE/node_modules and silently no-op. No cache hit under the anchor
 *     ⇒ adapter-error frame ⇒ INVALID (fail-closed, and the subject's run
 *     continues unobserved).
 *  5. module.exports carries {isCanaryObserver:true, version}: the marker
 *     Canary's parent-side read-back check (ensureObserverPreload) plus the
 *     hello.observerVersion frame together pin that the bytes LOADED are
 *     Canary's — a property the parent cannot read through the child's module
 *     system, so it is pinned at the two points it can reach (file bytes
 *     before spawn; self-report inside hello, validator-enforced).
 *  6. NO secret is injected (none can exist in-process honestly): channel
 *     binding is the OS pipe + spawn-pid match + argv re-derivation, and the
 *     honest ceiling — in-process code CAN emulate these frames — is a
 *     DOCUMENTED residual (docs/exec-authority.md 8a/8a′), not a claim this
 *     file solves. What this file makes structurally impossible is certifying
 *     execution from TEXT ALONE.
 *  7. fd 3 is CLOSED EXACTLY ONCE, in process.on('exit'), after bye has been
 *     flushed (frames are writeSync; flush order is program order). A second
 *     close is the subject's problem (EBADF inside its process cannot forge
 *     our stream — the bytes already sit in Canary's pipe buffer).
 */

import fs from 'node:fs';
import path from 'node:path';

import { CanaryError, type WorkspaceLayout } from '@canary-rn/support';
import { OBSERVER_VERSION } from './observation.js';

export const OBSERVER_PRELOAD_BASENAME = 'canary-observer.cjs';

/**
 * The canonical fixture-relative location of a supported runner. expandArgv
 * injects ONLY when the pin-matched mocha package directory equals exactly
 * this path (panel I: "same path+bytes for both arms" — the preload derives
 * its anchor from its OWN cwd, which runCommand fixes to ws.fixture).
 */
export const OBSERVER_MOCHA_ANCHOR_REL = ['node_modules', 'mocha'];

export const OBSERVER_PRELOAD_SOURCE = `'use strict';
var fs = require('fs');
var path = require('path');
var OBSERVER_VERSION = '${OBSERVER_VERSION}';

var fd3Open = true;
function frame(o) {
  if (!fd3Open) return;
  try { fs.writeSync(3, JSON.stringify(o) + '\\n'); }
  catch (e) { fd3Open = false; try { process.stderr.write('[canary-observer] fd3 write failed: ' + e.message + '\\n'); } catch (x) {} }
}
process.on('exit', function () {
  if (fd3Open) { try { fs.closeSync(3); } catch (e) {} fd3Open = false; }
});

// ── Path-anchored mocha location (design rule 4). Prefer the instance mocha's
// bin has ALREADY loaded into require.cache (guaranteed identity with the one
// the runner will use); fall back to a FILE-PATH require under the same anchor
// (cache-first in node, and the bin's later relative requires resolve into
// this same directory, so prototype patches land on the live classes).
var ANCHOR = path.resolve(process.cwd(), ${JSON.stringify(OBSERVER_MOCHA_ANCHOR_REL.join('/'))});
function isMochaShape(ex) {
  return !!ex && typeof ex.Runner === 'function' && typeof ex.Runnable === 'function'
    && typeof ex.Runner.prototype.emit === 'function' && typeof ex.Runnable.prototype.run === 'function';
}
var Mocha = null;
try {
  var keys = Object.keys(require.cache).sort();
  for (var ki = 0; ki < keys.length; ki++) {
    var f = keys[ki];
    if (f.indexOf(ANCHOR + path.sep) !== 0) continue;
    var ent = require.cache[f];
    if (isMochaShape(ent && ent.exports)) { Mocha = ent.exports; break; }
  }
  if (!Mocha) {
    var mainRel = JSON.parse(fs.readFileSync(path.join(ANCHOR, 'package.json'), 'utf8')).main || 'index.js';
    var loaded = require(path.resolve(ANCHOR, mainRel));
    if (isMochaShape(loaded)) Mocha = loaded;
    else {
      // Some entry the load just populated may expose the classes.
      var keys2 = Object.keys(require.cache).sort();
      for (var k2 = 0; k2 < keys2.length; k2++) {
        if (keys2[k2].indexOf(ANCHOR + path.sep) !== 0) continue;
        var ent2 = require.cache[keys2[k2]];
        if (isMochaShape(ent2 && ent2.exports)) { Mocha = ent2.exports; break; }
      }
    }
  }
} catch (e) {}

var ranSet = new WeakSet();
var passedOnce = new WeakSet();
var SELF = __filename;
var SELF_BASE = path.basename(__filename);
var counts = { pass: 0, fail: 0, pending: 0, rejected: 0 };
var hookBroken = false;

function idOf(t) {
  try {
    if (!t || typeof t.titlePath !== 'function') return null;
    var parts = t.titlePath();
    if (!Array.isArray(parts)) return null;
    return parts.filter(function (s) { return typeof s === 'string' && s !== ''; }).join(' > ');
  } catch (e) { return null; }
}

function scrub(err) {
  if (!err || typeof err.stack !== 'string') return;
  try {
    var lines = err.stack.split('\\n');
    var kept = lines.filter(function (l) { return l.indexOf(SELF) === -1 && l.indexOf(SELF_BASE) === -1; });
    if (kept.length !== lines.length) err.stack = kept.join('\\n');
  } catch (e) {}
}

try {
  if (!Mocha) {
    // Never observed via require('mocha') (design rule 4): if the pinned
    // package is not in cache under the anchor, we do not guess.
    frame({ k: 'adapter-error', err: 'mocha not found under ' + ANCHOR });
  } else {
    var mochaVersion = 'unknown';
    try {
      // Read the version from the SAME cache-anchored package.json the hash
      // covered — not through a second resolution (design rule 4 again).
      var pkgJson = JSON.parse(fs.readFileSync(path.join(ANCHOR, 'package.json'), 'utf8'));
      if (typeof pkgJson.version === 'string') mochaVersion = pkgJson.version;
    } catch (e) {}
    frame({ k: 'hello', pid: process.pid, mochaVersion: mochaVersion, observerVersion: OBSERVER_VERSION, node: process.version });

    var origRun = Mocha.Runnable.prototype.run;
    Mocha.Runnable.prototype.run = function (fn) {
      var self = this;
      var wrapped = function (err) {
        try { ranSet.add(self); } catch (e) {}
        if (err) scrub(err);
        return fn.apply(this, arguments);
      };
      return origRun.call(self, wrapped);
    };

    var origEmit = Mocha.Runner.prototype.emit;
    Mocha.Runner.prototype.emit = function (ev, arg) {
      if (!hookBroken) {
        try {
          if (ev === 'pass' && arg && arg.type === 'test') {
            if (!ranSet.has(arg)) {
              counts.rejected += 1;
              frame({ k: 'reject', ev: ev, id: idOf(arg), reason: 'no-run' });
            } else if (passedOnce.has(arg)) {
              counts.rejected += 1;
              frame({ k: 'reject', ev: ev, id: idOf(arg), reason: 'dup-pass' });
            } else {
              passedOnce.add(arg);
              counts.pass += 1;
              frame({ k: 'pass', id: idOf(arg), file: arg.file || null });
            }
          } else if (ev === 'fail') {
            var isTest = arg && arg.type === 'test';
            if (isTest && !ranSet.has(arg)) {
              counts.rejected += 1;
              frame({ k: 'reject', ev: ev, id: idOf(arg), reason: 'no-run' });
            } else {
              counts.fail += 1;
              frame({ k: 'fail', id: isTest ? idOf(arg) : null, hook: !isTest });
            }
          } else if (ev === 'pending' && arg && arg.type === 'test') {
            counts.pending += 1;
            frame({ k: 'pending', id: idOf(arg), file: arg.file || null });
          } else if (ev === 'retry' && arg && arg.type === 'test') {
            passedOnce.delete(arg);
            frame({ k: 'retry', id: idOf(arg), file: arg.file || null });
          } else if (ev === 'end') {
            frame({ k: 'bye', counts: counts });
          }
        } catch (e) {
          hookBroken = true;
          frame({ k: 'adapter-error', err: String((e && e.message) || e) });
        }
      }
      return origEmit.apply(this, arguments);
    };
  }
} catch (e) {
  hookBroken = true;
  frame({ k: 'adapter-error', err: String((e && e.message) || e) });
}

module.exports = { isCanaryObserver: true, version: OBSERVER_VERSION };
`;

/** Where the preload lives: workspace root, OUTSIDE artifactsDir (it is not
 *  a canonical artifact), one deterministic path shared by both arms. prove
 *  re-derives it the same way from wsRoot. */
export function observerPreloadPath(ws: WorkspaceLayout): string {
  return path.join(ws.root, OBSERVER_PRELOAD_BASENAME);
}

/**
 * Canary-side "the loaded bytes are Canary's" guarantee (panel F: the parent
 * cannot read a property out of the child's module system, so the claim is
 * pinned at the two points it CAN reach):
 *  1. HERE, before spawn: write-if-different + read-back byte comparison.
 *     A prepare script that replaced the file under wsRoot gets rewritten
 *     fresh immediately before each injected round (normal path: one stat-
 *     plus-read, no write — "written once per experiment" holds whenever
 *     nobody touches it). Persistent mismatch ⇒ CanaryError ⇒ InfraAbort.
 *  2. INSIDE the child: hello.observerVersion self-reports, validator-pinned
 *     against OBSERVER_VERSION, plus prove re-compares the on-disk bytes.
 * The residual between (1) and exec is the pre-existing TOCTOU ceiling,
 * documented (docs/exec-authority.md) — the file is Canary-owned content
 * under a subject-reachable path, not a signature-verified artifact.
 */
export function ensureObserverPreload(ws: WorkspaceLayout): string {
  const p = observerPreloadPath(ws);
  try {
    if (fs.readFileSync(p, 'utf8') === OBSERVER_PRELOAD_SOURCE) return p;
  } catch { /* absent: write below */ }
  fs.writeFileSync(p, OBSERVER_PRELOAD_SOURCE, 'utf8');
  if (fs.readFileSync(p, 'utf8') !== OBSERVER_PRELOAD_SOURCE) {
    throw new CanaryError(
      `observer preload at ${p} does not match Canary's bytes even after rewrite (workspace is not writable-stable)`,
      'observer-preload-tampered',
    );
  }
  return p;
}
