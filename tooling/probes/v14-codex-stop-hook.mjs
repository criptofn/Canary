#!/usr/bin/env node
/**
 * v1.4 GAP C — IS CODEX A REAL, MEASURED SECOND COMPLETION GATE?
 *
 * `apps/cli/src/agents.ts` said Codex was advisory because "no completion hook exists to gate".
 * MEASURED on this host (2026-09-20): `codex --version` → `codex-cli 0.154.0`, `codex features list`
 * → `hooks  stable  true`, `--help` exposes `--dangerously-bypass-hook-trust`, and the vendor's hook
 * reference documents a `Stop` event whose contract is the SAME one `cmdCheckpoint` already
 * implements for Claude Code: one JSON object on stdin, JSON on stdout, `exit 0` with no output =
 * continue, `{"decision":"block","reason":…}` = keep going with that reason as the next prompt, and
 * `stop_hook_active` = "this turn was already continued by Stop".
 *
 * A vendor document is not evidence that THIS product gates. So this probe measures three things,
 * in increasing order of strength, and reports exactly how far it got:
 *
 *   H. the WIRING: `canary setup` writes `<repo>/.codex/hooks.json` with exactly one Canary `Stop`
 *      handler running the same `checkpoint` entry point, merges instead of overwriting, is
 *      byte-idempotent, and `canary uninstall` removes exactly its own handler.
 *   P. the PROTOCOL: the recorded hook command is spawned as Codex spawns it — the `Stop` event JSON
 *      on stdin, the decision read back from stdout — for the passing case (silent allow), the
 *      failing case (parsed `decision: "block"` with a reason that names the FAILING CHECK, not an
 *      authority error), and the loop guard (`stop_hook_active: true` must not block again).
 *   E. the REAL SESSION: one `codex exec` run in the same temporary repository, non-interactive,
 *      bounded. Codex has TWO trust layers and the run names both: the PROJECT must be trusted or the
 *      project `.codex/` layer is not loaded at all (the probe asserts that in an ISOLATED
 *      `CODEX_HOME` — a temp copy of the operator's credentials plus the vendor's own
 *      `[projects.'<path>'] trust_level = "trusted"` entry — so nothing the operator owns is
 *      modified), and `--dangerously-bypass-hook-trust` covers the per-hook review record, which is
 *      what that flag is documented for. The observation is not the exit code: it is that Canary's
 *      own checkpoint record, deleted just before the run, exists again afterwards (so the harness
 *      really executed the hook), and that the session continued on its decision.
 *
 * WHAT A SKIP MEANS HERE. If no runnable `codex` CLI exists, if it has no credentials, or if it times
 * out, the end-to-end arm prints an explicit SKIP naming what could not be done and the probe exits 3
 * (host-bound) — a SKIP is never a PASS, and the `gatingMeasured` claim in the capability table is
 * exactly the thing this arm is evidence for. If the session RUNS but the hook never fires, that is
 * not a host bound: it is a FAIL, because the product would be claiming a gate the harness skipped.
 *
 * Everything happens under the OS temp dir. Nothing in this repository is touched.
 * Usage: node tooling/probes/v14-codex-stop-hook.mjs
 * Exit:  0 all passed; 3 passed with explicit host-bound SKIP(s); 1 any FAIL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-v14-codex-'));
const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const skips = [];
const skip = (line) => { skips.push(line); console.log(`SKIP ${line}`); };
/** The raw bytes behind a surprising exit, printed once so a reader can judge it. */
const showRun = (label, r) => {
  console.log(`  !! ${label} -> exit ${r.status}${r.error ? ` (${r.error.message})` : ''}`);
  console.log(`  stdout: ${(r.stdout ?? '').split('\n').slice(0, 8).join(' | ')}`);
  console.log(`  stderr: ${(r.stderr ?? '').split('\n').slice(0, 8).join(' | ')}`);
};

/** Codex runs the handler through a shell; the recorded command is `node "<cli>" checkpoint`, so the
 *  probe drives exactly that argv after asserting the text (and reports the resolved entry point). */
const parseHookCommand = (command) => {
  const m = /^node "([^"]+)" checkpoint$/.exec(command);
  return m === null ? null : [process.execPath, m[1], 'checkpoint'];
};

