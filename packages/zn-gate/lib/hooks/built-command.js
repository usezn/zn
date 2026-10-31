'use strict';

/**
 * A command whose program name is built at run time, given network or delete arguments.
 *
 *   $(echo curl) URL, `echo rm` -rf x, /usr/bin/cu?l URL, c''url URL, ${X} URL, and the eval builtin fed such a name
 *
 * zn cannot tell which program such a word runs, and the arguments show the command is about the network or about
 * deleting files, so the command is refused instead of guessed at. A command word that is not literal but has neither
 * kind of argument (`$(which python) -m pytest`, `"$EDITOR" notes.txt`, `./scripts/*.sh`) is not touched, and neither
 * is a glob or a variable in an argument (`ls /usr/bin/py*`).
 *
 * It reads the command text itself, in one pass, and does not depend on the rest of the hook policy.
 */

const MAX_COMMANDS = 20000;
const MAX_DEPTH = 3;
const MAX_BODIES = 64;

const MESSAGE = 'zn blocked this: the command builds the name of the program it runs at run time and gives it network or delete arguments, so zn cannot tell what it runs. Next step: write the program name out (for example curl or rm) so it can be checked.';

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'coproc']);
// Wrappers that run the next command, and the options of each that take a value.
const WRAPPERS = new Map([
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-D', '-R', '-T'])],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '-S'])],
  ['xargs', new Set(['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a'])],
  ['nice', new Set(['-n'])],
  ['command', new Set()], ['builtin', new Set()], ['exec', new Set()], ['nohup', new Set()], ['setsid', new Set()],
  ['timeout', new Set(['-k', '-s'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['ionice', new Set(['-c', '-n', '-p', '-P', '-u'])],
]);

// Programs a built word must not be able to name: they reach the network or delete files.
const NETWORK_PROGRAMS = ['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'tftp', 'aria2c', 'http', 'https', 'httpie', 'xh'];
const DELETE_PROGRAMS = ['rm', 'rmdir', 'unlink', 'shred', 'srm', 'del', 'erase', 'rd', 'trash'];
const PROGRAMS = new Set([...NETWORK_PROGRAMS, ...DELETE_PROGRAMS]);

// A delete shown by the arguments: the word rm and its relatives, find's -delete, recursive and forced flags.
const DELETE_RE = /(^|[\s;&|(`$'"\/])(?:rm|rmdir|unlink|shred|srm|del|erase|rd|remove-item|ri)(?=$|[\s;&|)'"`])|(?:^|\s)-delete(?=\s|$)|(?:^|\s)--(?:no-preserve-root|recursive)(?=[\s=]|$)|(?:^|\s)-[A-Za-z]*(?:r[A-Za-z]*f|f[A-Za-z]*r)[A-Za-z]*(?=\s|$)/i;

/* The index of the `)` that closes the `$(` at `open` (the index of its `(`), quote-aware; the last index when unclosed. */
function skipParen(t, open) {
  let depth = 0;
  for (let j = open; j < t.length; j++) {
    const c = t[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { const e = t.indexOf("'", j + 1); if (e < 0) return t.length - 1; j = e; continue; }
    if (c === '"') {
      for (j++; j < t.length && t[j] !== '"'; j++) {
        if (t[j] === '\\') j++;
        else if (t[j] === '$' && t[j + 1] === '(') j = skipParen(t, j + 1);
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return t.length - 1;
}

function skipTick(t, open) {
  for (let j = open + 1; j < t.length; j++) {
    if (t[j] === '\\') { j++; continue; }
    if (t[j] === '`') return j;
  }
  return t.length - 1;
}

function skipBrace(t, open) {
  let depth = 0;
  for (let j = open; j < t.length; j++) {
    if (t[j] === '\\') { j++; continue; }
    if (t[j] === '{') depth++;
    else if (t[j] === '}' && --depth === 0) return j;
  }
  return t.length - 1;
}

/* The simple commands of a text as raw words (quotes and expansions kept), and the bodies of the $( ) and ` ` it holds. */
function readCommands(text) {
  const commands = [];
  const bodies = [];
  let words = [];
  let cur = '';
  let has = false;
  let segStart = 0;
  let truncated = false;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endCommand = (at) => {
    endWord();
    if (words.length) commands.push({ words, text: text.slice(segStart, at) });
    words = [];
    segStart = at + 1;
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (commands.length >= MAX_COMMANDS) { truncated = true; break; }
    const ch = text[i];
    if (ch === '\\') { cur += text.substr(i, 2); has = true; i += 2; continue; }
    if (ch === "'") {
      let e = text.indexOf("'", i + 1);
      if (e < 0) e = n - 1;
      cur += text.slice(i, e + 1); has = true; i = e + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < n && text[j] !== '"'; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '$' && text[j + 1] === '(') { const e = skipParen(text, j + 1); if (bodies.length < MAX_BODIES) bodies.push(text.slice(j + 2, e)); j = e; }
        else if (text[j] === '`') { const e = skipTick(text, j); if (bodies.length < MAX_BODIES) bodies.push(text.slice(j + 1, e)); j = e; }
      }
      cur += text.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (ch === '`') {
      const e = skipTick(text, i);
      if (bodies.length < MAX_BODIES) bodies.push(text.slice(i + 1, e));
      cur += text.slice(i, e + 1); has = true; i = e + 1; continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const e = skipParen(text, i + 1);
      if (bodies.length < MAX_BODIES) bodies.push(text.slice(i + 2, e));
      cur += text.slice(i, e + 1); has = true; i = e + 1; continue;
    }
    if (ch === '$' && text[i + 1] === '{') {
      const e = skipBrace(text, i + 1);
      cur += text.slice(i, e + 1); has = true; i = e + 1; continue;
    }
    if ((ch === '<' || ch === '>') && text[i + 1] === '(') {
      const e = skipParen(text, i + 1);
      if (bodies.length < MAX_BODIES) bodies.push(text.slice(i + 2, e));
      cur += text.slice(i, e + 1); has = true; i = e + 1; continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); i++; continue; }
    // >&2, 2>&1, &>file: the ampersand belongs to the redirect.
    if (ch === '&' && ((has && /[<>]$/.test(cur)) || text[i + 1] === '>')) { cur += ch; has = true; i++; continue; }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '(' || ch === ')') { endCommand(i); i++; continue; }
    cur += ch; has = true; i++;
  }
  endCommand(n);
  return { commands, bodies, truncated };
}

const REDIRECT_OP_RE = /^(?:\d*|&)(?:>>?|<<?<?|>&|<&|<>|>\|)$/;
const REDIRECT_GLUED_RE = /^(?:\d*|&)(?:>>?|<<?<?|>&|<&|<>|>\|)./;

/* Index of the command word in the raw words of a simple command (after assignments, redirects, keywords, wrappers). */
function commandWordIndex(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (REDIRECT_OP_RE.test(w)) { i += 2; continue; }
    if (REDIRECT_GLUED_RE.test(w) || ASSIGN_RE.test(w) || KEYWORDS.has(w)) { i++; continue; }
    const takes = WRAPPERS.get(w);
    if (!takes) return i;
    i++;
    while (i < words.length && /^-./.test(words[i])) i += takes.has(words[i]) ? 2 : 1;
    if (w === 'timeout') i++; // the duration
  }
  return -1;
}

function isExpansionAt(s, i) {
  if (s[i] === '`') return true;
  if (s[i] !== '$') return false;
  const d = s[i + 1];
  return d === '(' || d === '{' || (d !== undefined && /[A-Za-z0-9_@*#?!$-]/.test(d));
}

/* What is not literal in a raw word: an expansion ($(, `, ${, $name), an unquoted glob, quotes spliced inside the word. */
function builtKind(raw) {
  if (raw === '[' || raw === '[[') return '';
  let expansion = false;
  let glob = false;
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { quoted = true; const e = raw.indexOf("'", i + 1); i = e < 0 ? raw.length : e; continue; }
    if (c === '"') {
      quoted = true;
      for (i++; i < raw.length && raw[i] !== '"'; i++) {
        if (raw[i] === '\\') i++;
        else if (isExpansionAt(raw, i)) expansion = true;
      }
      continue;
    }
    if (isExpansionAt(raw, i)) expansion = true;
    else if (c === '*' || c === '?' || c === '[') glob = true;
  }
  if (expansion) return 'substitution or variable';
  if (glob) return 'glob';
  // Quotes that do not wrap the whole word ("c''url", c"u"rl) splice it from pieces.
  if (quoted && !/^(?:'[^']*'|"(?:[^"\\]|\\.)*")$/.test(raw)) return 'spliced quotes';
  return '';
}

/* Plain text of a raw word with its quotes removed (backslashes and expansions left as they are). */
function dequote(raw) {
  return raw.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g, (m, a, b, c) => (a !== undefined ? a : b !== undefined ? b : c));
}

/* A quoted glob character is a plain character: keep it out of the pattern with a bracket expression. */
function dequoteKeepGlob(raw) {
  return raw.replace(/'([^']*)'|"((?:[^"\\$`]|\\.)*)"/g, (m, a, b) => String(a !== undefined ? a : b).replace(/[*?[]/g, (x) => '[' + x + ']'));
}

/* The programs from the list that a word with a glob can be: /usr/bin/cu?l -> curl; c*l -> curl. */
function globPrograms(raw) {
  const base = dequoteKeepGlob(raw).split('/').pop();
  if (base.length > 64 || base.replace(/[?*[\]]/g, '').length < 2) return [];
  const re = require('./policy').globRegExp(base);
  return [...PROGRAMS].filter((p) => re.test(p));
}

/* The program named when a word is $(echo curl) or `echo rm`; '' for any other substitution. */
const ECHO_SUBST_RE = /^(?:\$\([ \t]*|`[ \t]*)(?:echo|printf)[ \t]+(?:-[a-zA-Z]{1,3}[ \t]+)?['"]?([A-Za-z0-9_.\/-]{1,64})['"]?[ \t]*(?:\)|`)$/;
function echoedProgram(raw) {
  const m = ECHO_SUBST_RE.exec(raw);
  return m ? m[1].split('/').pop().toLowerCase() : '';
}

function namesProgram(raw, kind) {
  if (kind === 'glob') return globPrograms(raw).length > 0;
  if (kind === 'spliced quotes') return PROGRAMS.has(dequote(raw).split('/').pop().toLowerCase());
  return PROGRAMS.has(echoedProgram(raw));
}

function judge(command) {
  const k = commandWordIndex(command.words);
  if (k < 0) return null;
  const word = command.words[k];
  let kind = builtKind(word);
  // The eval builtin runs the text it is given as a command: a name built in that text is a built command word.
  const feedsBuilt = word === 'eval' && command.words.slice(k + 1).some((w) => builtKind(w) === 'substitution or variable');
  if (!kind && !feedsBuilt) return null;
  if (kind && namesProgram(word, kind)) return MESSAGE;
  if (DELETE_RE.test(command.text) || require('./policy').hasNetworkSignals(command.text)) return MESSAGE;
  return null;
}

function check(text, depth) {
  const read = readCommands(text);
  if (read.truncated) return null; // the caller already refuses a text with too many commands
  for (const c of read.commands) {
    const deny = judge(c);
    if (deny) return deny;
  }
  if (depth < MAX_DEPTH) {
    // The commands inside $( ) and ` ` are commands of their own.
    for (const b of read.bodies) {
      const deny = check(b, depth + 1);
      if (deny) return deny;
    }
  }
  return null;
}

/** The deny message for a command whose program name is built at run time with network or delete arguments, or null. */
function builtCommandDenial(text) {
  const t = String(text || '');
  if (!/[$`*?['"\\]/.test(t)) return null;
  return check(t, 0);
}

module.exports = { builtCommandDenial, BUILT_COMMAND_MESSAGE: MESSAGE };
