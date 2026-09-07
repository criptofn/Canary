// Local narrow PreToolUse policy wrapper for the HoldTheGoblin hook.
// Canonical tracked copy — the LIVE hook is ~/.claude/hooks/holdthegoblin-pretooluse-local.mjs
// and hook-policy-test.mjs asserts the two are byte-identical (drift = test FAIL).
//
// Why this exists: HoldTheGoblin's ASK rule (risk.js) flags ALL inline interpreter
// execution (node -e, python -c, ...) for human approval; it consults no config and no
// permissions.allow rules, so routine read-only analysis commands stall autonomous
// repo work. This wrapper unblocks exactly that class — and nothing else:
//   - PreToolUse + Bash + a command whose EVERY top-level segment is PROVABLY
//     read-only inline analysis (see policy below)  ->  local allow.
//   - anything else  ->  delegated UNMODIFIED to HoldTheGoblin's own hook handler
//     (cli.js), so every DENY/ASK rule (credential paths/literals, broad rm -rf,
//     force push, curl-pipe-shell, disk/shutdown, kubectl/terraform/deploy/publish,
//     DB mutation, sensitive file reads) stays fully enforced.
//
// Hardening history: the 2026-09-05 gate was `INLINE.test(cmd) && !DANGER.test(cmd)`
// — a single token scan. The GLM-5.3 decision-only probes self-allowed writes via
// fs.openSync(...,'w')/fs.cpSync/fs.rm, subprocess/os.system/exec/__import__,
// sockets, token-splitting and computed identifiers, and DESTRUCTIVE GIT riding
// `bash -c` payloads (git restore, git checkout --, git branch -D) — none of which
// were tokens in DANGER. The 2026-09-06 gate replaces "one regex says safe" with:
//   1) global danger scan over the entire command (superset of the old token list);
//   2) quote-aware top-level segmentation on && / || / ; / | — background &,
//      subshells, redirections, $ (expansions, backticks, globs and unbalanced
//      quotes make a command NON-ANALYZABLE => delegate);
//   3) EVERY segment must be an allowlisted read-only inline interpreter command
//      (node -e/-p/--eval/--print, python|python3 -c, bash|sh -c; payloads re-enter
//      the same gate; ruby/perl/php/zsh/fish are never allowed) or an allowlisted
//      read-only PLAIN command (version/help forms, coreutils reads; sort is out
//      because `sort -o` writes). Plain-only chains still delegate — this wrapper
//      only bypasses the inline-interpret ASK, never the normal permission flow.
//   4) payload scans: fs/os write+delete APIs, open() in any non-read mode,
//      subprocess/exec/eval family, sockets/network, dynamic-code and
//      token-splitting evasions (hex/unicode escapes, chr/fromCharCode/atob/
//      base64/fromhex, bracket-string indexing, adjacent string-literal
//      concatenation, globalThis/window computed indexing, getattr, Function/vm/
//      Reflect/Proxy/WebAssembly, --input-type/--inspect/--experimental).
// If certainty is impossible: delegate (false ASK beats false ALLOW).
// Fail-closed: malformed input, missing tool fields, or delegation failure => deny.
// Known ceiling (ponytail): token scan is a heuristic guardrail, not a sandbox;
// it refuses to allow anything it cannot analyze, so the residual risk of a missed
// dangerous token is an approval prompt, never autonomy for the payload.
// NOTE: literal dots inside the regexes below use [.] on purpose — a backslash-dot
// form would become a slash-dot path shape through toPosixPath and trip the very
// sensitive-file rule this wrapper defers to.
// KNOWN CEILING (2026-09-05): HoldTheGoblin's own DENY rule matches "[token].key"
// (also .pem/.p12/...) anywhere in a command, so an inline node -e snippet merely
// READING a property named .key is denied as a credential path. Do NOT widen this
// wrapper's allow class to cover such tokens: readFileSync('server.key') inside
// node -e would then self-allow. Probe code touching .key-shaped properties goes
// in a script FILE (not inline) and runs unimpeded — the path check is end-anchored.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CLI =
  'C:\\Users\\Johannes\\AppData\\Roaming\\npm\\node_modules\\holdthegoblin\\dist\\src\\cli.js';

