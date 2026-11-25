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

// NAME=value as it is written in a .env file, in a shell command (echo, printf, tee, sed, a heredoc, `$env:NAME='x'`) or in a patch: the
// value is quoted, or runs to the end of the line or to a shell separator, a sed slash or a closing bracket. A bare NAME with no "=" sets nothing.
const HOOK_STOP_ASSIGNMENT_RE = /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(LD_TRACE_LOADED_OBJECTS|LD_DEBUG)(?![A-Za-z0-9_])["']?[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\n"';&|/\\)}]*))?/g;

/** The name of the first variable in `text` that is assigned a value that stops the hooks (see isHookStopVar), or null. */
function hookStopAssignedIn(text) {
  const s = String(text);
  if (!s.includes('LD_')) return null;
  HOOK_STOP_ASSIGNMENT_RE.lastIndex = 0;
  let m;
  while ((m = HOOK_STOP_ASSIGNMENT_RE.exec(s))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] || '');
    if (isHookStopVar(m[1], value)) return m[1];
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
  while ((m = HOOK_STOP_ASSIGNMENT_RE.exec(s))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] || '');
    if (isHookStopVar(m[1], value)) return m[1];
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
    if (glued || COMPUTED_VALUE_RE.test(value)) return m[1];
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

module.exports = { isHookStopVar, hookStopAssignedIn, hookStopOrComputedIn, SH_UNSET_NAMES, LOADER_LIBPATH, LOADER_PRELOAD, LOADER_PREFIXES, LOADER_NAMES, WINDOWS_NAMES, LOADER_SOURCE, LOADER_VAR, isLoaderVar, loaderVarsIn, withoutLoaderVars, shScrubLines, psScrub };