/** The `Stop` event exactly as the vendor documents it (stdin, one JSON object). */
const stopEvent = (root, active) => JSON.stringify({
  session_id: 'v14-codex-probe', transcript_path: null, cwd: root, hook_event_name: 'Stop',
  model: 'probe', turn_id: 'turn-1', stop_hook_active: active, last_assistant_message: 'done',
});

/** Resolve a runnable codex entry point, or null. `codex` is an npm shim (.cmd on Windows, which
 *  spawnSync cannot execute), so the JS entry it points at is preferred and the resolved file is
 *  reported — the same "name the bytes" rule the rest of this repository's verification follows. */
function resolveCodex() {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8', timeout: 30_000 });
  const candidates = (probe.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const p of candidates) {
    try {
      if (/\.js$/i.test(p) && fs.statSync(p).isFile()) return { argv: [process.execPath, p], file: p };
      if (/\.cmd$/i.test(p)) {
        const js = path.join(path.dirname(p), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(js)) return { argv: [process.execPath, js], file: js };
      }
      if (/\.exe$/i.test(p) && fs.statSync(p).isFile()) return { argv: [p], file: p };
      if (process.platform !== 'win32' && fs.statSync(p).isFile()) return { argv: [p], file: p };
    } catch { /* keep looking */ }
  }
  return null;
}

