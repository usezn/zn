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
  // ld.so makes the shell exit 0 without running the script for these (a trace or the debug help), and sends its output elsewhere:
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
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT', 'PERL5OPT', 'PERL5LIB', 'PERLLIB',
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

module.exports = { SH_UNSET_NAMES, LOADER_LIBPATH, LOADER_PRELOAD, LOADER_PREFIXES, LOADER_NAMES, WINDOWS_NAMES, LOADER_SOURCE, LOADER_VAR, isLoaderVar, loaderVarsIn, withoutLoaderVars, shScrubLines, psScrub };
