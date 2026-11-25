'use strict';

/**
 * Environment variables that make a program, or the interpreter it starts, load code or files of the caller's choosing:
 * the dynamic loader and C library (every LD_* and DYLD_*, GCONV_PATH, GLIBC_TUNABLES, OPENSSL_CONF ...) and interpreter
 * start-up options (NODE_OPTIONS=--require or --import, NODE_PATH, PYTHONPATH, PERL5OPT, JAVA_TOOL_OPTIONS, BASH_ENV ...).
 *
 * One list for every place zn starts a program with someone else's environment, so they cannot drift apart:
 *  - `zn run` drops them when it hands secret values to the approved program (broker/run.js);
 *  - the hook launchers (the sh script and the Windows PowerShell command in launcher.js) and the OpenCode plugin
 *    drop them before they start Node.js: a project can set the environment of the agent, and a NODE_OPTIONS=--require
 *    would run code inside the hook itself, where it could answer for the hook.
 *
 * Kept on purpose: NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and the proxy variables. They add trust or route traffic, load no
 * code, and corporate networks need them.
 */

const LOADER_PREFIXES = ['LD_', 'DYLD_'];
// The variables that load a library into a program, or choose where it looks for one, before its first line runs (the shell of a hook
// launcher included): a script cannot undo them once it runs, so a launcher that finds one set refuses to answer.
// From ld.so(8) (glibc), ld-elf.so.1(1) (FreeBSD) and dyld(1) (macOS): the variables that load a library or change what the program
// does before its first line (a preload, an audit library, a trace or debug mode that ends the program). A launcher that finds one set
// refuses to answer, because it cannot undo them from inside the script.
const LOADER_PRELOAD = [
  'LD_PRELOAD', 'LD_AUDIT', 'LD_PROFILE', 'LD_LIBMAP', 'LD_32_PRELOAD',
  // A trace or the debug help: glibc's ld.so ends the shell with status 0 before the script runs for LD_TRACE_LOADED_OBJECTS (any value)
  // and for LD_DEBUG=help, so the refusal below cannot fire for them (docs/threat-model.md, accepted limits; `zn audit` reports a project
  // that sets them). The _FMT1, _FMT2 and _ALL forms act only with FreeBSD's loader; LD_DEBUG without "help" and LD_DEBUG_OUTPUT only log.
  'LD_TRACE_LOADED_OBJECTS', 'LD_TRACE_LOADED_OBJECTS_FMT1', 'LD_TRACE_LOADED_OBJECTS_FMT2', 'LD_TRACE_LOADED_OBJECTS_ALL', 'LD_DEBUG', 'LD_DEBUG_OUTPUT',
  'LD_PRELOAD_FDS', 'LD_LIBMAP_DISABLE', 'LD_LOADFLTR',
  'DYLD_INSERT_LIBRARIES', 'DYLD_IMAGE_SUFFIX', 'DYLD_SHARED_CACHE_DIR', 'DYLD_SHARED_REGION',
];
// Library search path variables: they only say where libraries are looked for, and many people set them (CUDA, vendor tools), so a launcher
// that finds one does not refuse; it removes them for the hook it starts, like the interpreter variables.
const LOADER_LIBPATH = [
  'LD_LIBRARY_PATH', 'LD_LIBRARY_PATH_FDS', 'LD_ORIGIN_PATH', 'LD_32_LIBRARY_PATH', 'LD_ELF_HINTS_PATH',
  'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_VERSIONED_LIBRARY_PATH', 'DYLD_VERSIONED_FRAMEWORK_PATH', 'DYLD_ROOT_PATH',
];
const LOADER_NAMES = [
  'GCONV_PATH', 'GLIBC_TUNABLES', 'LOCPATH', 'NLSPATH', 'HOSTALIASES', 'RES_OPTIONS', 'OPENSSL_CONF',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_V8_COVERAGE',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT', 'PYTHONUSERBASE', 'PERL5OPT', 'PERL5LIB', 'PERLLIB',
  'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'BASH_ENV', 'ENV',
];

// The names are plain (letters, digits and _), so they need no escaping in a regular expression or a shell pattern.
const LOADER_SOURCE = '^(' + LOADER_PREFIXES.join('|') + ')|^(' + LOADER_NAMES.join('|') + ')$';

// Case is ignored: Windows reads environment names without regard to case.
const LOADER_VAR = new RegExp(LOADER_SOURCE, 'i');

function isLoaderVar(name) {
  return LOADER_VAR.test(String(name));
}

