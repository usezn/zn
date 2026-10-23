'use strict';

// Shell search scan shared by the agents whose hooks see a shell command (Antigravity, Gemini CLI):
// the folders a recursive grep, rg, ag, ack or git grep covers, for the search folder ask in lib/hooks/runner.js.

const os = require('os');
const path = require('path');
const policy = require('./policy');

const SEARCH_CMDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const RECURSIVE_BY_DEFAULT = new Set(['rg', 'ag', 'ack']);
// Programs that run another program given after their own options; options that take a value are listed so the
// value is not mistaken for the program.
const SEARCH_WRAPPERS = {
  sudo: 'ughCUpr', doas: 'u', env: 'uCS', command: '', exec: 'a', nohup: '', nice: 'n', time: 'fo', timeout: 'sk',
  xargs: 'nIiLPsdEa', builtin: '', stdbuf: 'ioe', '!': '', '{': '', then: '', do: '', else: '',
};
const CD_WORDS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);
const SEGMENTS_MAX = 500;
const SEARCH_BASES_MAX = 64;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
// How many nested bash -c / sh -c / eval strings are read; a search inside a deeper one asks.
const SHELL_DEPTH_MAX = 3;
const VAR_VALUES_MAX = 8;
const EXPANSIONS_MAX = 16;
const ASSIGN_WORDS = new Set(['export', 'readonly', 'declare', 'local', 'typeset']);
// Search options whose value is the next word, so it is not taken for the pattern or a path.
const LONG_VALUE_OPTS = /^--(?:include|exclude|exclude-dir|glob|iglob|type|type-not|max-count|after-context|before-context|context|threads|max-columns|max-depth|label|binary-files|devices|directories)$/;

/** The words of a simple command after env assignments and wrappers (sudo, env, command, nice, timeout, xargs...). */
function searchHead(words) {
  let k = 0;
  for (let guard = 0; k < words.length && guard < 20; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) { k++; continue; }
    const name = path.basename(words[k]).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SEARCH_WRAPPERS, name)) break;
    const valueOpts = SEARCH_WRAPPERS[name];
    k++;
    while (k < words.length) {
      const t = words[k];
      if (t === '--') { k++; break; }
      if (/^--./.test(t)) { k += /^--(?:user|group|signal|kill-after|max-args|max-procs|replace|delimiter)$/.test(t) ? 2 : 1; continue; }
      if (/^-./.test(t)) { k += /^-[A-Za-z]+$/.test(t) && valueOpts.includes(t[t.length - 1]) ? 2 : 1; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || (name === 'timeout' && /^[0-9.]+[smhd]?$/.test(t))) { k++; continue; }
      break;
    }
  }
  return words.slice(k);
}

/** [tool, operands, recursive, cwdOverride] of a search command, or null when it is not one. */
function searchOf(words) {
  const w = searchHead(words);
  let tool = path.basename(w[0] || '').toLowerCase();
  let rest = w.slice(1);
  let dir = null;
  let always = false;
  if (tool === 'git') {
    // git [-C dir] [-c k=v] [--no-pager ...] grep: it always walks the tree, with or without -r.
    let k = 0;
    while (k < rest.length && /^-/.test(rest[k])) {
      if (rest[k] === '-C' && k + 1 < rest.length) { dir = rest[k + 1]; k += 2; continue; }
      k += rest[k] === '-c' || rest[k] === '--git-dir' || rest[k] === '--work-tree' || rest[k] === '--namespace' ? 2 : 1;
    }
    if (rest[k] !== 'grep') return null;
    tool = 'grep';
    always = true;
    rest = rest.slice(k + 1);
  }
  if (!SEARCH_CMDS.has(tool)) return null;
  let recursive = always || RECURSIVE_BY_DEFAULT.has(tool);
  let hasPattern = false;
  const shortValue = tool === 'grep' || tool === 'egrep' || tool === 'fgrep' ? 'ABCmdD' : 'ABCmdgtTjME';
  const operands = [];
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t === '--') { operands.push(...rest.slice(k + 1)); break; }
    if (/^--/.test(t)) {
      if (/^--(recursive|dereference-recursive)$/.test(t)) recursive = true;
      if (/^--(regexp|file)$/.test(t)) { hasPattern = true; k++; } else if (/^--(regexp|file)=/.test(t)) hasPattern = true;
      else if (LONG_VALUE_OPTS.test(t)) k++;
      continue;
    }
    if (/^-[A-Za-z0-9]+$/.test(t)) {
      if (/[rR]/.test(t)) recursive = true;
      if (/[ef]$/.test(t)) { hasPattern = true; k++; } else if (/[ef]/.test(t.slice(1)) && !/[0-9]/.test(t)) hasPattern = true;
      else if (/^-[A-Za-z]+$/.test(t) && shortValue.includes(t[t.length - 1])) k++;
      continue;
    }
    operands.push(t);
  }
  if (!recursive) return null;
  return { targets: hasPattern ? operands : operands.slice(1), dir };
}