function emit(permissionDecision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function delegate(raw) {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude'], {
    input: raw,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.error || (r.status === null && r.signal)) {
    // Fail closed: never let a broken delegation mean "no safety hook".
    emit('deny', 'HoldTheGoblin-local: policy wrapper failed to reach HoldTheGoblin; denying.');
  }
  if (!r.stdout && r.status !== 0) {
    // HTG exited in error without emitting a decision — treat as unreachable.
    emit('deny', 'HoldTheGoblin-local: HoldTheGoblin returned no decision; denying.');
  }
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------------------
// 1. Global danger scan — any match anywhere (payloads included) => delegate.
//    The 2026-09-05 token list first (kept verbatim, never weakened), then the
//    families the GLM probes rode through it. Built via new RegExp because a
//    /a/ + /b/ literal concatenation would silently produce a STRING, not a
//    regex — DANGER.test would crash and every hook call would deny.
// ---------------------------------------------------------------------------
const DANGER = new RegExp(
  String.raw`writeFile|appendFile|copyFile|renameSync|unlink|rmdir|rmSync|mkdir|truncate|createWriteStream|rm\s+-rf|\bdel\b|Remove-Item|child_process|execSync|spawnSync|\bspawn\b|\bfork\b|execFile|\beval\b|new Function|atob|from\([^)]*base64|--require|require\([^)]*(?:child_process|net|dns|http|fs[/\\]promises)|--import|import\s*\(|NODE_OPTIONS|\bnet\b|\bdns\b|\bhttp[s]?\b|fetch\(|XMLHttpRequest|createConnection|createServer|curl|wget|\bscp\b|ssh|npmrc|pypirc|netrc|[.]env|[.]aws|[.]gcloud|azure|gnupg|[.]ssh|id[_]rsa|id[_]ed25519|[.]pem|keystore|[.]key\b|[.]p12|[.]pfx|token|secret|password|credential|force-push|\bgit\b[^&|;]*\bpush\b|\breset\b[^&|;]*--hard|\bgit\b[^&|;]*\bclean\b|\bmkfs\b|\bdd\b|shutdown|reboot|\bformat\b|DROP\s+DATABASE` +
    String.raw`|authorized_keys|known_hosts|printenv|\benviron\b|subprocess|\bshutil\b|\bpty\b|\bctypes\b|\bpickle\b|\bmarshal\b|urllib|http[.]client|\bftplib|smtplib|xmlrpc|\bsocket\b|\brequests\b|\bhttpx\b|os\.[a-z_]*(?:system|popen|exec\w*|spawn\w*|remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|truncate|kill|startfile|chdir|chroot|fork|wait|write|link|symlink|putenv|unsetenv|chmod|chown)|__import__|importlib|\bgetattr\b|\bsetattr\b|\bdelattr\b|__builtins__|__subclasses__|globalThis\s*\[|window\s*\[|\bself\s*\[|String\.fromCharCode|\bfromCharCode|\bchr\s*\(|\bunescape\b|fromhex|unhexlify|b64decode|b64encode|\bcodecs\b|\\x[0-9a-fA-F]{2}|\\u00|WebAssembly|\bvm\.[A-Za-z]|\bReflect\s*\.|\bProxy\s*\(|\bFunction\s*\(|--input-type|--inspect|--experimental|\bcpSync\b|\bcopyFileSync\b|\brm\s*\(|\bmv\s*\(|\bwriteSync\b|writev|write_text|write_bytes|\bcopyfile|\btruncateSync\b|\bchownSync\b|\bchmodSync\b|\bsymlinkSync\b|\bmkdtemp|\bmkstemp`,
  'i',
);
// Git mutation verbs (restore/checkout/branch -D/switch/stash/...) never
// self-allow — read-side git stays delegated to HoldTheGoblin as before.
const GIT_MUTATION =
  /\bgit\b[^|;&\n]*(?:\b(?:push|reset|clean|restore|checkout|switch|stash|rebase|merge|commit|apply|cherry[\s-]?pick|tag|remote|filter-branch|worktree|update-ref|symbolic-ref|write-tree|prune|replace|notes|send-email|credential|mv|rm|am|gc)\b|branch\s+[-\w]*[dDx]\b|branch\s+--(?:delete|unset-upstream)|config\s+(?!--get))/i;

function globallyDangerous(cmd) {
  return DANGER.test(cmd) || GIT_MUTATION.test(cmd);
}

// ---------------------------------------------------------------------------
// 2. Quote-aware structure. scanTop returns the top-level segments (split on
//    &&, ||, ;, | with single/double quotes respected) or null when the
//    command contains anything whose shell semantics this policy refuses to
//    reason about (subshells, redirections, expansions, globs, backgrounding,
//    unbalanced quotes). Conservative by construction.
// ---------------------------------------------------------------------------
function scanTop(cmd) {
  if (cmd.length > 16000) return null;
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (q === '"') {
      if (c === '\\') {
        cur += c + (cmd[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '$' || c === '`') return null; // expands inside double quotes
      cur += c;
      if (c === '"') q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '&') {
      if (cmd[i + 1] === '&') {
        segs.push(cur);
        cur = '';
        i++;
        continue;
      }
      return null; // background operator
    }
    if (c === '|') {
      if (cmd[i + 1] === '|') {
        segs.push(cur);
        cur = '';
        i++;
        continue;
      }
      segs.push(cur);
      cur = '';
      continue;
    }
    if (c === ';') {
      segs.push(cur);
      cur = '';
      continue;
    }
    // every remaining metacharacter outside quotes => not analyzable
    if ('$`<>(){}*?!#\\~^\n\r[]'.includes(c)) return null;
    cur += c;
  }
  if (q) return null; // unbalanced quotes
  segs.push(cur);
  if (segs.length > 1 && segs.some((s) => s.trim() === '')) return null; // dangling operator
  return segs.map((s) => s.trim()).filter(Boolean);
}

function segTokens(seg) {
  const toks = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      has = true;
      continue;
    }
    if (q === '"') {
      cur += c;
      if (c === '\\') {
        cur += seg[++i] ?? '';
        continue;
      }
      if (c === '"') q = null;
      has = true;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) {
        toks.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += c;
    has = true;
  }
  if (q) return null;
  if (has) toks.push(cur);
  return toks;
}

const BARE = /^[\w@%+=:,./-]+$/; // unquoted plain word

// Fully one-quote-region token => its literal; anything else (bare word,
// quote-swapping concatenation like "a"'b'"c", mixed forms) => null.
function asQuoted(tok) {
  if (tok.length < 2) return null;
  const q = tok[0];
  if ((q !== "'" && q !== '"') || tok[tok.length - 1] !== q) return null;
  if (q === "'") return tok.slice(1, -1).includes("'") ? null : tok.slice(1, -1);
  let out = '';
  for (let i = 1; i < tok.length - 1; i++) {
    const c = tok[i];
    if (c === '\\') {
      out += tok[++i] ?? '';
      continue;
    }
    if (c === '"') return null; // quote closed early => concatenation form
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Inline payload policy. Runs over the UNQUOTED payload literal.
// ---------------------------------------------------------------------------
const PAYLOAD_DANGER = new RegExp(
  // writes / deletes / modes:
  String.raw`writeFile|appendFile|copyFile|\bcp\s*\(|\bmv\s*\(|\.rename\s*\(|renameSync|\brmdir|\bunlink|mkdir|truncate|symlink|\blink\s*\(|chmod|chown|utimes|mkdtemp|mkstemp|createWriteStream|\bwriteSync\b|writev|write_text|write_bytes|\bwrite\s*\(|\btouch\b|\bos\.remove` +
    // subprocess / exec / dynamic code:
    String.raw`|subprocess|\bos\.(?:system|popen|exec\w*|spawn\w*|startfile|kill|killpg|chdir|chroot)|\bexec\s*\(|\bcompile\s*\(|__import__|importlib|\bgetattr\b|\bsetattr\b|\bdelattr\b|__builtins__|__subclasses__|\bvars\s*\(|globalThis\s*\[|window\s*\[|\bFunction\s*\(|\bvm\.[A-Za-z]|WebAssembly|\bReflect\s*\.|\bProxy\s*\(|\brequire\s*\(\s*(?![.'"])` +
    // network:
    String.raw`|\bsocket\b|\bconnect\s*\(|\.listen\s*\(|\.bind\s*\(|createSocket|XMLHttpRequest|\brequests\b|urllib|http\.client|\bfetch\s*\(` +
    // token-splitting / encoding evasions (adjacent literal concat via lookahead;
    // empty literals '' are NOT adjacency):
    // (bracket-string-index = computed member access only: preceded by an
    // identifier/`)`/`]`; an array literal `[ 'a', 'b' ]` after = , ( is fine)
    String.raw`|\\x[0-9a-fA-F]{2}|\\u00|\bchr\s*\(|fromCharCode|\batob\b|\bunescape\b|fromhex|unhexlify|b64decode|\bhex\b|(?<=[\w)\]])\[\s*['"][A-Za-z_]` +
    String.raw`|(['"])[^'"\n]+\1\s*(?=['"])` +
    // GLM M0.5 (panel-hardened 2026-09-07): string-assembly evasions in the
    // payload. '+'-joined literals are adjacency with an operator between the
    // pieces, and any COMPUTED MEMBER whose key is not digit-led can dispatch
    // an assembled name at runtime (fs[f], fs[f[0]+f[1]], fs[`${a}${b}`],
    // fs[('w').concat('riteFile')], fs[['wr','ite'].join('')]). Listing only
    // OPERATORS proved bypassable three ways (panel-confirmed); the sound rule
    // is structural:
    //   1) any string/template literal operand of a + => computed string
    //      (catches 'write'+'File', 'wri'+t, t+'ile', `write`+`File`);
    //      arithmetic `1+1` and compound `s += 'x'` (+ then =) are unaffected;
    //   2) after an identifier/`)`/`]`, a `[` whose key does not start with a
    //      digit or minus => dangerous. Only digit-led keys cannot name a
    //      method, so pure-numeric indexing (arr[0+1], argv[2], arr[-1])
    //      stays analyzable read-only.
    // Cost: 'msg: '+x and obj[someVar] inside a payload now delegate (ASK).
    // Ambiguous => ASK is the standing rule; false prompts beat false
    // autonomy. \x60 = backtick written without a raw backtick so the
    // enclosing template stays lexable.
    String.raw`|['"\x60]\s*\+|\+\s*['"\x60]|(?<=[\w)\]])\[\s*(?![\d-])` +
    // loader / inspector flags:
    String.raw`|--input-type|--inspect|--experimental|NODE_OPTIONS|process\.binding|process\.dlopen`,
  'i',
);

// open()/openSync() in any mode that is not provably a plain read mode.
const OPEN_ANY = /\bopen(?:Sync|AsPromise)?\s*\(/i;
const OPEN_SAFE_KNOWN = /\bopen(?:Sync|AsPromise)?\s*\(\s*[^,()]+,\s*['"](?:r|rb|br|rt|tr)['"]\s*(?:,[^,()]*)?\)/gi;
const OPEN_SAFE_DEFAULT = /\bopen(?:Sync|AsPromise)?\s*\(\s*[^,()]+\)/gi; // flags default to 'r'
function openDanger(p) {
  const s = p.replace(OPEN_SAFE_KNOWN, '(0)').replace(OPEN_SAFE_DEFAULT, '(0)');
  return OPEN_ANY.test(s);
}

function payloadProvableReadOnly(p) {
  if (!p.trim()) return false;
  return !PAYLOAD_DANGER.test(p) && !openDanger(p);
}

// ---------------------------------------------------------------------------
// 4. Segment classification: 'inline' | 'plain' | null (unsafe/unanalyzable).
// ---------------------------------------------------------------------------
const INTERP = {
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  bash: ['-c'],
  sh: ['-c'],
};
// ruby/perl/php/zsh/fish deliberately ABSENT: their inline forms never self-allow.

// read-only PLAIN commands usable bare or as chain segments; version/help forms.
const PLAIN = new Set([
  'pwd', 'echo', 'printf', 'true', 'ls', 'dir', 'cat', 'head', 'tail', 'nl', 'tac',
  'rev', 'wc', 'grep', 'rg', 'cut', 'uniq', 'basename', 'dirname', 'realpath',
  'date', 'whoami', 'id', 'du', 'df', 'file', 'stat', 'strings', 'cmp', 'diff',
  'seq', 'which', 'whereis', 'comm',
]);
// 'sort' excluded: `sort -o FILE` writes. 'tee','find','sed','awk','xargs','env',
// 'make' excluded: write/exec/read-environment capabilities.
const PLAIN_FLAG_DENY = { date: /^-s$|^--set$/ };
const VERSIONISH = {
  node: ['--version', '-v', '--help'],
  python: ['--version', '--help'],
  python3: ['--version', '--help'],
  npm: ['--version', '-v', '--help', '-h'],
  npx: ['--version'],
  git: ['--version', '-v', '--help', '-h', 'version'],
};

function plainSeg(toks) {
  const name = toks[0];
  if (!BARE.test(name)) return false;
  if (PLAIN.has(name)) {
    const deny = PLAIN_FLAG_DENY[name];
    for (let k = 1; k < toks.length; k++) {
      const t = toks[k];
      if (deny && BARE.test(t) && deny.test(t)) return false;
      if (BARE.test(t)) continue;
      const lit = asQuoted(t); // quoted plain argument (e.g. a grep pattern)
      if (lit === null || /[|&;<>()$`\\'"\n]/.test(lit)) return false;
    }
    return true;
  }
  const ok = VERSIONISH[name];
  if (!ok) return false;
  if (name === 'git' && toks[1] === 'config') {
    // `git config --get <key>` only.
    return toks.length === 4 && toks[2] === '--get' && toks.slice(1).every((t) => BARE.test(t));
  }
  return toks.length === 2 && ok.includes(toks[1]);
}

function classifySeg(seg, depth) {
  const toks = segTokens(seg);
  if (!toks || !toks.length) return null;
  const prog = toks[0];
  const flags = INTERP[prog];
  if (flags) {
    if (!BARE.test(prog)) return null;
    let fi = -1;
    for (let k = 1; k < toks.length; k++) {
      if (flags.includes(toks[k])) {
        fi = k;
        break;
      }
    }
    // No inline flag: still possibly an allowlisted plain form (`node --version`);
    // `node script.js`, `python -m x`, `bash script.sh` fail plainSeg and delegate.
    if (fi < 0) return plainSeg(toks) ? 'plain' : null;
    if (depth > 4) return null;
    // payload = the token right after the flag; anything after it = positional
    // args which must be plain bare words.
    const lit = asQuoted(toks[fi + 1] ?? '');
    if (lit === null) return null;
    for (let k = fi + 2; k < toks.length; k++) if (!BARE.test(toks[k])) return null;
    if (prog === 'bash' || prog === 'sh') return bashPayloadReadOnly(lit, depth + 1) ? 'inline' : null;
    return payloadProvableReadOnly(lit) ? 'inline' : null;
  }
  return plainSeg(toks) ? 'plain' : null;
}

function bashPayloadReadOnly(p, depth) {
  const segs = scanTop(p);
  if (!segs || !segs.length) return false;
  for (const s of segs) {
    if (!classifySeg(s, depth)) return false;
  }
  return segs.length > 0;
}

// ---------------------------------------------------------------------------
// 5. Decision.
// ---------------------------------------------------------------------------
function provableReadOnlyAnalysis(cmd) {
  if (globallyDangerous(cmd)) return false;
  const segs = scanTop(cmd);
  if (!segs || !segs.length) return false;
  let inline = 0;
  for (const s of segs) {
    const kind = classifySeg(s, 0);
    if (!kind) return false;
    if (kind === 'inline') inline++;
  }
  // At least one segment must actually be an inline interpreter command:
  // plain commands never bypass HoldTheGoblin / the normal permission flow.
  return inline >= 1;
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  emit('deny', 'HoldTheGoblin-local: cannot read hook stdin; denying.');
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  delegate(raw); // HoldTheGoblin handles malformed input its own way (deny).
}

if (
  input?.hook_event_name === 'PreToolUse' &&
  input?.tool_name === 'Bash' &&
  typeof input?.tool_input?.command === 'string' &&
  provableReadOnlyAnalysis(input.tool_input.command)
) {
  emit(
    'allow',
    'HoldTheGoblin-local: provably read-only inline analysis command (every segment allowlisted; no write/exec/network/git-mutation/evasion tokens); HoldTheGoblin ASK rule not applicable.',
  );
}

delegate(raw);