/** The loader variables set (to any value, also empty) in an environment object, sorted. */
function loaderVarsIn(env) {
  return Object.keys(env || {}).filter(isLoaderVar).sort();
}

/** A copy of the environment object without the loader variables. */
function withoutLoaderVars(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!isLoaderVar(k)) out[k] = v;
  return out;
}

// The names the fast scrub unsets: the list above, the loader variables the launchers refuse (LOADER_PRELOAD) and the other
// named ld.so and dyld settings.
const SH_UNSET_NAMES = [...new Set([...LOADER_NAMES, ...LOADER_PRELOAD, ...LOADER_LIBPATH, 'LD_BIND_NOW', 'LD_BIND_NOT', 'LD_DYNAMIC_WEAK',
  'LD_USE_LOAD_BIAS', 'LD_HWCAP_MASK', 'LD_WARN', 'LD_SHOW_AUXV', 'LD_ASSUME_KERNEL', 'LD_PROFILE_OUTPUT',
  'LD_PREFER_MAP_32BIT_EXEC', 'DYLD_FORCE_FLAT_NAMESPACE', 'DYLD_BIND_AT_LAUNCH', 'DYLD_NO_FIX_PREBINDING', 'DYLD_PRINT_LIBRARIES'])];

// A shell pattern that matches a name in any case: NODE_PATH -> [Nn][Oo][Dd][Ee]_[Pp][Aa][Tt][Hh].
const anyCase = (s) => s.replace(/[A-Za-z]/g, (c) => '[' + c.toUpperCase() + c.toLowerCase() + ']');

/**
 * Lines of POSIX sh that remove the loader variables from the script's environment, using shell built-ins only (the PATH of
 * a hook can be empty). The names are unset outright, then every exported name is read back from `export -p` and the ones
 * that match (in any case: Git Bash passes Windows names through as they were written) are unset too, which also covers
 * every LD_* and DYLD_* name. A value that spans lines can only add a name that matches the list, never keep one.
 */
function shScrubLines(opts = {}) {
  // fast: only the names listed here are unset, with `unset` alone: no `export -p`, no subshell and no loop over the whole environment
  // (that scan costs a measurable part of the start of every hook). It leaves the other LD_ and DYLD_ names (LD_DEBUG, LD_BIND_NOW ...)
  // and the same names written in another case, which only a Windows program reads that way, so it is for sh on Linux and macOS.
  if (opts.fast) {
    return [
      '# Variables that make Node.js or the dynamic loader load code of the caller\'s choosing (NODE_OPTIONS=--require, LD_PRELOAD and the',
      '# like) are removed before anything is started: a project can set the environment of the agent. NODE_EXTRA_CA_CERTS and the proxy settings stay.',
      'unset ' + SH_UNSET_NAMES.join(' '),
    ];
  }
  const pattern = [...LOADER_PREFIXES.map((p) => anyCase(p) + '*'), ...LOADER_NAMES.map(anyCase)].join('|');
  return [
    '# Variables that make Node.js or the dynamic loader load code of the caller\'s choosing (NODE_OPTIONS=--require, LD_PRELOAD and the',
    '# like) are removed before anything is started: a project can set the environment of the agent. NODE_EXTRA_CA_CERTS and the proxy settings stay.',
    'unset ' + LOADER_NAMES.join(' '),
    'set -f; IFS=\'',
    '\'; for ZN_V in $(export -p); do ZN_V=${ZN_V#export }; ZN_V=${ZN_V#declare -x }; ZN_V=${ZN_V%%=*}; ' +
      'case $ZN_V in ""|*[!A-Za-z0-9_]*) ;; ' + pattern + ') unset "$ZN_V" ;; esac; done; unset IFS ZN_V; set +f',
  ];
}

// The names of the list that make `node <script>` load code on Windows: NODE_OPTIONS (--require, --import), NODE_PATH
// (where a bare require is looked up) and OPENSSL_CONF (an OpenSSL engine is a DLL). The dynamic loader and C library
// settings (LD_*, DYLD_*, GCONV_PATH ...) do not exist there; NODE_REPL_EXTERNAL_MODULE acts only when Node.js starts a
// REPL, and NODE_V8_COVERAGE only names where coverage files go. The Windows launcher is one command line of at most 8191
// characters, so it carries only these.
const WINDOWS_NAMES = ['NODE_OPTIONS', 'NODE_PATH', 'OPENSSL_CONF'];
if (!WINDOWS_NAMES.every((n) => LOADER_NAMES.includes(n))) throw new Error('zn: the Windows loader names must come from the list');