/**
 * Folders a shell search covers, for the same "ask before a search over a folder with a plain-text .env" check a
 * search tool gets. Antigravity does not let zn rewrite the output, so this question is the only barrier in front
 * of a recursive search that would print a .env. Every simple command of the line is read (split by the shell
 * parser of lib/hooks/policy.js, which keeps quoted separators such as "A|B" inside their word): grep, egrep, fgrep,
 * rg, ag, ack or git grep, also behind sudo, env, command, nice, timeout or xargs; recursive (-r, -R, --recursive
 * or an option cluster with r or R; rg, ag, ack and git grep always are). A cd (or pushd) earlier in the line
 * moves the folder later commands run in; since a cd may fail or sit in a subshell, the folders from before it
 * are searched too. The set of candidate folders grows by at most two per cd (the folder reached by following
 * every cd, and the cd target from the starting folder), never by multiplication; past SEARCH_BASES_MAX folders,
 * or when a cd target or search path holds an unexpanded variable or substitution, or when more segments remain than SEGMENTS_MAX, the line is not followed any further and
 * the search is marked to ask. Strings run by bash -c, sh -c, zsh -c or dash -c (up to SHELL_DEPTH_MAX nested) and by eval are read the same way
 * (eval shares the folder and the variables of the line, a shell string does not move them). A variable assigned earlier on the line
 * (D=config; grep -r AWS $D) is replaced by its value; one that was not assigned, or whose value is not a plain word, makes the folder unknown. A search's
 * first non-option word is the pattern (unless -e or -f gives it) and the rest are paths; with no path the working
 * folder is searched. Files named directly are checked by the shell command check, not here.
 * Returns { dirs, ask }: the folders found, and a reason when the line must be confirmed (or null).
 */
function homeOf(t) {
  // A leading ~ is the home folder the hook sees, not a folder named "~". On Windows ~\ counts too.
  if (t === '~' || t.startsWith('~/')) return path.join(os.homedir(), t.slice(1));
  if (process.platform === 'win32' && t.startsWith('~\\')) return path.join(os.homedir(), t.slice(2).replace(/\\/g, '/'));
  return t;
}

// ~+, ~-, ~user: the shell expands them to a folder zn does not resolve, so the folder is unknown.
function otherTilde(t) {
  return /^~[^/]/.test(t) && !(process.platform === 'win32' && t[1] === '\\');
}

/** [[name, value]...] when every word is a plain NAME=value assignment (after export, declare...), else null. */
function assignmentsOf(words) {
  let k = 0;
  while (k < words.length && (ASSIGN_WORDS.has(words[k]) || (k > 0 && /^-[A-Za-z]+$/.test(words[k])))) k++;
  const rest = words.slice(k);
  if (!rest.length) return null;
  const out = [];
  for (const w of rest) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/.exec(w);
    if (!m) return null;
    out.push([m[1], m[2] ? null : m[3]]);
  }
  return out;
}

/** Records a value for a variable; a value that is not one plain word, or a second value beyond the cap, makes it unknown. */
function setVar(vars, name, value) {
  const plain = value !== null && !/[$`\s*?[\]{}()<>|&;'"\\]/.test(value) && !value.startsWith('-') && !otherTilde(value);
  const cur = vars.get(name);
  if (!plain || cur === null) { vars.set(name, null); return; }
  const set = cur || new Set();
  set.add(value);
  vars.set(name, set.size > VAR_VALUES_MAX ? null : set);
}

function cloneVars(vars) {
  return new Map([...vars].map(([k, v]) => [k, v === null ? null : new Set(v)]));
}

/** The values a word can take once $NAME and ${NAME} are replaced; null when anything else is unexpanded. */
function expandVars(t, vars) {
  if (!/[$`]/.test(t)) return [t];
  if (t.includes('`')) return null;
  let outs = [''];
  for (const part of t.split(/(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)/)) {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(part);
    if (!m) {
      if (part.includes('$')) return null;
      outs = outs.map((o) => o + part);
      continue;
    }
    const vals = vars.get(m[1]);
    if (!vals) return null;
    const next = [];
    for (const o of outs) for (const v of vals) next.push(o + v);
    if (next.length > EXPANSIONS_MAX) return null;
    outs = next;
  }
  return outs;
}