try {
  if (!fs.existsSync(CLI)) {
    console.log(`FAIL v14 codex stop hook — build first: ${CLI} is missing`);
    process.exit(1);
  }
  const HOME = path.join(temp, 'empty-home');
  fs.mkdirSync(HOME, { recursive: true });
  const store = path.join(temp, 'trust-store');
  /**
   * AN ISOLATED HOME IS PART OF THE MEASUREMENT. `detectHarnesses` reads `<root>/.codex` and
   * `~/.codex`, so a fixture that declares `.codex/` is a Codex project on any host — and an empty
   * home keeps the operator's own `~/.claude` from being wired into the same fixture, which would
   * make "setup wrote exactly ONE handler" depend on whose machine this runs on.
   */
  const canaryEnv = { ...process.env, USERPROFILE: HOME, HOME, CANARY_TRUST_STORE: store };
  const run = (exe, args, cwd, opts = {}) => spawnSync(exe, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 300_000, ...opts,
  });
  const canary = (args, cwd, opts = {}) => run(process.execPath, [CLI, ...args], cwd, { env: canaryEnv, ...opts });

  // ── the fixture: a real git repo, a REAL check whose verdict can be flipped WITHOUT touching the
  // sealed script text (so a block can only come from the check failing, never from authority drift).
  const root = path.join(temp, 'repo');
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'v14-codex-probe', version: '1.0.0', private: true,
    scripts: { test: `node "${path.join(root, 'check.js')}"` },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'check.js'),
    "const fs = require('node:fs');\n"
    + "const path = require('node:path');\n"
    + "const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));\n"
    + "if (state.ok) { console.log('probe check OK'); process.exit(0); }\n"
    + "console.error('probe check FAILED (state.json says ok=false)');\n"
    + "process.exit(1);\n");
  fs.writeFileSync(path.join(root, 'state.json'), '{"ok": true}\n');
  run('git', ['init'], root);
  run('git', ['config', 'user.name', 'v14 fixture'], root);
  run('git', ['config', 'user.email', 'fixture@localhost'], root);
  run('git', ['add', '.'], root);
  run('git', ['-c', 'user.name=v14 fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'starting bytes'], root);

  /**
   * A hook file the USER already owns — and it must stay a file CODEX ITSELF ACCEPTS, because this
   * same file is what the real session at the end loads.
   *
   * MEASURED, the hard way (first run of this probe): an unfamiliar TOP-LEVEL key is not ignored by
   * Codex — it fails to parse the WHOLE hooks file ("failed to parse hooks config …: unknown field
   * `keepMe`"), so every hook in it, Canary's included, silently does not exist. That is a real
   * operational hazard for anyone hand-editing this file, and it is why the fixture below carries
   * only what the vendor documents: the optional `description`, plus events and handlers. The
   * writer's duty to preserve keys Canary does not understand is pinned in
   * `apps/cli/test/codex-wiring.test.ts` — where no harness parses the result.
   */
  const unrelatedScript = path.join(temp, 'unrelated-hook.js');
  fs.writeFileSync(unrelatedScript,
    "const fs = require('node:fs');\n"
    + "const path = require('node:path');\n"
    + "fs.appendFileSync(path.join(__dirname, 'unrelated-ran.txt'), 'the user\\'s own Stop hook ran\\n');\n");
  const UNRELATED = `node "${unrelatedScript}"`;
  const userDoc = {
    description: 'my own lifecycle hooks',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: UNRELATED, timeout: 5 }] }] },
  };
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  fs.writeFileSync(hooksFile, `${JSON.stringify(userDoc, null, 2)}\n`);
  const beforeSetup = fs.readFileSync(hooksFile, 'utf8');

  const readDoc = () => JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const stopHandlers = () => (readDoc().hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []);

  // ── H: the wiring ────────────────────────────────────────────────────────────────────────────
  const expectedCommand = `node "${CLI}" checkpoint`;
  const setup = canary(['setup', '--yes'], root);
  if (setup.status !== 0) showRun('canary setup --yes', setup);
  const canaryHandlers = () => stopHandlers().filter((h) => h.command === expectedCommand);

  check('H1-setup-installs-exactly-one-Canary-Stop-handler-into-.codex/hooks.json', () => {
    assert(setup.status === 0, `canary setup --yes exited ${setup.status}`);
    assert(fs.existsSync(hooksFile), '.codex/hooks.json was not written');
    assert(canaryHandlers().length === 1, `expected 1 Canary handler, found ${canaryHandlers().length}`);
    return JSON.stringify(canaryHandlers()[0]);
  });

  check('H2-the-handler-runs-the-ONE-checkpoint-entry-point-with-a-bounded-timeout-and-a-status-message', () => {
    const h = canaryHandlers()[0];
    assert(h !== undefined, 'no Canary handler to inspect');
    assert(h.type === 'command', `handler type is ${JSON.stringify(h.type)}`);
    assert(h.timeout === 1800, `timeout is ${JSON.stringify(h.timeout)} (seconds per the vendor schema)`);
    assert(typeof h.statusMessage === 'string' && h.statusMessage.length > 0, 'no statusMessage');
    return JSON.stringify(h);
  });

  check('H3-the-users-own-hooks-matcher-groups-and-top-level-keys-survive-untouched', () => {
    const doc = readDoc();
    assert(doc.description === userDoc.description, 'the top-level description changed');
    const kept = stopHandlers().find((h) => h.command === UNRELATED);
    assert(kept !== undefined && kept.timeout === 5 && kept.type === 'command', `the user's Stop handler changed: ${JSON.stringify(kept)}`);
    assert(Object.keys(doc).every((k) => k === 'description' || k === 'hooks'), `unexpected top-level key(s): ${Object.keys(doc).join(', ')}`);
    assert(beforeSetup !== fs.readFileSync(hooksFile, 'utf8'), 'the file was not actually modified — nothing was merged');
    return { unrelatedStop: kept, topLevelKeys: Object.keys(doc), stopHandlers: stopHandlers().length };
  });

  check('H4-setup-says-out-loud-that-Codex-will-not-run-the-hook-until-it-is-trusted', () => {
    const text = `${setup.stdout}${setup.stderr}`;
    assert(/will NOT run it until you review and trust it once/.test(text), 'the trust requirement is not disclosed');
    assert(/\/hooks/.test(text), "the vendor's review flow is not named");
    return text.split('\n').filter((l) => /trust/i.test(l)).join(' | ').slice(0, 240);
  });

  const afterFirst = fs.readFileSync(hooksFile, 'utf8');
  const setupAgain = canary(['setup', '--yes'], root);
  check('H5-a-second-setup-is-byte-identical-and-does-not-stack-a-second-handler', () => {
    assert(setupAgain.status === 0, `the second setup exited ${setupAgain.status}`);
    assert(fs.readFileSync(hooksFile, 'utf8') === afterFirst, 'the file changed on a re-run');
    assert(canaryHandlers().length === 1, `${canaryHandlers().length} Canary handlers after two setups`);
    return `${afterFirst.length} bytes before and after; ${stopHandlers().length} Stop handler(s) total`;
  });

  check('H6-canary-status-reports-the-wiring-sound-in-this-state', () => {
    const status = canary(['status'], root);
    assert(status.status === 0, `status exited ${status.status}: ${status.stdout}`);
    assert(/CONNECTED/.test(status.stdout), 'status does not report CONNECTED');
    return 'exit 0, CONNECTED';
  });

  check('H7-agents-reports-Codex-GATED-with-the-trust-step-on-the-same-row', () => {
    const agents = canary(['agents'], root);
    assert(agents.status === 0, `agents exited ${agents.status}: ${agents.stdout}`);
    assert(/GATED\s+OpenAI Codex CLI/.test(agents.stdout), 'Codex is not reported as GATED');
    assert(/hook installed here/.test(agents.stdout), 'the row does not say the hook is installed here');
    assert(/one-time review and trust/.test(agents.stdout), 'the row does not carry the trust step');
    return agents.stdout.split('\n').filter((l) => /Codex/.test(l)).join(' | ').slice(0, 300);
  });

  // ── P: the hook contract, driven the way the vendor documents it ─────────────────────────────
  const argv = canaryHandlers().length === 1 ? parseHookCommand(canaryHandlers()[0].command) : null;
  check('P0-the-recorded-command-parses-to-the-expected-argv', () => {
    assert(argv !== null, `the recorded command is not the expected shape: ${canaryHandlers()[0]?.command}`);
    assert(argv[1] === CLI && argv[2] === 'checkpoint', `parsed argv is ${JSON.stringify(argv)}`);
    return `${canaryHandlers()[0].command}  →  ${argv.join(' ')}`;
  });
  const hook = (event) => run(argv[0], argv.slice(1), root, { input: event, env: canaryEnv, timeout: 180_000 });
  const decisionOf = (r) => {
    const text = (r.stdout ?? '').trim();
    if (text === '') return null;
    try { return JSON.parse(text); } catch { return { __unparseable: text.slice(0, 200) }; }
  };

  const passRun = hook(stopEvent(root, false));
  const passDecision = decisionOf(passRun);
  check('P1-a-PASSING-sealed-plan-is-a-silent-allow-(exit-0, no block decision)', () => {
    assert(passRun.status === 0, `the hook exited ${passRun.status}: ${passRun.stderr}`);
    assert(passDecision === null || passDecision.decision !== 'block', `the hook blocked a passing plan: ${passRun.stdout}`);
    return { exit: passRun.status, stdout: `${passRun.stdout}`.trim().slice(0, 200) || '(silent)' };
  });

  // Flip the REAL check to red without touching the sealed script text: the block that follows can
  // only come from Canary's own execution of the project's check.
  fs.writeFileSync(path.join(root, 'state.json'), '{"ok": false}\n');
  const failRun = hook(stopEvent(root, false));
  const failDecision = decisionOf(failRun);
  check('P2-a-FAILING-sealed-plan-prints-a-parsed-block-decision-with-a-non-empty-reason', () => {
    assert(failRun.status === 0, `the hook exited ${failRun.status} (the Stop contract requires 0): ${failRun.stderr}`);
    assert(failDecision !== null && failDecision.decision === 'block', `parsed stdout was ${passRun.stdout === failRun.stdout ? '(same as the pass case)' : JSON.stringify(failDecision)}`);
    assert(typeof failDecision.reason === 'string' && failDecision.reason.length > 0, 'the reason is empty');
    // The whole model-visible decision is printed, so the raw shape is in the record rather than
    // summarised: `{"decision":"block","reason":"…"}`, exactly what the vendor documents.
    return JSON.stringify({ exit: failRun.status, stdout: `${failRun.stdout}`.trim().slice(0, 400) });
  });

  check('P3-the-block-came-from-the-FAILING-CHECK-not-from-authority-drift-or-an-unverified-path', () => {
    const reason = typeof failDecision?.reason === 'string' ? failDecision.reason : '';
    assert(/Canary verification failed/.test(reason), `the reason does not name the failing check: ${reason.slice(0, 200)}`);
    assert(/tests/.test(reason), 'the reason does not name the failing step');
    assert(!/authority changed|UNVERIFIED|not valid JSON/.test(reason), `the block came from an authority/corruption path: ${reason.slice(0, 200)}`);
    return reason.split('\n')[0].slice(0, 220);
  });

  const loopRun = hook(stopEvent(root, true));
  const loopDecision = decisionOf(loopRun);
  check('P4-the-loop-guard-stop_hook_active-must-NOT-block-again', () => {
    assert(loopRun.status === 0, `the hook exited ${loopRun.status}: ${loopRun.stderr}`);
    assert(loopDecision === null || loopDecision.decision !== 'block', `a continued turn was blocked AGAIN (a permanent loop): ${loopRun.stdout}`);
    return { exit: loopRun.status, decision: loopDecision?.decision ?? null, systemMessage: `${loopDecision?.systemMessage ?? ''}`.slice(0, 160) };
  });

  // ── E: one REAL `codex exec` session ─────────────────────────────────────────────────────────
  /**
   * TWO TRUST LAYERS, AND BOTH ARE NAMED RATHER THAN HIDDEN. MEASURED here, the hard way:
   *
   *  1. PROJECT trust. An untrusted project's `.codex/` layer is not loaded AT ALL — measured with a
   *     deliberately unwritable key (`model_provider = "…"`) in `<repo>/.codex/config.toml`: ignored
   *     silently until the project was trusted, then reported as an unsupported project-local key.
   *     The trust record is the vendor's own persisted user-config entry
   *     `[projects.'<lowercased path>'] trust_level = "trusted"`, and MEASURED: neither
   *     `-c projects.'<path>'.trust_level="trusted"` nor a `--profile` layer satisfies it (both were
   *     tried here, and the project layer stayed unloaded). So the probe writes that entry into an
   *     ISOLATED `CODEX_HOME` — a temp dir holding a copy of the operator's `auth.json` (deleted with
   *     the temp tree) — and touches nothing the operator owns.
   *  2. HOOK trust. `--dangerously-bypass-hook-trust` covers the per-hook review record, which is
   *     exactly the "automation that already vets hook sources" the flag is documented for.
   *
   * What the session therefore measures is the HARNESS honouring the hook. The trust UX itself (a
   * human clicking through project trust and `/hooks`) remains a named, unmeasured step, and the
   * capability table says so on the row.
   */
  const codex = resolveCodex();
  const userAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (codex === null) {
    skip('v14-end-to-end: no runnable codex CLI on this host — the `codex exec` session was NOT attempted, so nothing here measures a real session');
  } else if (!fs.existsSync(userAuth)) {
    skip(`v14-end-to-end: no Codex credentials at ${userAuth} — the \`codex exec\` session was NOT attempted (an unauthenticated run measures nothing)`);
  } else {
    console.log(`INFO codex entry point: ${codex.file}`);
    const version = run(codex.argv[0], [...codex.argv.slice(1), '--version'], temp, { timeout: 60_000 });
    console.log(`INFO version: ${`${version.stdout}${version.stderr}`.trim().split('\n')[0].slice(0, 80)}`);
    const codexHome = path.join(temp, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.copyFileSync(userAuth, path.join(codexHome, 'auth.json')); // removed with the temp tree
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `[projects.'${root.toLowerCase()}']\ntrust_level = "trusted"\n`);
    console.log(`INFO isolated CODEX_HOME: ${codexHome} (a copy of auth.json + the project-trust entry; the operator's own ~/.codex is not modified)`);
    // Canary's own records of the hook's previous runs are DELETED, so anything that exists
    // afterwards can only have been written by a hook invocation INSIDE the session that follows.
    const checkpointFile = path.join(root, '.canary', 'last-checkpoint.json');
    const evidenceDir = path.join(root, '.canary', 'evidence');
    try { fs.rmSync(checkpointFile, { force: true }); } catch { /* absent */ }
    try { fs.rmSync(evidenceDir, { recursive: true, force: true }); } catch { /* absent */ }
    const session = run(codex.argv[0], [
      ...codex.argv.slice(1), 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust',
      '-s', 'read-only', '-C', root, 'Reply with the single word OK.',
    ], root, {
      env: { ...process.env, CODEX_HOME: codexHome, CANARY_TRUST_STORE: store }, input: '', timeout: 300_000,
    });
    const sessionOut = `${session.stdout}${session.stderr}`;
    const turns = (sessionOut.match(/"type":"turn\.started"/g) ?? []).length;
    const hookRecord = fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : null;
    /**
     * HOW "THE SESSION CONTINUED" IS OBSERVED. The vendor's `Stop` contract continues the turn IN
     * PLACE ("automatically creates a new continuation prompt that acts as a new user prompt"), so
     * `turn.started` stays at 1 and the reason text is not echoed into the exec JSONL — MEASURED, and
     * the first version of this probe therefore reported a false failure. What IS observable is the
     * hook running TWICE: the second `Stop` happens only when the harness carried on after the first
     * one blocked, and it arrives with `stop_hook_active: true` (the loop guard the P4 case pins).
     * The probe counts Canary's own checkpoint bundles, which is evidence this product wrote.
     */
    const checkpointBundles = fs.existsSync(evidenceDir)
      ? fs.readdirSync(evidenceDir).filter((b) => b.endsWith('-checkpoint')).length : 0;
    const modelActedOnTheReason = /\.canary[\\/]evidence|tests\.log/.test(sessionOut);
    console.log(`INFO codex session: exit ${session.status}, ${turns} turn(s) started, checkpoint record ${hookRecord === null ? 'ABSENT' : `${hookRecord.status}/${hookRecord.source}`}, checkpoint bundles written DURING the session: ${checkpointBundles}`);
    console.log(`INFO the model acted on Canary's reason (it named Canary's evidence artifact): ${modelActedOnTheReason}`);
    console.log(`INFO the user's own Stop handler also ran in that session: ${fs.existsSync(path.join(temp, 'unrelated-ran.txt'))}`);
    for (const line of sessionOut.split('\n').filter((l) => /Canary|hook/i.test(l)).slice(0, 6)) console.log(`INFO session: ${line.slice(0, 220)}`);
    if (session.status === null) {
      skip('v14-end-to-end: the `codex exec` session did not finish within 300s on this host — the real-session measurement was NOT obtained');
    } else if (session.status !== 0) {
      skip(`v14-end-to-end: \`codex exec\` exited ${session.status} (not authenticated, or it refused to run unattended here) — the real-session measurement was NOT obtained`);
    } else {
      check('E1-the-real-codex-session-EXECUTED-Canarys-hook-(its-checkpoint-record-reappeared)', () => {
        assert(hookRecord !== null, 'no .canary/last-checkpoint.json appeared during the session — the hook did not run');
        assert(hookRecord.source === 'checkpoint', `the record was written by ${hookRecord.source}, not by a hook invocation`);
        return `${hookRecord.status} via ${hookRecord.source}`;
      });
      check('E2-the-session-CONTINUED-on-Canarys-decision-(the hook ran a SECOND time)', () => {
        assert(checkpointBundles >= 2, `the hook ran once (${checkpointBundles} checkpoint bundle(s)) — a stopped turn was not continued`);
        return { checkpointBundles, turns, reasonTextEchoedInJsonl: modelActedOnTheReason };
      });
    }
  }

  // ── H (cont.): removal ───────────────────────────────────────────────────────────────────────
  const uninstall = canary(['uninstall'], root);
  check('H8-uninstall-removes-exactly-the-Canary-handler-and-keeps-the-users-file', () => {
    assert(uninstall.status === 0, `uninstall exited ${uninstall.status}: ${uninstall.stdout}`);
    const remaining = stopHandlers();
    assert(remaining.length === 1 && remaining[0].command === UNRELATED, `Stop handlers after uninstall: ${JSON.stringify(remaining)}`);
    assert(fs.existsSync(hooksFile), 'the file the user owned was deleted');
    assert(readDoc().description === userDoc.description, 'a top-level key was lost by uninstall');
    return { exit: uninstall.status, remaining: remaining.map((h) => h.command) };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} v14 codex Stop hook — ${results.length - failed.length}/${results.length} observation(s) held${skips.length > 0 ? `, ${skips.length} explicit SKIP(s)` : ''}`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  if (skips.length > 0) {
    console.log('SKIP is never a PASS: the SKIP lines above name what this host could not reproduce.');
    process.exitCode = failed.length === 0 ? 3 : 1;
  } else {
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