/**
 * PowerShell that removes the loader variables from the process environment before Node.js starts (the children inherit
 * it). Setting an environment variable to $null removes it; no cmdlet is used (see the note on ZF in launcher.js), and
 * Windows names ignore case, so this also removes node_options.
 */
function psScrub() {
  return WINDOWS_NAMES.map((n) => '$env:' + n + '=$null; ').join('');
}

/**
 * Whether one environment variable, set for the agent, makes glibc's dynamic loader end every dynamically linked program before its
 * first line: LD_TRACE_LOADED_OBJECTS (to any value, even empty) or LD_DEBUG naming "help". The shell that runs a hook is such a program,
 * so each hook exits 0 having checked nothing. The one definition, used by `zn audit` (ZNA008) and by the checks on writes.
 */
function isHookStopVar(key, value) {
  return String(key) === 'LD_TRACE_LOADED_OBJECTS' || (String(key) === 'LD_DEBUG' && /(?:^|[\s,:])help(?:$|[\s,:])/.test(String(value)));
}

// NAME=value as it is written in a .env file, in a shell command (echo, printf, tee, sed, a heredoc, `$env:NAME='x'`) or in a patch, and
// NAME: value (the dotenv package reads that form too, with a space after the colon). The captured value is quoted, or runs to the end of the line or to a shell separator,
// a sed slash or a closing bracket; it is only where the checks below start. Whether a write stops the hooks is decided on everything the
// value can run over (valueSpan), not on this capture. A bare NAME with no "=" sets nothing.
const HOOK_STOP_ASSIGNMENT_RE = /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(LD_TRACE_LOADED_OBJECTS|LD_DEBUG)(?![A-Za-z0-9_])["']?[ \t]*(?:=|:(?=[ \t]))[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\n"';&|/\\)}]*))?/g;

// glibc splits LD_DEBUG at spaces, commas and colons and acts on an option that reads exactly "help". A write is judged more widely:
// "help" with no letter, digit or _ on either side, once quotes and backslashes are removed. A value that a file reader or the shell cuts
// in another place than a regular expression would (x/,help, libs},help, help>>.env, "all" help) is then never taken as safe. This can
// refuse a value glibc would ignore (/opt/help); it never allows one glibc acts on.
const HELP_WORD_RE = /(?:^|[^A-Za-z0-9_])help(?![A-Za-z0-9_])/;

/**
 * The text a written value can run over, from just after the "=" of the assignment:
 * - in a file (.env, a patch, an edit): to the end of the line or, when the value opens with a quote, to the end of the line where that
 *   quote closes (the dotenv package reads a quoted value over several lines; an unclosed quote runs to the end of the text);
 * - in a shell command: to the end of the command. Quotes and line breaks inside one shell word are not tracked, so all the rest counts.
 */
function valueSpan(s, from, shell) {
  const rest = s.slice(from);
  if (shell) return rest;
  const q = /^[ \t]*(["'`])/.exec(rest);
  let start = 0;
  if (q) {
    const close = quoteClose(rest, q[0].length, q[1]);
    if (close < 0) return rest;
    start = close + 1;
  }
  const eol = rest.slice(start).search(/[\n\r]/);
  return eol < 0 ? rest : rest.slice(0, start + eol);
}

/**
 * Index of the quote that closes a quoted value in a .env file, searching from `from` (just after the opening quote), or -1. The npm dotenv
 * package matches a quoted value as (?:\\Q|[^Q])* for all three quote characters, so a backslash before the quote character keeps the
 * value open, in single quotes and backticks too, whatever precedes that backslash. Its regular expression can also backtrack and close
 * at such a quote, so the value may be shorter than this scan says; the caller checks everything up to this index and to the end of its
 * line, which covers both readings. One forward pass.
 */
function quoteClose(text, from, quote) {
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '\\' && text.charAt(i + 1) === quote) { i++; continue; }
    if (c === quote) return i;
  }
  return -1;
}

/** Whether the value of a file assignment opens a quote that nothing closes: unresolved, so an LD_DEBUG write is refused. */
function unterminatedQuote(s, from) {
  const rest = s.slice(from);
  const q = /^[ \t]*(["'`])/.exec(rest);
  return !!q && quoteClose(rest, q[0].length, q[1]) < 0;
}

/**
 * Whether an assignment found in written text may stop the hooks: LD_TRACE_LOADED_OBJECTS to anything, or LD_DEBUG when "help" can be
 * one of its options (HELP_WORD_RE over the span; an escape such as \n counts as a break). In a file, an LD_DEBUG value that refers to
 * a variable ($X, ${X}) is refused too, because a loader that expands it would write a value the text does not show.
 */
function writtenValueStopsHooks(key, span, shell) {
  if (key === 'LD_TRACE_LOADED_OBJECTS') return true;
  if (key !== 'LD_DEBUG') return false;
  const plain = String(span).replace(/\\[nrt]/g, ' ').replace(/["'`\\]/g, '');
  return HELP_WORD_RE.test(plain) || (!shell && /\$/.test(String(span)));
}

// Index of the first character after the "=" (or ":") of a match of HOOK_STOP_ASSIGNMENT_RE.
const valueStart = (m) => m.index + m[0].search(/[=:]/) + 1;

/** The name of the first variable in `text` that is assigned a value that stops the hooks (see isHookStopVar), or null. */
function hookStopAssignedIn(text) {
  const s = String(text);
  if (!s.includes('LD_')) return null;
  HOOK_STOP_ASSIGNMENT_RE.lastIndex = 0;
  let m;
  while ((m = HOOK_STOP_ASSIGNMENT_RE.exec(s))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] || '');
    if (isHookStopVar(m[1], value) || writtenValueStopsHooks(m[1], valueSpan(s, valueStart(m), false), false) ||
      (m[1] === 'LD_DEBUG' && unterminatedQuote(s, valueStart(m)))) return m[1];
  }
  return null;
}

// A value is proven safe only when it holds nothing the shell or printf would expand ($NAME, ${..}, $(..), `..`, $((..)), %s, a backslash,
// an adjacent quote that glues pieces together): what such a value becomes is not known until it runs. An unquoted value runs to the end of the
// line, so what follows it (a redirection, more words) is part of what is checked.
const COMPUTED_VALUE_RE = /[$`\%]/;

// The two names as whole words, also right after a \n, \r or \t escape inside a printf or echo -e string.
const HOOK_STOP_NAME_RE = /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(LD_TRACE_LOADED_OBJECTS|LD_DEBUG)(?![A-Za-z0-9_])/g;
// A shell or printf expansion: $NAME, ${..}, $(..), `..`, or a printf conversion such as %s or %-10s.
const EXPANSION_SRC = String.raw`(?:\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!$-]|` + '`[^`]*`' + String.raw`|%[-#0 +']*[0-9*]*(?:\.[0-9*]+)?[a-zA-Z])`;
// A variable name the shell or printf computes: an expansion right before "=" (echo "$K=$V", printf '%s=%s').
const COMPUTED_NAME_RE = new RegExp(EXPANSION_SRC + '[ \\t]*=');
// A piece of one of the two names glued to an expansion: L$X, LD_${N}, %s_DEBUG, $(echo L)D_DEBUG.
// Brace expansion and globs build names too: LD_{DEBUG,X}=help, {LD,X}_DEBUG=help, LD_DEBU?=help.
const NAME_PIECE_RE = new RegExp(String.raw`(?<![A-Za-z0-9_])(?:L|LD|LD_[A-Z_]*)(?=[$` + '`' + String.raw`%{?*[])|(?:` + EXPANSION_SRC +
  String.raw`|[},\]?*])(?:[A-Z_]*(?:UG|CTS))(?![A-Za-z0-9_])`);
// A printf or echo -e escape that writes a character by its code (\x4c, \114, L, \cX): the text does not show the character.
const CODE_ESCAPE_RE = /\\(?:x[0-9A-Fa-f]|[0-7]|u[0-9A-Fa-f]|U[0-9A-Fa-f])/;
// Programs and quoting that turn such escapes into characters: printf, echo -e and $'..'.
const ESCAPE_WRITER_RE = /(?<![A-Za-z0-9_-])printf(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_-])echo[ \t]+-[A-Za-z]*e|\$'/;
// For each position of `s`, how the shell reads it, in one forward pass with POSIX quoting rules: 0 = live text, 1 = quoted or
// backslash-escaped (never a glob), 2 = inside a comment. Among the quoted positions, 3 marks the ones the shell also never expands
// ($ and ` there are plain characters): inside single quotes or $'..', and the character after an escaping backslash. Outside quotes a
// backslash escapes the next character and `#` at the start of a word begins a comment up to the line end; inside single quotes nothing
// is special; inside double quotes a backslash escapes only $ ` " \ and a line break; $'..' is quoted and a backslash escapes inside it.
// `bad` is set when the text uses syntax this scan does not model (an unterminated quote, a here-document), and callers fail closed.
function quoteMap(s) {
  const inside = new Uint8Array(s.length + 1);
  let q = ''; // '', "'", '"' or 'a' for $'..'
  let bad = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (q === "'") { inside[i] = c === "'" ? 1 : 3; if (c === "'") q = ''; continue; }
    if (q === 'a') {
      inside[i] = c === "'" ? 1 : 3;
      if (c === '\\') { i++; if (i < s.length) inside[i] = 3; } else if (c === "'") q = '';
      continue;
    }
    if (q === '"') {
      inside[i] = 1;
      if (c === '\\') { const n = s.charAt(i + 1); if (n && '$`"\\\n'.includes(n)) { i++; inside[i] = 3; } } else if (c === '"') q = '';
      continue;
    }
    if (c === '\\') { inside[i] = 1; i++; if (i < s.length) inside[i] = 3; continue; }
    if (c === "'" || c === '"') { inside[i] = 1; q = c; continue; }
    if (c === '$' && s.charAt(i + 1) === "'") { inside[i] = 1; i++; inside[i] = 1; q = 'a'; continue; }
    if (c === '#' && (i === 0 || /[\s;&|()<>]/.test(s.charAt(i - 1)))) {
      while (i < s.length && s.charAt(i) !== '\n') { inside[i] = 2; i++; }
      // Shells end a comment at the line break even after a backslash; we refuse this form anyway because it is ambiguous to
      // readers and never needed to write a .env.
      if (i < s.length && s.charAt(i - 1) === '\\') bad = true;
      i--; // the line break itself is live text again
      continue;
    }
    if (c === '<' && s.charAt(i + 1) === '<' && s.charAt(i + 2) !== '<' && s.charAt(i - 1) !== '<') bad = true; // here-document
  }
  if (q) bad = true;
  inside.bad = bad;
  return inside;
}
// Whether the shell word that starts at `from` holds a glob character (* ? [ {) outside quotes. `inside` is quoteMap(s).
function unquotedGlobIn(s, from, inside) {
  for (let i = from; i < s.length; i++) {
    if (inside[i]) continue; // quoted, escaped or inside a comment
    const c = s.charAt(i);
    if (/[\s;&|<>]/.test(c)) return false;
    if (/[*?\[{]/.test(c)) return true;
  }
  return false;
}
const COMPUTED_NAME = 'a variable whose name the shell computes (it could be LD_DEBUG or LD_TRACE_LOADED_OBJECTS)';

/**
 * Like hookStopAssignedIn, for a shell command that writes a dotenv file: the command text is not what ends up in the file once the
 * shell has expanded it. Fails closed: also returns a name when a write cannot be shown to be plain literal text, namely when
 * - LD_DEBUG or LD_TRACE_LOADED_OBJECTS is assigned a value that is not plain literal text (a variable, a command substitution,
 *   arithmetic, quoting tricks, a printf format), because it could expand to help;
 * - one of the two names appears other than as such a literal assignment: as a printf argument (printf '%s=%s' LD_DEBUG help), or
 *   once quotes and backslashes are removed ('LD_'"DEBUG"=help, L\D_DEBUG=help);
 * - a name is computed by the shell or printf ("$K=$V", printf '%s=%s'), or a piece of one of the two names is glued to an expansion
 *   (LD_${N}=help, %s_DEBUG).
 */
function hookStopOrComputedIn(text) {
  const s = String(text);
  // What the shell leaves once quotes and backslashes are gone (an escape such as \n is a line break in printf and echo -e).
  const flat = s.replace(/\\[nrt]/g, '\n').replace(/["'\\]/g, '');
  const count = (t) => { HOOK_STOP_NAME_RE.lastIndex = 0; return (t.match(HOOK_STOP_NAME_RE) || []).length; };
  if (COMPUTED_NAME_RE.test(flat) || NAME_PIECE_RE.test(flat) || (CODE_ESCAPE_RE.test(s) && ESCAPE_WRITER_RE.test(s))) return COMPUTED_NAME;
  if (!flat.includes('LD_')) return null;
  HOOK_STOP_ASSIGNMENT_RE.lastIndex = 0;
  let m;
  let literal = 0;
  let inside = null; // quote state of every position, computed once and only when a loader assignment is found
  while ((m = HOOK_STOP_ASSIGNMENT_RE.exec(s))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] || '');
    if (isHookStopVar(m[1], value) || writtenValueStopsHooks(m[1], valueSpan(s, valueStart(m), true), true)) return m[1];
    const end = m.index + m[0].length;
    const next = s.charAt(end);
    const before = s.charAt(m.index - 1);
    // Where the word ends: whitespace, a separator, a redirection or the end. A quote that closes the quote the assignment sits in
    // ('LD_DEBUG=all') ends it too. Anything else touching the value (he"lp", "he"lp, 'he'"lp", a backslash or bracket) glues more text
    // to it, so the value as written is not the value that results.
    const atEnd = (c) => c === '' || /[\s;&|<>)]/.test(c);
    const wordEnds = (i) => atEnd(s.charAt(i)) || ((s.charAt(i) === '"' || s.charAt(i) === "'") && before === s.charAt(i) && atEnd(s.charAt(i + 1)));
    let glued;
    if (m[2] !== undefined || m[3] !== undefined) glued = !wordEnds(end); // the closing quote of the value is already inside the match
    else glued = /["'\\)}]/.test(next) && !((next === '"' || next === "'") && before === next && atEnd(s.charAt(end + 1)));
    // An unquoted glob (he*p, he?p, he[l]p, he{l,x}p) expands to a file name in the project, so the value is not what is written.
    // Each glob character is judged by the quote state at its own position: a quoted prefix does not protect an unquoted glob after it
    // ("LD_DEBUG="he*p), and a glob inside quotes ('LD_DEBUG=he*p') is not expanded.
    if (!inside) inside = quoteMap(s);
    if (inside.bad) return m[1]; // syntax the scan does not model: fail closed
    const globbed = unquotedGlobIn(s, valueStart(m), inside);
    if (glued || globbed || COMPUTED_VALUE_RE.test(value)) return m[1];
    literal++;
  }
  // Every time one of the two names appears, in the text as written and once quotes are removed, it is a literal assignment checked above.
  const named = count(s);
  if (named > literal || count(flat) > named) {
    HOOK_STOP_NAME_RE.lastIndex = 0;
    const hit = HOOK_STOP_NAME_RE.exec(flat) || HOOK_STOP_NAME_RE.exec(s);
    return hit ? hit[1] : 'LD_DEBUG';
  }
  return null;
}

// The loader variables a .env file the agent loads may not set to a value: every LOADER_PRELOAD name but LD_DEBUG, which only logs
// unless it names help (hookStopAssignedIn judges that). A preload or audit library runs inside the shell of a hook launcher before the
// script's first line, so the launcher's own refusal comes too late. An empty value (LD_PRELOAD=) loads nothing and stays allowed.
const PRELOAD_WRITE_NAMES = LOADER_PRELOAD.filter((n) => n !== 'LD_DEBUG');
const PRELOAD_NAME_SRC = '(' + PRELOAD_WRITE_NAMES.join('|') + ')';
// NAME=value, NAME: value, export NAME=value, 'NAME'=value, $env:NAME='value', also right after a \n, \r or \t escape.
const PRELOAD_ASSIGNMENT_RE = new RegExp(String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))` + PRELOAD_NAME_SRC +
  String.raw`(?![A-Za-z0-9_])["']?[ \t]*(?:=|:(?=[ \t]))`, 'g');
const PRELOAD_NAME_RE = new RegExp(String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))` + PRELOAD_NAME_SRC + String.raw`(?![A-Za-z0-9_])`, 'g');

/**
 * Whether the value of a file assignment that starts at `from` is empty: only blanks and quote characters up to the end of its line or,
 * for a quoted value, up to the end of the line where the quote closes (a line break inside the quotes counts as content). A quote that
 * nothing closes is not empty.
 */
function emptyFileValue(s, from) {
  let i = from;
  while (s.charAt(i) === ' ' || s.charAt(i) === '\t') i++;
  const q = s.charAt(i);
  let eolFrom = i;
  if (q === '"' || q === "'" || q === '`') {
    const close = quoteClose(s, i + 1, q);
    if (close < 0) return false;
    eolFrom = close + 1;
  }
  let end = eolFrom;
  while (end < s.length && s.charAt(end) !== '\n' && s.charAt(end) !== '\r') end++;
  for (let k = from; k < end; k++) if (!' \t"\'`'.includes(s.charAt(k))) return false;
  return true;
}

/** The name of the first preload variable (PRELOAD_WRITE_NAMES) that `text`, as a file body, assigns a non-empty value, or null. */
function preloadAssignedIn(text) {
  const s = String(text);
  if (!s.includes('LD_')) return null; // every name holds LD_ (DYLD_ too)
  PRELOAD_ASSIGNMENT_RE.lastIndex = 0;
  let m;
  while ((m = PRELOAD_ASSIGNMENT_RE.exec(s))) {
    if (!emptyFileValue(s, m.index + m[0].length)) return m[1];
  }
  return null;
}

// What may follow a preload name in a shell write (quotes and backslashes removed) for the write to set it empty: = or ": ", blanks, at
// most one redirection with its target, then the end of the command or line. echo LD_PRELOAD= x writes "LD_PRELOAD= x": not empty.
const EMPTY_SHELL_VALUE_RE = /[ \t]*(?:=|:(?=[ \t]))[ \t]*(?:(?:[0-9]*>>?|>\|)[ \t]*[^\s;&|<>]+[ \t]*)?(?=$|[\n;&|])/y;

/**
 * For a shell command that writes a dotenv file: the first preload name it mentions other than as an empty assignment, in the text as
 * written or once quotes and backslashes are removed (LD_PRE"LOAD"=x), or null. A mention that is not an assignment (printf '%s=%s'
 * LD_PRELOAD x, a name glued to other text) is refused too, because what the command then writes is not plain to see.
 */
function preloadNamedIn(s) {
  const flat = s.replace(/\\[nrt]/g, '\n').replace(/["'\\]/g, '');
  if (!flat.includes('LD_') && !s.includes('LD_')) return null;
  const count = (t) => { PRELOAD_NAME_RE.lastIndex = 0; return (t.match(PRELOAD_NAME_RE) || []).length; };
  PRELOAD_NAME_RE.lastIndex = 0;
  let m;
  while ((m = PRELOAD_NAME_RE.exec(flat))) {
    EMPTY_SHELL_VALUE_RE.lastIndex = m.index + m[0].length;
    if (!EMPTY_SHELL_VALUE_RE.test(flat)) return m[1];
  }
  if (count(s) > count(flat)) { PRELOAD_NAME_RE.lastIndex = 0; return PRELOAD_NAME_RE.exec(s)[1]; }
  return null;
}

// The first character after $ that makes an expansion: a name, ${..}, $(..), $((..)) or a special parameter.
const EXPANDS_AFTER_DOLLAR = /[A-Za-z_{(0-9@*#?!$-]/;
// A character right before which a variable name cannot start: it would be part of a longer word, or glued to an expansion or a pattern.
const NAME_GLUE = /[A-Za-z0-9_$%{}`)\]?*\\]/;
// A shell expansion outside single quotes, for the line by line reading below.
const LINE_EXPANSION_RE = /\$[A-Za-z_{(0-9@*#?!$-]|`/;
// A line that starts with a literal assignment: what follows it to the end of the line is the value.
const LINE_ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*["']?[ \t]*(?:=|:(?=[ \t]))/;

/**
 * The opaque-write rule, for text the quote scan cannot model (a here-document, an unterminated quote), read line by line: a line that
 * holds an expansion is opaque unless it starts with a literal NAME= (or NAME: ) and the expansion is in what follows.
 */
function opaqueByLines(s) {
  for (const line of s.split(/\r\n|\n|\r/)) {
    const m = LINE_ASSIGNMENT_RE.exec(line);
    if (!m && LINE_EXPANSION_RE.test(line)) return true;
  }
  return false;
}

/**
 * Whether a shell command that writes a dotenv file writes OPAQUE text: a variable name, or a whole line, that only the shell knows once
 * it runs. That is the case when an expansion ($NAME, ${..}, $(..), `..`, outside single quotes) or an unquoted pattern (* ?, [x], {a,b})
 * sits anywhere but
 * - in the value of a literal assignment: after NAME= or NAME: , where NAME is a plain name ([A-Za-z_][A-Za-z0-9_]*) not glued to an
 *   expansion or pattern, up to the end of that shell word, a line break or a \n or \r escape (echo "API_URL=$URL", sed -i "s|^A=.*|A=$V|" .env);
 * - in an argument of printf whose format (the word right after printf) has every conversion in such a value (printf 'TOKEN=%s\n' "$T"); a printf conversion
 *   anywhere else is opaque even with literal arguments (printf '%s%s\n' LD_ DEBUG=help);
 * - in the file a redirection names (>> "$DIR/.env"), or in a comment.
 * Everything else fails closed: printf "$X", echo "$LINE", printf '%s=%s\n' "$K" "$V", echo * > .env, and also expansions in other parts
 * of the command (cd "$D" && ...). One forward pass over the quote map.
 */
function opaqueWriteIn(s) {
  if (!/[$`*?[{]/.test(s) && !(s.includes('%') && s.includes('printf'))) return false;
  const inside = quoteMap(s);
  if (inside.bad) return opaqueByLines(s);
  const n = s.length;
  let inValue = false;
  let valueFrom = -1;
  let nameUntil = 0; // end of the last name scanned: each run of name characters is scanned once
  let inWord = false;
  let target = false;
  let pendingTarget = false;
  let wordIdx = -1;
  let headStart = 0;
  let isPrintf = false;
  let fmtOk = true;
  const reset = () => { wordIdx = -1; isPrintf = false; fmtOk = true; pendingTarget = false; };
  const endWord = (i) => {
    if (!inWord) return;
    inWord = false;
    if (!target && wordIdx === 0) {
      const head = s.slice(headStart, i).replace(/["'\\]/g, '');
      isPrintf = head.slice(head.lastIndexOf('/') + 1) === 'printf';
    }
  };
  for (let i = 0; i < n; i++) {
    const c = s.charAt(i);
    const at = inside[i];
    if (valueFrom >= 0 && i >= valueFrom) { inValue = true; valueFrom = -1; }
    if (at === 2) continue; // a comment
    const live = at === 0;
    if (inValue && (c === '\n' || c === '\r' || (c === '\\' && /[nr]/.test(s.charAt(i + 1))) || (live && /[\s;&|<>()]/.test(c)))) inValue = false;
    if (live && /[\s;&|<>()]/.test(c)) {
      endWord(i);
      if (c === '>' || (c === '<' && s.charAt(i + 1) !== '<' && s.charAt(i - 1) !== '<')) {
        pendingTarget = true;
        while (inside[i + 1] === 0 && /[>&|]/.test(s.charAt(i + 1))) i++;
      } else if (c !== '<' && (c === '\n' || !/\s/.test(c))) {
        reset(); // ; & | ( ) and a line break end the simple command
      }
      continue;
    }
    if (!inWord) {
      inWord = true;
      target = pendingTarget;
      pendingTarget = false;
      if (!target) {
        wordIdx++;
        if (wordIdx === 0) headStart = i;
        else if (wordIdx === 1 && isPrintf && c === '-') fmtOk = false; // an option, not the format
      }
    }
    if (target) continue; // the file a redirection names is not written text
    const allowed = inValue || (isPrintf && wordIdx >= 2 && fmtOk);
    if (c === '%' && isPrintf && (wordIdx === 1 || (wordIdx === 2 && !fmtOk))) {
      if (s.charAt(i + 1) === '%') i++;
      else if (!inValue) return true; // a conversion outside a literal NAME= value can assemble a name from literal arguments
      continue;
    }
    if (at !== 3 && ((c === '$' && EXPANDS_AFTER_DOLLAR.test(s.charAt(i + 1))) || c === '`')) {
      if (!allowed) return true;
      if (/[{?*@#!$0-9-]/.test(s.charAt(i + 1))) i++; // ${, $? and $* are not patterns
      continue;
    }
    if (live && (c === '*' || c === '?' || ((c === '[' || c === '{') && !/^[\s[{]?$/.test(s.charAt(i + 1))))) {
      if (!allowed) return true;
      continue;
    }
    if (i >= nameUntil && /[A-Za-z_]/.test(c) &&
        (i === 0 || !NAME_GLUE.test(s.charAt(i - 1)) || (s.charAt(i - 2) === '\\' && /[nrt]/.test(s.charAt(i - 1))))) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(s.charAt(j))) j++;
      nameUntil = j;
      if (s.charAt(j) === '"' || s.charAt(j) === "'") j++;
      while (s.charAt(j) === ' ' || s.charAt(j) === '\t') j++;
      if (s.charAt(j) === '=' || (s.charAt(j) === ':' && /[ \t]/.test(s.charAt(j + 1)))) valueFrom = j + 1;
    }
  }
  return false;
}

// What preloadOrOpaqueIn returns for an opaque write.
const OPAQUE_WRITE = '<opaque>';

/**
 * For a shell command that writes a dotenv file: a preload name it sets to a value (preloadNamedIn), OPAQUE_WRITE when the names it writes
 * are not plain to see (opaqueWriteIn, unless opts.opaque is false), or null. Run after hookStopOrComputedIn.
 */
function preloadOrOpaqueIn(text, opts = {}) {
  const s = String(text);
  return preloadNamedIn(s) || (opts.opaque !== false && opaqueWriteIn(s) ? OPAQUE_WRITE : null);
}

module.exports = { isHookStopVar, hookStopAssignedIn, hookStopOrComputedIn, preloadAssignedIn, preloadOrOpaqueIn, OPAQUE_WRITE, PRELOAD_WRITE_NAMES, SH_UNSET_NAMES, LOADER_LIBPATH, LOADER_PRELOAD, LOADER_PREFIXES, LOADER_NAMES, WINDOWS_NAMES, LOADER_SOURCE, LOADER_VAR, isLoaderVar, loaderVarsIn, withoutLoaderVars, shScrubLines, psScrub };
