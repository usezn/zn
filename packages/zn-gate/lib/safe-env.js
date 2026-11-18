'use strict';
/**
 * The environment for a program zn starts on its own (the vault daemon, the
 * keychain and dialog helpers, the browser opener, the clipboard and process
 * tools): the caller's loader and interpreter start-up settings are left out,
 * so code of the caller's choosing cannot load into a process that holds the
 * vault identity or answers for the user.
 *
 * One list, shared with `zn run` (broker/run.js).
 */

// Settings that make a program, or the interpreter it starts (an npm CLI is a
// shim that runs node), load code or files of the caller's choosing: dynamic
// loader and glibc settings (LD_PRELOAD, DYLD_INSERT_LIBRARIES, GCONV_PATH ...)
// and interpreter start-up options (NODE_OPTIONS=--require, PYTHONPATH,
// PERL5OPT, JAVA_TOOL_OPTIONS, BASH_ENV ...).
const LOADER_VAR = new RegExp('^(LD_|DYLD_)|^(GCONV_PATH|GLIBC_TUNABLES|LOCPATH|NLSPATH|HOSTALIASES|RES_OPTIONS|OPENSSL_CONF|' +
  'NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONINSPECT|PERL5OPT|PERL5LIB|PERLLIB|' +
  'RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|BASH_ENV|ENV)$', 'i');

/** A copy of base without loader variables, then extra on top (extra is zn's own and is not filtered). */
function safeEnv(base, extra) {
  const src = base || process.env;
  const out = {};
  for (const k of Object.keys(src)) if (!LOADER_VAR.test(k)) out[k] = src[k];
  if (extra) for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

module.exports = { LOADER_VAR, safeEnv };