function searchScan(command, cwd) {
  const origin = path.resolve(cwd);
  const found = new Set();
  const result = { dirs: found, ask: null };
  // state: { main: the folder after every cd, bases: Set of candidates }
  const walk = (text, state, depth) => {
    let rest = String(text);
    for (let n = 0; rest.length && n < SEGMENTS_MAX; n++) {
      if (result.ask) return '';
      const scan = policy.scanFirstCommand(rest);
      rest = rest.slice(scan.end + 1);
      const words = scan.words.map((x) => x.text).filter((x) => !/^[0-9]*[<>]/.test(x));
      if (!words.length) continue;
      const assign = assignmentsOf(words);
      if (assign) { for (const [k, v] of assign) setVar(state.vars, k, v); continue; }
      const head = searchHead(words);
      if (head.length && CD_WORDS.has(path.basename(head[0]).toLowerCase())) {
        const target = head.slice(1).find((x) => x === '-' || !/^-/.test(x));
        // A variable or a substitution cannot be followed: the folder is unknown, so the next recursive search asks.
        // Other patterns (globs, braces) are not followed: the places so far stay, and so does the folder itself.
        const tvals = target ? expandVars(target, state.vars) : [];
        if (target && (!tvals || tvals.length > 1 || otherTilde(tvals[0]))) state.unknown = true;
        else if (target && tvals[0] !== '-' && !/[*?[{~]/.test(tvals[0].replace(/^~(?=\/|$)/, ''))) {
          const t = homeOf(tvals[0]);
          state.bases.add(path.resolve(state.main, t));
          state.bases.add(path.resolve(origin, t));
          state.main = path.resolve(state.main, t);
        }
        continue;
      }
      const shellName = head.length ? path.basename(head[0]).toLowerCase() : '';
      let inner = null;
      if (SHELLS.has(shellName)) {
        const k = head.findIndex((x, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
        if (k > 0 && typeof head[k + 1] === 'string') inner = head[k + 1];
        else continue;
      } else if (shellName === 'eval') inner = head.slice(1).join(' ');
      if (inner !== null) {
        if (depth >= SHELL_DEPTH_MAX) {
          if (/(?:grep|egrep|fgrep|rg|ag|ack)/.test(inner)) result.ask = 'long';
        } else if (shellName === 'eval') {
          // eval runs in this shell: a cd or an assignment inside it moves this one.
          if (walk(inner, state, depth + 1).trim().length) result.ask = 'long';
        } else {
          // The inner command runs in its own shell: a cd inside it does not move this one.
          if (walk(inner, { main: state.main, bases: new Set(state.bases), unknown: state.unknown, vars: cloneVars(state.vars) }, depth + 1).trim().length) result.ask = 'long';
        }
        continue;
      }
      const s = searchOf(words);
      if (!s) continue;
      if (state.bases.size > SEARCH_BASES_MAX) { result.ask = 'long'; return ''; }
      const targets = [];
      let unknownTarget = false;
      for (const t of s.targets) {
        const v = expandVars(t, state.vars);
        if (!v || v.some(otherTilde)) unknownTarget = true;
        else targets.push(...v);
      }
      if (state.unknown || unknownTarget) { result.ask = 'unknown'; return ''; }
      for (const b of state.bases) {
        const base = s.dir ? path.resolve(b, s.dir) : b;
        if (targets.length) for (const t of targets) found.add(path.resolve(base, homeOf(t)));
        else found.add(base);
      }
    }
    return rest;
  };
  const state = { main: origin, bases: new Set([origin]), unknown: false, vars: new Map() };
  const rest = walk(command, state, 0);
  // Segments left unread (a very long line) cannot be checked: ask rather than allow.
  if (rest.trim().length && !result.ask) result.ask = 'long';
  return { dirs: [...found], ask: result.ask };
}

module.exports = { searchScan };
