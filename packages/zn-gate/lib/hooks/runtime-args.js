'use strict';

/*
 * Arguments a command builds at run time.
 *
 * The hook policy reads the words a command line spells out. A word the shell only builds when the command runs
 * ($(...), a variable, xargs input, eval, sh -c "...", ${c/X/T}, an array, read, printf -v, IFS) is not spelled out, so
 * a protected file name can hide in it. This module reads the command a second time, like a small shell that never
 * runs anything:
 *
 *   resolves  what the command itself fixes: a variable set earlier in the same line, a for loop over a fixed list,
 *             ${c/X/T} on a known value, array elements, echo and printf with known arguments, basename and dirname
 *             of a known name, the folders a git or pwd command can give. The resolved words go back to the normal
 *             protected-path check, as if they had been typed.
 *   refuses   what it cannot resolve and a protected file could hide in (fail closed):
 *               - a word that is partly known and could be the name of a protected file or of a file in a protected
 *                 folder (.e$(x), $d/.env, ~/.aws/$f, $k.pem), in any command;
 *               - a word that is entirely unknown ($f, $(...), "${a[@]}") given as a file to read, send or copy to a
 *                 program that shows or moves the content of its file arguments (cat, sed, cp, tar, ...), unless it
 *                 comes from a list the policy can check on the disk (find, ls, a loop over fixed names) or from a
 *                 command whose output is never a file name (date, git rev-parse, mktemp, ...);
 *               - shell code built at run time (eval, sh -c, trap, source) that zn cannot read.
 *
 * Nothing is run: the module only reads the command text and, to judge a list, the file names on the disk.
 */

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 256; // values kept for one variable
const MAX_BRANCHES = 512; // readings of one word
const MAX_COMMANDS = 20000;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20000; // names a walk of the disk may look at
const MAX_WALK_DEPTH = 12;

const RUNTIME_NAME_MESSAGE = 'zn: this command builds the name of a file at run time (a variable, $(...), a loop or xargs input zn cannot read), and zn cannot tell whether it is a protected file (a .env with values, a private key, a credential file or zn\'s own folder), so it was blocked. Next step: write the file names out in the command (or loop over a fixed list of names), or ask the user to run it.';
const RUNTIME_CODE_MESSAGE = 'zn: this command runs shell code built at run time (eval, sh -c, trap or source with text zn cannot read), so it was blocked. Next step: write the command out in full, with the file names spelled out.';
const TOO_COMPLEX_MESSAGE = 'zn: this command builds file names with more steps than zn can follow, so it was blocked. Next step: run it as several simpler commands, with the file names written out.';
const protectedListMessage =(what, name) => 'zn: this command hands ' + what + ' to a program that shows or copies the files it gets, and the list includes ' + name + ', which is protected, so it was blocked. Next step: name only the files you need (not ' + name + '), or ask the user to run it.';

/* ------------------------------ segments ------------------------------ */

// A value is a list of segments: a string (known text) or {unk, kind}. kind: 'any' (anything), 'num' (digits) or 'safe'
// (a value that is never a file name an agent chose: a date, a commit id, a temporary folder).
const unk = (kind, extra) => Object.assign({ unk: true, kind }, extra || {});
const isUnk = (s) => typeof s === 'object' && s !== null;

// A command that doubles a variable at every step (a="$a$a") would grow without end: a value is cut at MAX_LEN
// characters (it then counts as unknown), and the work of one analysis is limited (past it the command is refused).
const MAX_LEN = 16384;
const WORK_MAX = 12e6;
let work = 0;
class TooComplex extends Error {}
function normItem(item) {
  const out = [];
  let len = 0;
  for (const s of item) {
    if (s === '') continue;
    if (typeof s === 'string') {
      len += s.length;
      if (typeof out[out.length - 1] === 'string') out[out.length - 1] += s;
      else out.push(s);
    } else out.push(s);
  }
  work += len + out.length + 1;
  if (work > WORK_MAX) throw new TooComplex('work');
  if (len > MAX_LEN) return [unk('any', { why: 'a long value' })];
  return out;
}
const literalOf = (item) => (item.every((s) => typeof s === 'string') ? item.join('') : null);
const keyOfItem = (item) => item.map((s) => (isUnk(s) ? '\u0001' + s.kind + (s.bad || '') : s)).join('\u0000');
const hasUnk = (item) => item.some(isUnk);

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const n = normItem(it);
    const k = keyOfItem(n);
    if (!seen.has(k)) { seen.add(k); out.push(n); }
    if (out.length >= MAX_ITEMS * 2) break;
  }
  return out;
}

/* ------------------------------ lexer ------------------------------ */

// Parts of a word: {t:'lit', v, q} | {t:'var', ...} | {t:'cmd', code, q} | {t:'arith', q} | {t:'proc', code} |
// {t:'arr', words}. q: quoted (no splitting, no globbing).
const OP_CHARS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>', '\r']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGN_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?(\+?)=/;

function findClose(s, i, open, close) {
  // s[i] === open; the index of the matching close (quotes and nested pairs respected), or -1.
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') { k++; continue; }
    if (ch === "'") { const e = s.indexOf("'", k + 1); if (e < 0) return -1; k = e; continue; }
    if (ch === '"') {
      for (k++; k < s.length && s[k] !== '"'; k++) {
        if (s[k] === '\\') k++;
        else if (s[k] === '$' && s[k + 1] === '(') { const c = findClose(s, k + 1, '(', ')'); if (c < 0) return -1; k = c; }
        else if (s[k] === '`') { const e = s.indexOf('`', k + 1); if (e < 0) return -1; k = e; }
      }
      continue;
    }
    if (ch === '`') { const e = s.indexOf('`', k + 1); if (e < 0) return -1; k = e; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return k; }
  }
  return -1;
}

const ANSI_C = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function decodeEscapes(body, extra) {
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, (m, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'u' || e[0] === 'U') { const cp = parseInt(e.slice(1), 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ' '; }
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8) & 255);
    if (e[0] === 'c' && e.length === 2) return String.fromCharCode(e.charCodeAt(1) & 31);
    if (Object.prototype.hasOwnProperty.call(ANSI_C, e)) return ANSI_C[e];
    if (extra) return extra(e, m);
    return m;
  });
}

function parseParam(inner) {
  // ${...}: the name, an optional subscript, and one operation.
  const v = { t: 'var', name: '', idx: null, op: null, a: null, b: null, colon: false, indirect: false, length: false, src: inner };
  let s = inner;
  if (s[0] === '#' && s.length > 1 && /^[#]?[A-Za-z_0-9@*]/.test(s.slice(1))) { v.length = true; s = s.slice(1); }
  else if (s[0] === '!' && s.length > 1) { v.indirect = true; s = s.slice(1); }
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(?:\[([^\]]*)\])?/.exec(s);
  if (!m) { v.name = '?bad'; v.op = 'bad'; return v; }
  v.name = m[1];
  v.idx = m[2] === undefined ? null : m[2];
  const rest = s.slice(m[0].length);
  if (!rest) return v;
  let mm;
  if ((mm = /^(:?)([-=?+])([\s\S]*)$/.exec(rest))) { v.op = mm[2]; v.colon = mm[1] === ':'; v.a = mm[3]; return v; }
  if ((mm = /^\/([\/#%]?)([\s\S]*)$/.exec(rest))) {
    v.op = '/' + mm[1];
    const body = mm[2];
    let cut = -1;
    for (let k = 0; k < body.length; k++) { if (body[k] === '\\') { k++; continue; } if (body[k] === '/') { cut = k; break; } }
    v.a = cut < 0 ? body : body.slice(0, cut);
    v.b = cut < 0 ? '' : body.slice(cut + 1);
    return v;
  }
  if ((mm = /^(##|#|%%|%)([\s\S]*)$/.exec(rest))) { v.op = mm[1]; v.a = mm[2]; return v; }
  if ((mm = /^(\^\^|\^|,,|,)([\s\S]*)$/.exec(rest))) { v.op = mm[1]; v.a = mm[2]; return v; }
  if ((mm = /^:([^:]*)(?::([\s\S]*))?$/.exec(rest))) { v.op = ':'; v.a = mm[1]; v.b = mm[2] === undefined ? null : mm[2]; return v; }
  if ((mm = /^@([A-Za-z])$/.exec(rest))) { v.op = '@'; v.a = mm[1]; return v; }
  v.op = 'bad';
  return v;
}

/* The parts of a word read from `s` starting at i. With raw, the word runs to the end of s (an argument of ${...}). */
function readWord(s, i, raw, home) {
  const parts = [];
  const n = s.length;
  const addLit = (str, q) => {
    if (!str) return;
    const last = parts[parts.length - 1];
    if (last && last.t === 'lit' && last.q === q) last.v += str;
    else parts.push({ t: 'lit', v: str, q });
  };
  const dollar = (k, q) => {
    // s[k] === '$'; returns the index after the expansion, or k when it is a plain '$'.
    const c = s[k + 1];
    if (c === '(') {
      const close = findClose(s, k + 1, '(', ')');
      const end = close < 0 ? n : close + 1;
      const inner = s.slice(k + 2, close < 0 ? n : close);
      if (inner.startsWith('(') && inner.endsWith(')')) parts.push({ t: 'arith', q });
      else parts.push({ t: 'cmd', code: inner, q });
      return end;
    }
    if (c === '{') {
      const close = findClose(s, k + 1, '{', '}');
      const end = close < 0 ? n : close + 1;
      const v = parseParam(s.slice(k + 2, close < 0 ? n : close));
      v.q = q;
      parts.push(v);
      return end;
    }
    if (c !== undefined && /[A-Za-z_]/.test(c)) {
      const m = NAME_RE.exec(s.slice(k + 1));
      parts.push({ t: 'var', name: m[0], idx: null, op: null, q, src: m[0] });
      return k + 1 + m[0].length;
    }
    if (c !== undefined && /[0-9]/.test(c)) { parts.push({ t: 'var', name: c, idx: null, op: null, q, src: c }); return k + 2; }
    if (c !== undefined && /[@*#?$!-]/.test(c)) { parts.push({ t: 'var', name: c, idx: null, op: null, q, src: c }); return k + 2; }
    return k;
  };
  const double = (k) => {
    // after the opening quote; returns the index after the closing quote
    let buf = '';
    const flush = () => { addLit(buf, true); buf = ''; };
    for (; k < n; k++) {
      const ch = s[k];
      if (ch === '"') { flush(); if (!parts.length || parts[parts.length - 1].q !== true) parts.push({ t: 'lit', v: '', q: true }); return k + 1; }
      if (ch === '\\' && k + 1 < n) {
        const nx = s[k + 1];
        if (nx === '\n') { k++; continue; }
        if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') { buf += nx; k++; continue; }
        buf += ch;
        continue;
      }
      if (ch === '$') {
        flush();
        const e = dollar(k, true);
        if (e === k) buf += '$';
        else k = e - 1;
        continue;
      }
      if (ch === '`') {
        flush();
        const e = s.indexOf('`', k + 1);
        parts.push({ t: 'cmd', code: s.slice(k + 1, e < 0 ? n : e).replace(/\\([`$\\])/g, '$1'), q: true });
        k = e < 0 ? n : e;
        continue;
      }
      buf += ch;
    }
    flush();
    return n;
  };
  let k = i;
  let atStart = true;
  while (k < n) {
    const ch = s[k];
    if (!raw && OP_CHARS.has(ch)) {
      if ((ch === '<' || ch === '>') && s[k + 1] === '(') {
        const close = findClose(s, k + 1, '(', ')');
        parts.push({ t: 'proc', code: s.slice(k + 2, close < 0 ? n : close), dir: ch });
        k = close < 0 ? n : close + 1;
        atStart = false;
        continue;
      }
      // An array value: name=( ... ).
      if (ch === '(' && parts.length === 1 && parts[0].t === 'lit' && !parts[0].q && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(parts[0].v)) {
        const close = findClose(s, k, '(', ')');
        const body = s.slice(k + 1, close < 0 ? n : close);
        parts.push({ t: 'arr', words: lexWords(body, home) });
        k = close < 0 ? n : close + 1;
        break;
      }
      break;
    }
    atStart = atStart && parts.length === 0;
    if (ch === '\\' && k + 1 < n) {
      if (s[k + 1] === '\n') { k += 2; continue; }
      addLit(s[k + 1], true);
      k += 2;
      continue;
    }
    if (ch === "'") {
      const e = s.indexOf("'", k + 1);
      addLit(s.slice(k + 1, e < 0 ? n : e), true);
      if (e === k + 1) parts.push({ t: 'lit', v: '', q: true });
      k = e < 0 ? n : e + 1;
      continue;
    }
    if (ch === '"') { k = double(k + 1); continue; }
    if (ch === '$') {
      if (s[k + 1] === "'") {
        const e = (() => { for (let j = k + 2; j < n; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === "'") return j; } return -1; })();
        addLit(decodeEscapes(s.slice(k + 2, e < 0 ? n : e)), true);
        k = e < 0 ? n : e + 1;
        continue;
      }
      if (s[k + 1] === '"') { k = double(k + 2); continue; }
      const e = dollar(k, false);
      if (e === k) { addLit('$', false); k++; } else k = e;
      continue;
    }
    if (ch === '`') {
      const e = s.indexOf('`', k + 1);
      parts.push({ t: 'cmd', code: s.slice(k + 1, e < 0 ? n : e).replace(/\\([`$\\])/g, '$1'), q: false });
      k = e < 0 ? n : e + 1;
      continue;
    }
    if (ch === '~' && parts.length === 0 && !raw) {
      // ~ and ~/ are the home folder.
      const next = s[k + 1];
      if (next === undefined || next === '/' || OP_CHARS.has(next)) { addLit(home || '~', false); k++; continue; }
    }
    addLit(ch, false);
    k++;
  }
  return { parts, end: k };
}

/* The words of a string, split on blanks (an array's elements, an argument list). */
function lexWords(s, home) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const w = readWord(s, i, false, home);
    if (w.end === i) { i++; continue; }
    out.push({ parts: w.parts });
    i = w.end;
  }
  return out;
}

/* A command line as simple commands: {words, redirs, pipeIn, heredocs}. A word is {parts}. */
function lex(src, home) {
  const s = String(src);
  const n = s.length;
  const cmds = [];
  let cur = { words: [], redirs: [], pipeIn: false, heredocs: [] };
  const pending = [];
  const fresh = (pipeIn) => ({ words: [], redirs: [], pipeIn, heredocs: [] });
  const end = (op) => {
    if (cur.words.length || cur.redirs.length) { cmds.push(cur); cur = fresh(op === '|' || op === '|&'); }
    else if (op !== '\n') cur.pipeIn = op === '|' || op === '|&';
    if (cmds.length > MAX_COMMANDS) throw new Error('too many commands');
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '\\' && s[i + 1] === '\n') { i += 2; continue; }
    if (ch === '\n') {
      end('\n');
      i++;
      // The bodies of the here-documents opened on the line that just ended.
      for (const p of pending.splice(0)) {
        let body = '';
        while (i < n) {
          let e = s.indexOf('\n', i);
          if (e < 0) e = n;
          const line = s.slice(i, e);
          i = Math.min(e + 1, n);
          if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break;
          body += line + '\n';
        }
        p.cmd.heredocs.push({ body, quoted: p.quoted });
      }
      continue;
    }
    if (ch === '#') { while (i < n && s[i] !== '\n') i++; continue; }
    if (ch === ';' || ch === '(' || ch === ')') {
      if (ch === '(' && s[i + 1] === '(' && cur.words.length <= 1) {
        // (( arithmetic )) and for (( ... )): one word, names set inside it are numbers.
        const close = findClose(s, i, '(', ')');
        const inner = s.slice(i + 2, close < 0 ? n : close - 1);
        cur.words.push({ parts: [{ t: 'arithcmd', text: inner }] });
        i = close < 0 ? n : close + 1;
        continue;
      }
      end(ch);
      i += (ch === ';' && (s[i + 1] === ';' || s[i + 1] === '&')) ? 2 : 1;
      continue;
    }
    if (ch === '&') {
      if (s[i + 1] === '&') { end('&&'); i += 2; continue; }
      if (s[i + 1] === '>') { const l = s[i + 2] === '>' ? 3 : 2; i += l; const w = readWord(s, skipBlank(s, i), false, home); cur.redirs.push({ op: '>', fd: '&', target: { parts: w.parts } }); i = w.end; continue; }
      end('&');
      i++;
      continue;
    }
    if (ch === '|') {
      if (s[i + 1] === '|') { end('||'); i += 2; continue; }
      if (s[i + 1] === '&') { end('|&'); i += 2; continue; }
      end('|');
      i++;
      continue;
    }
    if (ch === '<' || ch === '>' || /[0-9]/.test(ch)) {
      const m = /^(\d+)?(>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(s.slice(i, i + 8));
      if (m && !(ch === '<' && s[i + 1] === '(') && !(ch === '>' && s[i + 1] === '(')) {
        i += m[0].length;
        const op = m[2];
        if (op === '<<' || op === '<<-') {
          i = skipBlank(s, i);
          let j = i;
          let delim = '';
          let quoted = false;
          while (j < n && !OP_CHARS.has(s[j])) {
            if (s[j] === "'" || s[j] === '"') { quoted = true; const e = s.indexOf(s[j], j + 1); delim += s.slice(j + 1, e < 0 ? n : e); j = e < 0 ? n : e + 1; continue; }
            if (s[j] === '\\') { quoted = true; delim += s[j + 1] || ''; j += 2; continue; }
            delim += s[j++];
          }
          pending.push({ cmd: cur, delim, strip: op === '<<-', quoted });
          i = j;
          continue;
        }
        i = skipBlank(s, i);
        if (i >= n) { cur.redirs.push({ op, fd: m[1] || null, target: { parts: [] } }); continue; }
        const w = readWord(s, i, false, home);
        cur.redirs.push({ op, fd: m[1] || null, target: { parts: w.parts } });
        i = w.end > i ? w.end : i + 1;
        continue;
      }
    }
    const w = readWord(s, i, false, home);
    if (w.end === i) { i++; continue; }
    cur.words.push({ parts: w.parts });
    i = w.end;
  }
  end(';');
  return cmds;
}
function skipBlank(s, i) { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; return i; }

/* ------------------------------ glob helpers ------------------------------ */

function globToRegExp(pat, flags) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '[') {
      const e = pat.indexOf(']', i + 2);
      if (e < 0) { re += '\\['; continue; }
      let body = pat.slice(i + 1, e).replace(/\\/g, '\\\\');
      if (body[0] === '!') body = '^' + body.slice(1);
      re += '[' + body + ']';
      i = e;
    } else if (c === '\\' && i + 1 < pat.length) { re += pat[i + 1].replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); i++; }
    else re += c.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', flags || '');
}

/* ------------------------------ programs ------------------------------ */

const base = (t) => String(t).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'rbash']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', '{', '}', '!', 'time', 'function', 'coproc', '[[', ']]']);

// Wrapper programs: options that take a value (the number of words to skip after them), whether the next operand is the
// command's own (a duration, a file).
const WRAPPERS = {
  sudo: { v: new Set(['-u', '-g', '-h', '-p', '-r', '-t', '-C', '-D', '-R', '-T', '-U']) },
  doas: { v: new Set(['-u', '-C']) },
  env: { v: new Set(['-u', '-C', '-S', '--unset', '--chdir']), assigns: true },
  command: { v: new Set() },
  builtin: { v: new Set() },
  exec: { v: new Set(['-a']) },
  nohup: { v: new Set() },
  time: { v: new Set(['-o', '-f']) },
  nice: { v: new Set(['-n']) },
  ionice: { v: new Set(['-c', '-n', '-p']) },
  timeout: { v: new Set(['-s', '-k', '--signal', '--kill-after']), operand: 1 },
  stdbuf: { v: new Set(['-i', '-o', '-e']) },
  setsid: { v: new Set() },
  chrt: { v: new Set(), operand: 1 },
  taskset: { v: new Set(), operand: 1 },
  flock: { v: new Set(['-w', '-E']), operand: 1 },
  unbuffer: { v: new Set() },
  watch: { v: new Set(['-n', '-d']) },
  busybox: { v: new Set() },
  chroot: { v: new Set(), operand: 1 },
  caffeinate: { v: new Set(['-t', '-w']) },
};

// Programs that show, copy, send or run the files they are given, with how their file operands are found.
//   first: the first operand is not a file (a pattern, a script, a filter) unless one of `script` is given
//   val: options that take a value (count of words)
//   dest: the last operand is the destination, not a source
//   archive: the first operand (after a bundled option word) is the archive
const SOME = (a) => new Set(a);
const DUMP = {
  cat: {}, tac: {}, more: { val: new Map([['-n', 1]]) }, less: { val: new Map([['-p', 1], ['-P', 1], ['-b', 1], ['-j', 1], ['-x', 1], ['-y', 1], ['-z', 1], ['-h', 1]]) },
  nl: { val: new Map([['-w', 1], ['-s', 1], ['-n', 1], ['-b', 1], ['-i', 1], ['-v', 1], ['-l', 1], ['-d', 1], ['-f', 1], ['-h', 1]]) },
  head: { val: new Map([['-n', 1], ['-c', 1]]) }, tail: { val: new Map([['-n', 1], ['-c', 1], ['--pid', 1], ['-s', 1]]) },
  od: { val: new Map([['-j', 1], ['-N', 1], ['-t', 1], ['-w', 1], ['-A', 1], ['-S', 1]]) },
  xxd: { val: new Map([['-l', 1], ['-s', 1], ['-c', 1], ['-g', 1], ['-o', 1], ['-n', 1]]) },
  hexdump: { val: new Map([['-n', 1], ['-s', 1], ['-e', 1], ['-f', 1]]) }, hd: {},
  strings: { val: new Map([['-n', 1], ['-t', 1], ['-e', 1], ['-T', 1]]) },
  base64: { val: new Map([['-w', 1], ['--wrap', 1]]) }, basenc: {}, rev: {},
  fold: { val: new Map([['-w', 1]]) }, fmt: { val: new Map([['-w', 1], ['-p', 1]]) }, pr: { val: new Map([['-w', 1], ['-l', 1], ['-h', 1], ['-N', 1]]) },
  column: { val: new Map([['-s', 1], ['-c', 1], ['-o', 1], ['-N', 1], ['-l', 1]]) },
  paste: { val: new Map([['-d', 1]]) }, sort: { val: new Map([['-k', 1], ['-t', 1], ['-o', 1], ['-S', 1], ['-T', 1], ['--key', 1]]) },
  uniq: { val: new Map([['-f', 1], ['-s', 1], ['-w', 1]]) }, cut: { val: new Map([['-d', 1], ['-f', 1], ['-c', 1], ['-b', 1]]) },
  diff: { val: new Map([['-U', 1], ['-C', 1], ['-I', 1], ['-x', 1], ['-X', 1], ['-L', 1], ['-D', 1], ['-F', 1]]) }, cmp: { val: new Map([['-n', 1], ['-i', 1]]) }, comm: {},
  sed: { first: true, script: SOME(['-e', '-f', '--expression', '--file']), val: new Map([['-e', 1], ['-f', 1], ['--expression', 1], ['--file', 1], ['-l', 1]]) },
  awk: { first: true, script: SOME(['-f', '--file']), val: new Map([['-F', 1], ['-v', 1], ['-f', 1], ['-e', 1]]) },
  gawk: { first: true, script: SOME(['-f', '--file']), val: new Map([['-F', 1], ['-v', 1], ['-f', 1], ['-e', 1]]) },
  mawk: { first: true, script: SOME(['-f']), val: new Map([['-F', 1], ['-v', 1], ['-f', 1]]) },
  jq: { first: true, script: SOME(['-f', '--from-file']), val: new Map([['--arg', 2], ['--argjson', 2], ['--slurpfile', 2], ['--rawfile', 2], ['-f', 1], ['--from-file', 1], ['--indent', 1]]) },
  yq: { first: true, val: new Map([['-i', 0]]) },
  cp: { dest: true, val: new Map([['-t', 1], ['-S', 1], ['--target-directory', 1], ['--suffix', 1]]) },
  mv: { dest: true, val: new Map([['-t', 1], ['-S', 1], ['--target-directory', 1], ['--suffix', 1]]) },
  install: { dest: true, val: new Map([['-t', 1], ['-m', 1], ['-o', 1], ['-g', 1], ['-S', 1]]) },
  rsync: { dest: true, val: new Map([['-e', 1], ['--rsh', 1], ['--exclude', 1], ['--include', 1], ['--port', 1], ['--exclude-from', 1], ['--include-from', 1], ['--filter', 1], ['-f', 1], ['--delete-excluded', 0]]) },
  scp: { dest: true, val: new Map([['-P', 1], ['-i', 1], ['-o', 1], ['-F', 1], ['-l', 1], ['-c', 1], ['-J', 1], ['-S', 1]]) },
  tar: { archive: true, val: new Map([['-f', 1], ['-C', 1], ['-T', 1], ['-X', 1], ['-I', 1], ['--exclude', 1], ['--file', 1], ['--directory', 1], ['--files-from', 1], ['--exclude-from', 1], ['--transform', 1]]) },
  zip: { archive: true, val: new Map([['-x', 0], ['-P', 1], ['-b', 1], ['-t', 1]]) },
  source: {}, '.': {},
  dd: { dd: true },
};
// A download piped into a shell is the business of the pipe_to_shell rule (off unless the user turns it on), not of this one.
const NET_SOURCES = new Set(['curl', 'wget', 'http', 'https', 'xh', 'fetch', 'nc', 'ncat', 'netcat', 'ssh']);
const STDIN_SENDERS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'telnet', 'mail', 'mailx', 'sendmail', 'mutt', 'pbcopy', 'xclip', 'xsel', 'clip', 'scp', 'sftp', 'ftp', 'openssl', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'ruby', 'perl', 'php']);

// Programs that never turn a value into a file name: used for the output of $(...). Their output is "safe".
const SAFE_VALUE = new Set(['date', 'whoami', 'id', 'hostname', 'uname', 'nproc', 'mktemp', 'which', 'type', 'wc', 'seq', 'expr', 'bc', 'uptime', 'tty', 'arch', 'lsb_release', 'getconf', 'logname', 'sw_vers', 'sysctl', 'git-rev-parse', 'shuf', 'uuidgen', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'openssl', 'od', 'tput', 'stat', 'file', 'du', 'df', 'free', 'realpath-nolink', 'test', '[', 'true', 'false']);
// git commands whose output is names of tracked files or ids: a list the policy does not walk.
const GIT_SAFE = new Set(['rev-parse', 'describe', 'config', 'branch', 'status', 'rev-list', 'merge-base', 'tag', 'symbolic-ref', 'show-ref', 'remote', 'ls-files', 'ls-tree', 'diff', 'log', 'shortlog', 'stash', 'worktree', 'submodule', 'for-each-ref', 'name-rev', 'var', 'version', 'ls-remote', 'count-objects', 'reflog', 'cherry', 'diff-tree', 'diff-index', 'diff-files', 'show-branch', 'whatchanged', 'blame-ignore']);
const EVAL_SAFE = new Set(['ssh-agent', 'direnv', 'pyenv', 'rbenv', 'nodenv', 'jenv', 'goenv', 'fnm', 'volta', 'brew', 'minikube', 'docker-machine', 'conda', 'micromamba', 'mamba', 'mise', 'asdf', 'starship', 'zoxide', 'thefuck', 'opam', 'keychain', 'register-python-argcomplete', 'kubectl', 'helm', 'gh', 'rustup', 'fzf', 'dircolors', 'lesspipe', 'luarocks', 'aws', 'gcloud', 'poetry', 'pipenv', 'npm', 'pnpm', 'yarn', 'direnv', 'ssh-agent', 'gpg-agent', 'tmux', 'zellij', 'atuin', 'navi', 'mcfly', 'nvm', 'sdk', 'sdkman', 'rtx', 'devbox', 'flox', 'nix', 'nix-env', 'fly', 'flyctl', 'doctl', 'vercel', 'netlify', 'terraform', 'tofu', 'cargo', 'pip', 'pip3', 'pipx', 'uv', 'deno', 'bun', 'go']);

/* ------------------------------ state ------------------------------ */

const ent = (items) => ({ items: dedupe(items).slice(0, MAX_ITEMS), arr: null });
function mergeItems(e, items) {
  const all = dedupe(e.items.concat(items));
  e.items = all.length > MAX_ITEMS ? [[unk('any')]] : all;
}
function scalarItems(e) {
  if (!e.arr) return e.items;
  let out = e.items.slice();
  for (const x of e.arr) out = out.concat(scalarItems(x));
  return dedupe(out);
}
const SPECIAL_NUM = new Set(['?', '$', '!', '#', 'RANDOM', 'LINENO', 'UID', 'EUID', 'PPID', 'SECONDS', 'BASHPID', 'SHLVL', 'COLUMNS', 'LINES', 'EPOCHSECONDS', 'EPOCHREALTIME']);
// $0, OLDPWD and BASH_SOURCE are paths of the shell script or of the last folder: they are not here.
const SPECIAL_SAFE = new Set(['-', 'HOSTNAME', 'HOSTTYPE', 'OSTYPE', 'MACHTYPE', 'BASH_VERSION', 'TERM', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'FUNCNAME', 'UNAME', 'TZ', 'PS1', 'PS4', 'OPTIND', 'PIPESTATUS']);

function child(st) {
  const c = Object.create(st);
  // The variables are shared: a name set inside $(...) or a subshell counts as set for the whole command (the check
  // treats every assignment of the command as possible).
  c.depth = st.depth + 1;
  return c;
}

function lookup(st, name) {
  if (st.vars.has(name)) return st.vars.get(name);
  const env = st.ctx.env || {};
  if (typeof env[name] === 'string') return ent([[env[name]]]);
  if (name === 'PWD') return ent([[st.cdSeen ? unk('any', { why: 'folder' }) : st.ctx.cwd]]);
  if (name === 'HOME') return ent([[st.ctx.home]]);
  if (SPECIAL_NUM.has(name)) return ent([[unk('num')]]);
  if (SPECIAL_SAFE.has(name)) return ent([[unk('safe')]]);
  if (name === '@' || name === '*' || /^[1-9][0-9]*$/.test(name)) {
    if (st.positional) {
      if (name === '@' || name === '*') {
        const e = ent([]);
        for (const p of st.positional) mergeItems(e, p.items);
        return e;
      }
      const p = st.positional[Number(name) - 1];
      return p || ent([[]]);
    }
    return ent([[unk('any', { why: 'argument' })]]);
  }
  return ent([[unk('any', { why: 'unset' })]]);
}

/* ------------------------------ evaluation ------------------------------ */

function splitFields(str, st) {
  // Field splitting of an unquoted value, as the shell does it with the current IFS.
  const ifs = st.ifs;
  if (ifs === undefined || ifs === null) {
    const parts = str.split(/[ \t\n]+/);
    return parts;
  }
  if (ifs === '') return [str];
  const chars = new Set(ifs.split(''));
  const out = [];
  let cur = '';
  for (const c of str) {
    if (chars.has(c)) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function globPat(item) {
  // A pattern (for ${x#p}, ${x/p/r}) as text: unknown parts make it unusable.
  return literalOf(item);
}

function caseMap(op, str) {
  if (op === '^^') return str.toUpperCase();
  if (op === ',,') return str.toLowerCase();
  if (op === '^') return str.charAt(0).toUpperCase() + str.slice(1);
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function applyTrim(op, val, pat) {
  const longest = op === '##' || op === '%%';
  const prefix = op[0] === '#';
  try {
    if (prefix) {
      const re = globToRegExp(pat);
      if (longest) { for (let k = val.length; k >= 0; k--) if (re.test(val.slice(0, k))) return val.slice(k); }
      else { for (let k = 0; k <= val.length; k++) if (re.test(val.slice(0, k))) return val.slice(k); }
    } else {
      const re = globToRegExp(pat);
      if (longest) { for (let k = 0; k <= val.length; k++) if (re.test(val.slice(k))) return val.slice(0, k); }
      else { for (let k = val.length; k >= 0; k--) if (re.test(val.slice(k))) return val.slice(0, k); }
    }
  } catch (_) { /* a pattern that is not a valid regular expression: left as it is */ }
  return val;
}

function applySubst(op, val, pat, rep) {
  if (pat === '') return val;
  let re;
  try { re = globToRegExp(pat); } catch (_) { return val; }
  const src = re.source.slice(1, -1);
  const mode = op.slice(1);
  try {
    if (mode === '#') { const m = new RegExp('^(?:' + src + ')').exec(val); return m ? rep + val.slice(m[0].length) : val; }
    if (mode === '%') { const m = new RegExp('(?:' + src + ')$').exec(val); return m ? val.slice(0, val.length - m[0].length) + rep : val; }
    if (mode === '/') return val.replace(new RegExp(src, 'g'), () => rep);
    return val.replace(new RegExp(src), () => rep);
  } catch (_) { return val; }
}

/* The alternatives of an argument of ${...} as text items (words, no splitting). */
function argItems(text, st) {
  if (text === null || text === undefined) return [[]];
  const { parts } = readWord(text, 0, true, st.ctx.home);
  return evalParts(parts, st, false).map((f) => f.length === 1 ? f[0] : normItem([].concat(...f)));
}

/* The value alternatives of one ${...} or $name, as items. */
function varItems(part, st, quoted) {
  const e = lookup(st, part.name);
  let items;
  if (part.length) return [[unk('num')]];
  if (part.indirect) {
    // ${!name}: the variable named by the value; ${!arr[@]}: the keys.
    if (part.idx === '@' || part.idx === '*') return [[unk('num')]];
    items = [];
    for (const it of scalarItems(e)) {
      const lit = literalOf(it);
      if (lit && /^[A-Za-z_][A-Za-z0-9_]*$/.test(lit)) items.push(...scalarItems(lookup(st, lit)));
      else items.push([unk('any', { why: 'indirect' })]);
    }
    return items.length ? dedupe(items) : [[unk('any')]];
  }
  if (part.idx !== null && part.idx !== '@' && part.idx !== '*' && e.arr) {
    const k = /^\d+$/.test(part.idx) ? Number(part.idx) : -1;
    items = k >= 0 && e.arr[k] ? scalarItems(e.arr[k]) : scalarItems(e);
    if (k >= 0 && !e.arr[k] && !e.items.length) items = [[]];
  } else if (e.arr && (part.idx === null || part.idx === '0')) {
    items = e.arr[0] ? scalarItems(e.arr[0]) : scalarItems(e);
  } else {
    items = scalarItems(e);
  }
  if (!items.length) items = [[]];
  const op = part.op;
  if (!op) return items;
  const out = [];
  if (op === '-' || op === '=' || op === '?' || op === '+') {
    const arg = argItems(part.a, st);
    if (op === '+') { out.push(...arg, []); return dedupe(out); }
    if (op === '?') return items;
    return dedupe(items.concat(arg));
  }
  if (op === '/' || op === '//' || op === '/#' || op === '/%') {
    const pats = argItems(part.a, st);
    const reps = argItems(part.b, st);
    for (const it of items) {
      const v = literalOf(it);
      if (v === null) { out.push([unk('any', { why: 'substitution' })]); continue; }
      for (const p of pats) for (const r of reps) {
        const pl = globPat(p);
        const rl = literalOf(r);
        if (pl === null || rl === null) { out.push([unk('any', { why: 'substitution' })]); continue; }
        out.push([applySubst(op, v, pl, rl)]);
      }
    }
    return dedupe(out);
  }
  if (op === '#' || op === '##' || op === '%' || op === '%%') {
    const pats = argItems(part.a, st);
    for (const it of items) {
      const v = literalOf(it);
      if (v === null) { out.push([unk('any', { why: 'trim' })]); continue; }
      for (const p of pats) {
        const pl = globPat(p);
        out.push(pl === null ? [unk('any', { why: 'trim' })] : [applyTrim(op, v, pl)]);
      }
    }
    return dedupe(out);
  }
  if (op === '^' || op === '^^' || op === ',' || op === ',,') {
    for (const it of items) { const v = literalOf(it); out.push(v === null ? it : [caseMap(op, v)]); }
    return dedupe(out);
  }
  if (op === ':') {
    const offs = argItems(part.a, st);
    const lens = part.b === null ? [null] : argItems(part.b, st);
    for (const it of items) {
      const v = literalOf(it);
      if (v === null) { out.push([unk('any', { why: 'substring' })]); continue; }
      for (const o of offs) for (const l of lens) {
        const ol = literalOf(o);
        const ll = l === null ? null : literalOf(l);
        if (ol === null || !/^-?\d+$/.test(ol.trim()) || (l !== null && (ll === null || !/^-?\d+$/.test(ll.trim())))) { out.push([unk('any', { why: 'substring' })]); continue; }
        let a = parseInt(ol, 10);
        if (a < 0) a = Math.max(0, v.length + a);
        out.push([ll === null ? v.slice(a) : (parseInt(ll, 10) < 0 ? v.slice(a, v.length + parseInt(ll, 10)) : v.slice(a, a + parseInt(ll, 10)))]);
      }
    }
    return dedupe(out);
  }
  if (op === '@') {
    for (const it of items) {
      const v = literalOf(it);
      if (v === null) { out.push([unk('any', { why: 'transform' })]); continue; }
      if (part.a === 'U') out.push([v.toUpperCase()]);
      else if (part.a === 'L') out.push([v.toLowerCase()]);
      else if (part.a === 'Q' || part.a === 'K' || part.a === 'k') out.push([v]);
      else if (part.a === 'E') out.push([decodeEscapes(v)]);
      else out.push([unk('any', { why: 'transform' })]);
    }
    return dedupe(out);
  }
  return [[unk('any', { why: 'expansion' })]];
}

/* The alternatives of one part, as lists of fields. */
function partFields(part, st, mode) {
  if (part.t === 'lit') return [[normItem([part.v])]];
  if (part.t === 'arithcmd') return [[[unk('num')]]];
  if (part.t === 'arith') return [[[unk('num')]]];
  if (part.t === 'proc') {
    if (mode === 'check') st.out.codes.push({ text: part.code, vars: st.vars, positional: null });
    return [[[unk('safe', { why: 'process substitution' })]]];
  }
  if (part.t === 'cmd') {
    const r = cmdSub(part.code, st, mode);
    return r.map((it) => {
      if (part.q || hasUnk(it)) return [it];
      const lit = literalOf(it);
      return splitFields(lit, st).map((f) => [f]);
    });
  }
  if (part.t === 'var') {
    const items = varItems(part, st, part.q);
    const multi = part.idx === '@' || part.idx === '*' || part.name === '@' || part.name === '*';
    return items.map((it) => {
      if (part.q && !multi) return [it];
      const lit = literalOf(it);
      if (lit === null) {
        // An unknown value of an unquoted variable can also split into several names under a changed IFS.
        return [it];
      }
      if (part.q) return [it];
      return splitFields(lit, st).map((f) => [f]);
    });
  }
  return [[[unk('any')]]];
}

/* The words one word stands for: a list of readings, each a list of fields (items). */
function evalParts(parts, st, mode) {
  let branches = [{ done: [], cur: [] }];
  for (const part of parts) {
    const alts = partFields(part, st, mode);
    if (branches.length * alts.length > MAX_BRANCHES) return [[[unk('any', { why: 'too many readings' })]]];
    const next = [];
    for (const b of branches) {
      for (const fields of alts) {
        const nb = { done: b.done.slice(), cur: b.cur };
        if (fields.length === 0) { next.push(nb); continue; }
        nb.cur = nb.cur.concat(fields[0]);
        if (fields.length > 1) {
          nb.done.push(nb.cur);
          for (let k = 1; k < fields.length - 1; k++) nb.done.push(fields[k]);
          nb.cur = fields[fields.length - 1];
        }
        next.push(nb);
      }
    }
    branches = next;
  }
  return branches.map((b) => {
    const done = b.done.slice();
    if (b.cur.length || !done.length) done.push(b.cur);
    return done.map(normItem).filter((it, k, arr) => it.length || arr.length === 1);
  });
}

/* A word (not an assignment) as its distinct items across readings. */
function evalWord(word, st, mode) {
  const parts = word.parts;
  if (parts.length === 1 && parts[0].t === 'arr') return [[]];
  const seen = new Set();
  const flat = [];
  for (const fields of evalParts(parts, st, mode)) {
    for (const it of fields) {
      const k = keyOfItem(it);
      if (!seen.has(k)) { seen.add(k); flat.push(it); }
    }
  }
  return flat;
}

/* A word with its parts all known literal text (no expansion): its text, else null. */
function plainText(word) {
  let t = '';
  for (const p of word.parts) { if (p.t !== 'lit') return null; t += p.v; }
  return t;
}
function hasExpansion(word) { return word.parts.some((p) => p.t !== 'lit'); }

/* ------------------------------ printf and echo ------------------------------ */

function echoOutput(args, st) {
  // args: lists of items (alternatives per argument). Returns alternatives of the output as items.
  let flagsDone = false;
  let interpret = false;
  const words = [];
  for (const a of args) {
    const lit = a.length === 1 ? literalOf(a[0]) : null;
    if (!flagsDone && lit !== null && /^-[neE]+$/.test(lit)) { if (lit.includes('e')) interpret = true; continue; }
    flagsDone = true;
    words.push(a);
  }
  let outs = [[]];
  words.forEach((alts, k) => {
    const next = [];
    for (const o of outs) for (const a of alts) { next.push(o.concat(k ? [' '] : [], interpret ? a.map((s) => (typeof s === 'string' ? decodeEscapes(s) : s)) : a)); }
    outs = next.slice(0, MAX_BRANCHES);
  });
  return dedupe(outs.map(normItem));
}

function printfOutput(args, st) {
  // args: alternatives per argument; args[0] is the format. Known format only.
  if (!args.length) return null;
  const fmts = args[0].map((it) => literalOf(it));
  if (fmts.some((f) => f === null)) return null;
  const rest = args.slice(1);
  const results = [];
  for (const fmt of fmts) {
    // Each conversion takes the next argument; the format is reused while arguments remain.
    const convs = fmt.match(/%[-+ #0]*[0-9*]*(?:\.[0-9*]+)?[a-zA-Z%]/g) || [];
    const takes = convs.filter((c) => c !== '%%').length;
    const rounds = takes ? Math.max(1, Math.ceil(rest.length / takes)) : 1;
    let outs = [[]];
    let ai = 0;
    for (let r = 0; r < rounds; r++) {
      const re = /%[-+ #0]*[0-9*]*(?:\.[0-9*]+)?([a-zA-Z%])|((?:[^%]|%(?![-+ #0-9.*a-zA-Z%]))+)/g;
      let m;
      while ((m = re.exec(fmt))) {
        if (m[2] !== undefined) { const t = decodeEscapes(m[2]); outs = outs.map((o) => o.concat([t])); continue; }
        const conv = m[1];
        if (conv === '%') { outs = outs.map((o) => o.concat(['%'])); continue; }
        const alts = rest[ai++] || [[]];
        const next = [];
        for (const o of outs) for (const a of alts) {
          if (conv === 'b') next.push(o.concat(a.map((s) => (typeof s === 'string' ? decodeEscapes(s) : s))));
          else if (conv === 'd' || conv === 'i' || conv === 'u') next.push(o.concat(hasUnk(a) ? [unk('num')] : [a.join('')]));
          else next.push(o.concat(a));
        }
        outs = next.slice(0, MAX_BRANCHES);
      }
    }
    results.push(...outs);
  }
  return dedupe(results.map(normItem));
}

/* ------------------------------ programs of a command ------------------------------ */

/* Index of the program word of a simple command after keywords, assignments and wrappers; -1 when there is none.
   `wrapped` lists the wrapper words passed. */
function programIndex(cmd, st) {
  let k = 0;
  const ws = cmd.words;
  const text = (i) => (ws[i] ? plainText(ws[i]) : null);
  for (let guard = 0; k < ws.length && guard < 24; guard++) {
    const t = text(k);
    const p0 = ws[k].parts[0];
    // NAME=value, whatever the value holds (name=$(cmd), name=(a b)).
    if (p0 && p0.t === 'lit' && !p0.q && ASSIGN_PREFIX_RE.test(p0.v)) { k++; continue; }
    if (t === null) return k; // a program built at run time
    if (KEYWORDS.has(t)) { k++; continue; }
    const name = base(t);
    const w = WRAPPERS[name];
    if (!w) return k;
    k++;
    for (; k < ws.length; k++) {
      const o = text(k);
      if (o === null) break;
      if (w.assigns && ASSIGN_PREFIX_RE.test(o)) continue;
      if (!o.startsWith('-') || o === '-') break;
      if (o === '--') { k++; break; }
      if (w.v.has(o)) k++;
    }
    if (w.operand) k += w.operand;
  }
  return k < ws.length ? k : -1;
}

/* ------------------------------ lists on the disk ------------------------------ */

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.next', '.cache']);
// Folders of the system that are not files of a project (and that a walk of / would spend its time in).
const SKIP_ABS = new Set(['/proc', '/sys', '/dev', '/run', '/snap', '/boot', '/lost+found']);
const QUICK_NAME_RE =/^\.env|^id_|\.(?:pem|key|p8|p12|pfx|jks|keystore|ppk|age)$|^credentials|^\.netrc|^_netrc|^\.pgpass|^\.npmrc|^\.pypirc|^\.git-credentials|^(?:config|hosts\.yml|accessTokens\.json|msal_token_cache\.json|settings\.json|hooks\.json|opencode\.json|config\.json)$/i;
const QUICK_DIR_RE = /(?:^|\/)\.(?:aws|ssh|zn|docker|kube|azure|gnupg|claude|codex|cursor|gemini|zcode)(?:\/|$)|\/\.config\/(?:gh|gcloud|opencode)\//;

/* Protected files below a folder that a listing (find, ls -R) would give. Returns {bad: message|null, slow: boolean}. */
function walkProtected(root, opts, st) {
  const ctx = st.ctx;
  let seen = 0;
  let bad = null;
  let slow = false;
  const visit = (dir, depth) => {
    if (bad || slow) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    seen += ents.length;
    if (seen > MAX_ENTRIES || (ctx.spend && ctx.spend(ents.length))) { slow = true; return; }
    for (const e of ents) {
      const abs = dir === '/' ? '/' + e.name : dir + '/' + e.name;
      if (e.isDirectory()) {
        // Not followed: past the depth, a folder no listing goes into, or a hidden folder an ls does not show.
        if (depth + 1 >= opts.maxDepth || SKIP_DIRS.has(e.name) || SKIP_ABS.has(abs) || (!opts.dot && e.name[0] === '.')) continue;
        if (opts.recursive) visit(abs, depth + 1);
        continue;
      }
      if (!opts.dot && e.name[0] === '.') continue;
      if (opts.nameRe && !opts.nameRe.every((re) => re.test(e.name))) continue;
      if (QUICK_NAME_RE.test(e.name) || QUICK_DIR_RE.test(abs)) {
        const deny = ctx.fileDeny ? ctx.fileDeny(abs) : null;
        if (deny) { bad = { name: e.name, deny }; return; }
      }
    }
  };
  visit(root, 0);
  return { bad, slow };
}

/* What a find command lists: {bad, slow, any}. words: the items of its words (literal text or null). */
function findList(texts, st) {
  const roots = [];
  let i = 1;
  for (; i < texts.length; i++) {
    const t = texts[i];
    if (t === null) return { any: true };
    if (t.startsWith('-') || t === '(' || t === '!' || t === ')') break;
    roots.push(t);
  }
  if (!roots.length) roots.push('.');
  let maxDepth = MAX_WALK_DEPTH;
  const names = [];
  let complex = false;
  for (; i < texts.length; i++) {
    const t = texts[i];
    if (t === null) { complex = true; continue; }
    if (t === '-maxdepth' && texts[i + 1] && /^\d+$/.test(texts[i + 1])) { maxDepth = Number(texts[i + 1]); i++; continue; }
    if ((t === '-name' || t === '-iname') && texts[i + 1] !== undefined && texts[i + 1] !== null) { names.push(globToRegExp(texts[i + 1], t === '-iname' ? 'i' : '')); i++; continue; }
    if (t === '-o' || t === '-or' || t === '!' || t === '-not' || t === '(' || t === '-prune' || t === '-path' || t === '-regex' || t === '-ipath' || t === '-iregex' || t === '-exec' || t === '-execdir' || t === '-ok') {
      if (t === '-exec' || t === '-execdir' || t === '-ok') break;
      complex = true;
    }
  }
  let slow = false;
  for (const r of roots) {
    const abs = path.resolve(st.ctx.cwd, r);
    let stat;
    try { stat = fs.lstatSync(abs); } catch (_) { continue; }
    if (stat.isFile()) {
      const name = path.basename(abs);
      if (QUICK_NAME_RE.test(name) || QUICK_DIR_RE.test(abs)) {
        const deny = st.ctx.fileDeny ? st.ctx.fileDeny(abs) : null;
        if (deny) return { bad: { name, deny } };
      }
      continue;
    }
    const res = walkProtected(abs, { maxDepth, recursive: true, dot: true, nameRe: complex || !names.length ? null : names }, st);
    if (res.bad) return { bad: res.bad };
    if (res.slow) slow = true;
  }
  return slow ? { any: true } : { ok: true };
}

function lsList(texts, st) {
  const dirs = [];
  let all = false;
  let recursive = false;
  for (let i = 1; i < texts.length; i++) {
    const t = texts[i];
    if (t === null) return { any: true };
    if (t.startsWith('-') && t !== '-') {
      if (/^-[A-Za-z]*[aA]/.test(t) || t === '--all' || t === '--almost-all') all = true;
      if (/^-[A-Za-z]*R/.test(t) || t === '--recursive') recursive = true;
      continue;
    }
    dirs.push(t);
  }
  if (!dirs.length) dirs.push('.');
  for (const d of dirs) {
    if (/[*?[]/.test(d)) continue; // the shell expands it; the words are checked as typed
    const abs = path.resolve(st.ctx.cwd, d);
    let stat;
    try { stat = fs.lstatSync(abs); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const res = walkProtected(abs, { maxDepth: recursive ? MAX_WALK_DEPTH : 1, recursive, dot: all }, st);
    if (res.bad) return { bad: res.bad };
    if (res.slow) return { any: true };
  }
  return { ok: true };
}

/* grep -l / rg -l: the names of the files that match, below the folders it searches. Null when the command does not
   print names (its output is lines of text, which are unknown). */
const GREP_VALUE_OPTS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--include', '--exclude', '--exclude-dir', '--include-dir', '-g', '-t', '-T', '--glob', '--type', '--max-count', '--file', '--regexp']);
function grepList(name, texts, st) {
  const args = texts.slice(1);
  const names = args.some((t) => t !== null && ((/^-[A-Za-z]*[lL]/.test(t) && !t.startsWith('--')) || t === '--files-with-matches' || t === '--files-without-match'));
  if (!names) return null;
  const rec = name === 'rg' || name === 'ag' || args.some((t) => t !== null && ((/^-[A-Za-z]*[rR]/.test(t) && !t.startsWith('--')) || t === '--recursive' || t === '--dereference-recursive'));
  if (!rec) return { unk: unk('safe', { why: 'grep -l' }) };
  const operands = [];
  let patternGiven = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === null) return { unk: unk('any', { why: name }) };
    if (t === '--') { operands.push(...args.slice(i + 1)); break; }
    if (t.startsWith('-') && t !== '-') {
      if (t === '-e' || t === '-f' || t === '--regexp' || t === '--file') patternGiven = true;
      if (GREP_VALUE_OPTS.has(t)) i++;
      continue;
    }
    operands.push(t);
  }
  const dirs = (patternGiven ? operands : operands.slice(1));
  if (dirs.some((d) => d === null)) return { unk: unk('any', { why: name }) };
  if (!dirs.length) dirs.push('.');
  const hidden = name === 'grep' || name === 'egrep' || name === 'fgrep' || args.some((t) => t !== null && (t === '--hidden' || t === '--no-ignore' || /^-u+$|^-[A-Za-z]*u/.test(t)));
  for (const d of dirs) {
    if (/[*?[]/.test(d)) continue;
    const abs = path.resolve(st.ctx.cwd, d);
    let stat;
    try { stat = fs.lstatSync(abs); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const res = walkProtected(abs, { maxDepth: MAX_WALK_DEPTH, recursive: true, dot: hidden }, st);
    if (res.bad) return { unk: unk('any', { bad: res.bad, why: name }) };
    if (res.slow) return { unk: unk('any', { why: name }) };
  }
  return { unk: unk('safe', { why: name }) };
}

/* ------------------------------ what a command produces ------------------------------ */

const PASS_THROUGH = new Set(['sort', 'uniq', 'head', 'tail', 'tee', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'nl', 'shuf', 'tac', 'unbuffer', 'stdbuf']);

function ancestorsOf(cwd) {
  const out = [];
  let d = cwd;
  for (let k = 0; k < 10; k++) {
    out.push(d);
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return out;
}

/* The output of one command, as {items} (alternatives of the whole output) or {unk} (a segment).
   argsItems: for echo and printf the items of the arguments. */
function produce(cmd, st, cmds, idx) {
  const pi = programIndex(cmd, st);
  if (pi < 0) {
    // $(< file) gives the content of the file.
    const r = cmd.redirs.find((x) => x.op === '<');
    if (r && !cmd.words.length) return redirSource(r, st, cmds, idx);
    return { unk: unk('safe') };
  }
  const name = plainText(cmd.words[pi]) === null ? '' : base(plainText(cmd.words[pi]));
  const argv = (from) => cmd.words.slice(from).map((w) => evalWord(w, st, 'collect'));
  const texts = cmd.words.slice(pi).map((w) => plainText(w));
  if (name === 'echo') return { items: echoOutput(argv(pi + 1), st) };
  if (name === 'cat' && !cmd.pipeIn) {
    // cat FILE: the content of a file named in the command, read from the disk now.
    const ops = texts.slice(1).filter((t) => t === null || !t.startsWith('-'));
    if (ops.length === 1 && ops[0] !== null && texts.slice(1).every((t) => t === null || !t.startsWith('-'))) return readList(ops[0], st);
  }
  if (name === 'printf') {
    const a = argv(pi + 1);
    if (a.length && a[0].length === 1 && literalOf(a[0][0]) === '-v') return { unk: unk('safe') };
    const out = printfOutput(a, st);
    if (out) return { items: out };
    return { unk: unk('any', { why: 'printf' }) };
  }
  if (name === 'pwd') return st.cdSeen ? { unk: unk('any', { why: 'folder' }) } : { items: [[st.ctx.cwd]] };
  if (name === 'basename' || name === 'dirname') {
    const a = argv(pi + 1).filter((x) => !(x.length === 1 && literalOf(x[0]) && /^-/.test(literalOf(x[0]))));
    if (a.length && a[0].every((it) => literalOf(it) !== null)) {
      const suffix = name === 'basename' && a[1] && a[1].length === 1 ? literalOf(a[1][0]) : null;
      return {
        items: a[0].map((it) => {
          const v = literalOf(it);
          if (name === 'dirname') return [path.posix.dirname(v.replace(/\\/g, '/'))];
          let b = path.posix.basename(v.replace(/\\/g, '/'));
          if (suffix && b.endsWith(suffix) && b !== suffix) b = b.slice(0, -suffix.length);
          return [b];
        }),
      };
    }
    if (a.length && a[0].every((it) => it.every((s) => !isUnk(s) || s.kind !== 'any'))) return { unk: unk('safe') };
    return { unk: unk('any', { why: name }) };
  }
  if (name === 'realpath' || name === 'readlink') {
    const a = argv(pi + 1).filter((x) => !(x.length === 1 && literalOf(x[0]) && /^-/.test(literalOf(x[0]))));
    if (a.length === 1 && a[0].every((it) => literalOf(it) !== null)) return { items: a[0].map((it) => [path.resolve(st.ctx.cwd, literalOf(it))]) };
    return { unk: unk('any', { why: name }) };
  }
  if (name === 'git') {
    // git -C dir? rev-parse --show-toplevel: a folder that holds the working folder.
    let k = pi + 1;
    while (k < cmd.words.length && (plainText(cmd.words[k]) || '').startsWith('-')) { k += (plainText(cmd.words[k]) === '-C' || plainText(cmd.words[k]) === '-c') ? 2 : 1; }
    const sub = k < cmd.words.length ? plainText(cmd.words[k]) : null;
    if (sub === 'rev-parse' && texts.some((t) => t === '--show-toplevel') && st.cdSeen) return { unk: unk('any', { why: 'folder' }) };
    if (sub === 'rev-parse' && texts.some((t) => t === '--show-toplevel')) return { items: ancestorsOf(st.ctx.cwd).map((d) => [d]) };
    if (sub !== null && GIT_SAFE.has(sub) && !(sub === 'log' && texts.some((t) => t && /^-(?:p|u|-patch|G.*|S.*)$/.test(t)))) return { unk: unk('safe', { why: 'git' }) };
    return { unk: unk('any', { why: 'git' }) };
  }
  if (name === 'find' || name === 'fd' || name === 'fdfind') {
    if (name === 'find') {
      const r = findList(texts, st);
      if (r.bad) return { unk: unk('any', { bad: r.bad, why: 'find' }) };
      if (r.ok) return { unk: unk('safe', { why: 'find' }) };
      return { unk: unk('any', { why: 'find' }) };
    }
    // fd ignores what .gitignore ignores unless told not to: the names it lists are the project's own files.
    if (texts.some((t) => t && /^(?:-[A-Za-z]*[HIu]|--(?:hidden|no-ignore|unrestricted))/.test(t))) return { unk: unk('any', { why: 'fd' }) };
    return { unk: unk('safe', { why: 'fd' }) };
  }
  if (name === 'ls') {
    const r = lsList(texts, st);
    if (r.bad) return { unk: unk('any', { bad: r.bad, why: 'ls' }) };
    if (r.ok) return { unk: unk('safe', { why: 'ls' }) };
    return { unk: unk('any', { why: 'ls' }) };
  }
  if (name === 'rg' && texts.some((t) => t === '--files')) {
    if (texts.some((t) => t && /^(?:-[A-Za-z]*u|--(?:hidden|no-ignore|unrestricted))/.test(t))) return { unk: unk('any', { why: 'rg' }) };
    return { unk: unk('safe', { why: 'rg --files' }) };
  }
  if (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg' || name === 'ag') {
    const r = grepList(name, texts, st);
    if (r) return r;
  }
  if (name === 'seq') return { unk: unk('num') };
  if (name === 'command' && texts[1] === '-v') return { unk: unk('safe') };
  if (SAFE_VALUE.has(name)) return { unk: unk('safe', { why: name }) };
  if (name === 'xargs' || name === 'cat' || PASS_THROUGH.has(name)) {
    // A pipe stage that passes lines through gives what its source gives.
    if (cmd.pipeIn && cmds && idx > 0 && PASS_THROUGH.has(name) && cmd.words.length - pi <= 1 + (name === 'grep' || name === 'head' || name === 'tail' || name === 'sort' ? 6 : 0)) {
      const prev = produce(cmds[idx - 1], st, cmds, idx - 1);
      if (prev.unk && prev.unk.kind !== 'any') return prev;
      if (prev.unk && prev.unk.bad) return prev;
    }
  }
  if (texts.length > 1 && texts.slice(1).every((t) => t === '--version' || t === '-v' || t === '-V' || t === '-version' || t === 'version')) return { unk: unk('safe', { why: 'version' }) };
  return { unk: unk('any', { why: name || 'command' }) };
}

/* The content of a file the command names, read from the disk now. It counts only when the name occurs once in the
   command line (a line that also writes the file does not hold today's content when it runs). */
const LIST_MAX_BYTES = 256 * 1024;
function readList(name, st) {
  const text = st.ctx.cmdText || '';
  if (text.split(name).length - 1 > 1) return { unk: unk('any', { why: 'a list file the command also writes' }) };
  const abs = path.resolve(st.ctx.cwd, name);
  let stat;
  try { stat = fs.statSync(abs); } catch (_) { return { items: [[]] }; } // not there: nothing to read
  if (!stat.isFile() || stat.size > LIST_MAX_BYTES) return { unk: unk('any', { why: 'a list file zn cannot read' }) };
  if (st.ctx.spend && st.ctx.spend(1 + (stat.size >> 10))) return { unk: unk('any', { why: 'a list file zn cannot read' }) };
  try { return { items: [[fs.readFileSync(abs, 'utf8').replace(/\n+$/, '')]] }; } catch (_) { return { unk: unk('any', { why: 'a list file zn cannot read' }) }; }
}

/* The values a read or mapfile stores from a source: each line of a known input (read as one value per line, with
   the fields of a line also given when there are several names), or the unknown segment. Items. */
const LINES_MAX = 250;
function readValues(src, st) {
  if (src.unk) return [[src.unk]];
  const out = [];
  for (const it of src.items) {
    if (hasUnk(it)) { out.push([unk('any', { why: 'read' })]); continue; }
    const lines = it.join('').split('\n');
    if (lines.length > LINES_MAX) { out.push([unk('any', { why: 'a long list' })]); continue; }
    for (const l of lines) {
      if (!l) continue;
      out.push([l]);
      for (const f of l.split(/[ \t]+/)) if (f && f !== l) out.push([f]);
    }
  }
  return out.length ? dedupe(out) : [[]];
}

/* The input of a redirect (< file, < <(cmd), <<< text) as a source. */
function redirSource(r, st, cmds, idx) {
  const parts = r.target.parts;
  if (r.op === '<<<') {
    const items = evalWord(r.target, st, 'collect');
    if (items.every((it) => !hasUnk(it))) return { items };
    return { unk: unk('any', { why: 'here-string' }) };
  }
  if (parts.length === 1 && parts[0].t === 'proc') {
    let sub;
    try { sub = lex(parts[0].code, st.ctx.home); } catch (_) { return { unk: unk('any') }; }
    if (!sub.length) return { items: [[]] };
    return produce(sub[sub.length - 1], child(st), sub, sub.length - 1);
  }
  const t = plainText(r.target);
  if (t !== null) return readList(t, st);
  const items = evalWord(r.target, st, 'collect');
  if (items.length === 1 && !hasUnk(items[0])) return readList(items[0].join(''), st);
  return { unk: unk('any', { why: 'input file' }) };
}

/* The `<` redirect that feeds the loop a `read` sits in: the one on its closing `done`. */
function loopRedirect(cmds, ci) {
  let depth = 0;
  for (let j = ci + 1; j < cmds.length; j++) {
    const w = cmds[j].words.length ? plainText(cmds[j].words[0]) : null;
    if (w === 'while' || w === 'until' || w === 'for' || w === 'select') depth++;
    else if (w === 'done') {
      if (depth === 0) return cmds[j].redirs.find((x) => x.op === '<' || x.op === '<<<') || null;
      depth--;
    }
  }
  return null;
}

/* What a command reads as standard input: its own `<` redirect, a here-document, the commands before it in a pipe, or
   (for read inside a loop) the redirect of the loop. */
function sourceOf(cmds, idx, st) {
  const cmd = cmds[idx];
  const own = cmd.redirs.find((x) => x.op === '<' || x.op === '<<<');
  if (own) return redirSource(own, st, cmds, idx);
  if (cmd.heredocs.length) {
    const h = cmd.heredocs[0];
    if (h.quoted || !/[$`]/.test(h.body)) return { items: [[h.body.replace(/\n+$/, '')]] };
    return { unk: unk('any', { why: 'here-document' }) };
  }
  if (idx > 0 && cmd.pipeIn) return produce(cmds[idx - 1], st, cmds, idx - 1);
  const loop = loopRedirect(cmds, idx);
  if (loop) return redirSource(loop, st, cmds, idx);
  return { unk: unk('any', { why: 'input' }) };
}

/* The result of $(code): alternatives as items. */
function cmdSub(code, st, mode) {
  if (st.depth >= MAX_DEPTH) return [[unk('any', { why: 'nested' })]];
  let sub;
  try { sub = lex(code, st.ctx.home); } catch (_) { return [[unk('any')]]; }
  if (!sub.length) return [[]];
  const inner = child(st);
  runCommands(sub, inner, mode === 'check' ? 'check' : 'collect');
  const last = sub.length - 1;
  const priorCd = sub.slice(0, last).some((c) => { const p = c.words[programIndex(c, inner)]; return p && ['cd', 'pushd'].includes(plainText(p)); });
  const r = produce(sub[last], inner, sub, last);
  if (r.items) {
    if (priorCd) return [[unk('any', { why: 'folder' })]];
    return r.items.map((it) => normItem(it.map((s) => (typeof s === 'string' ? s.replace(/\n+$/, '') : s))));
  }
  return [[r.unk]];
}

/* ------------------------------ assignments ------------------------------ */

function setVar(st, name, items, plus, mode) {
  let e = st.vars.get(name);
  if (!e) { e = ent([]); st.vars.set(name, e); }
  if (plus && e.items.length) {
    const next = [];
    for (const a of e.items) for (const b of items) next.push(a.concat(b));
    e.items = dedupe(next).slice(0, MAX_ITEMS);
  } else mergeItems(e, items);
}

function assignWord(word, st, mode) {
  // name=value, name+=value, name[i]=value, name=(...): returns true when the word was an assignment.
  const first = word.parts[0];
  if (!first || first.t !== 'lit' || first.q) return false;
  const m = ASSIGN_PREFIX_RE.exec(first.v);
  if (!m) return false;
  const name = m[1];
  const plus = m[3] === '+';
  const rest = [{ t: 'lit', v: first.v.slice(m[0].length), q: false }].concat(word.parts.slice(1));
  if (rest.length === 2 && rest[1].t === 'arr') {
    const e = st.vars.get(name) || ent([]);
    st.vars.set(name, e);
    e.arr = e.arr || [];
    for (const w of rest[1].words) {
      const flat = evalWord(w, st, mode);
      const x = ent(flat.length ? flat : [[]]);
      e.arr.push(x);
      if (e.arr.length > 256) break;
    }
    return true;
  }
  const items = [];
  for (const fields of evalParts(rest.map((p) => (p.t === 'var' || p.t === 'cmd' ? Object.assign({}, p, { q: true }) : p)), st, mode)) {
    // The value of an assignment is not split: its fields are joined back.
    items.push(normItem([].concat(...fields.map((f, k) => (k ? [' '].concat(f) : f)))));
  }
  if (m[2] !== undefined) {
    // name[i]=value
    const e = st.vars.get(name) || ent([]);
    st.vars.set(name, e);
    e.arr = e.arr || [];
    const k = /^\d+$/.test(m[2]) ? Number(m[2]) : e.arr.length;
    if (!e.arr[k]) e.arr[k] = ent(items); else mergeItems(e.arr[k], items);
    return true;
  }
  setVar(st, name, items.length ? items : [[]], plus, mode);
  return true;
}

function setUnknown(st, name, why, src) {
  let e = st.vars.get(name);
  if (!e) { e = ent([]); st.vars.set(name, e); }
  mergeItems(e, [[src || unk('any', { why })]]);
}

const DECLARE_CMDS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

/* ------------------------------ the analysis of commands ------------------------------ */

/* The operands of a dump program that are files read or sent: items per word, as [{word, items}]. */
function operandsOf(spec, name, cmd, pi, st) {
  const ops = [];
  let endOpts = false;
  let scriptGiven = false;
  let hasT = false;
  const ws = cmd.words;
  for (let k = pi + 1; k < ws.length; k++) {
    const t = plainText(ws[k]);
    if (!endOpts && t !== null && t.startsWith('-') && t !== '-') {
      if (t === '--') { endOpts = true; continue; }
      if (spec.script && spec.script.has(t)) scriptGiven = true;
      if (t === '-t' || t === '--target-directory') hasT = true;
      const cnt = spec.val && spec.val.get(t);
      if (cnt) { k += cnt; continue; }
      if (name === 'tar' && /^-[A-Za-z]*f$/.test(t)) { k++; continue; }
      if (name === 'tar' && /^-[A-Za-z]*C$/.test(t)) { k++; continue; }
      continue;
    }
    ops.push({ k, text: t });
  }
  let list = ops;
  if (spec.first && !scriptGiven) list = list.slice(1);
  if (spec.archive) {
    if (list.length && list[0].text !== null && /^[A-Za-z]+$/.test(list[0].text) && name === 'tar') {
      const bundled = list[0].text;
      list = list.slice(1);
      if (/f/.test(bundled)) list = list.slice(1);
    } else if (name === 'zip') list = list.slice(1);
    else if (name === 'tar') list = list.slice(0);
  }
  if (spec.dest && !hasT) list = list.slice(0, -1);
  return list.map((o) => ({ k: o.k, word: ws[o.k] }));
}

/* Whether an item is entirely unknown and could be any file name. */
function wholeUnknown(item) {
  return item.length > 0 && item.every(isUnk) && item.some((s) => s.kind === 'any');
}

const STRONG_NAMES = new Set(['credentials', '.netrc', '_netrc', '.pgpass', '.npmrc', '.pypirc', '.git-credentials', 'secrets.age', 'identity.age', 'application_default_credentials.json', 'accesstokens.json', 'msal_token_cache.json', 'credentials.db', 'access_tokens.db']);
const REP_NAMES = ['.env', '.env.local', '.env.production', '.env.development', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed25519_sk', 'key.pem', 'server.key', 'AuthKey.p8', 'store.p12', 'cert.pfx', 'a.jks', 'a.keystore', 'a.ppk', 'credentials', '.netrc', '_netrc', '.pgpass', '.npmrc', '.pypirc', '.git-credentials', 'secrets.age', 'identity.age'];
const DOTENV_RE = /^\.env(\.[A-Za-z0-9_.-]+)?$/i;
const DOTENV_SAFE_RE = /\.(example|sample|template|dist|defaults|schema)$/i;
const KEY_EXT_RE = /\.(?:pem|key|p8|p12|pfx|jks|keystore|ppk)$/i;
const SSH_KEY_RE = /^id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:_sk)?$/i;

function strongName(name) {
  if (DOTENV_RE.test(name) && !DOTENV_SAFE_RE.test(name)) return true;
  if (SSH_KEY_RE.test(name) || KEY_EXT_RE.test(name)) return true;
  return STRONG_NAMES.has(name.toLowerCase());
}

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
function segRegex(segs, safeAs) {
  return segs.map((s) => {
    if (!isUnk(s)) return escRe(s);
    if (s.kind === 'num') return '[0-9]*';
    if (s.kind === 'safe') return safeAs;
    return '[\\s\\S]*';
  }).join('');
}

/* Whether a word that is partly built at run time could name a protected file. */
function partialProtected(item0, writing, st) {
  let item = normItem(item0);
  // --option=value and NAME=value carry a path after the =.
  if (typeof item[0] === 'string') {
    const m = /^(?:-{1,2}[\w-]+|[A-Za-z_][\w.-]*)=/.exec(item[0]);
    if (m) item = normItem([item[0].slice(m[0].length)].concat(item.slice(1)));
  }
  // A leading @ (curl -d @file) or < names a file too.
  if (typeof item[0] === 'string') item = normItem([item[0].replace(/^(?:[^=@\s]*[=@]@?|[@<])/, '')].concat(item.slice(1)));
  if (!item.some((s) => isUnk(s) && s.kind !== 'safe')) return null;
  if (!item.some((s) => typeof s === 'string') && !item.some((s) => isUnk(s) && s.kind === 'num')) return null; // entirely unknown: not this rule
  // The last name and the folders before it.
  let cut = -1;
  for (let k = item.length - 1; k >= 0 && cut < 0; k--) {
    if (typeof item[k] === 'string') { const j = item[k].lastIndexOf('/'); if (j >= 0) cut = k * 1e6 + j; }
  }
  let dir = [];
  let last = item;
  if (cut >= 0) {
    const k = Math.floor(cut / 1e6);
    const j = cut % 1e6;
    dir = item.slice(0, k).concat([item[k].slice(0, j + 1)]);
    last = [item[k].slice(j + 1)].concat(item.slice(k + 1));
    last = normItem(last);
  }
  const lastHasAny = last.some((s) => isUnk(s) && s.kind === 'any');
  const lastHasNum = last.some((s) => isUnk(s) && s.kind === 'num');
  const lastLit = last.some((s) => typeof s === 'string');
  const dirHasAny = dir.some((s) => isUnk(s) && s.kind === 'any');
  if (lastLit && (lastHasAny || lastHasNum)) {
    const re = new RegExp('^' + segRegex(last, '(?!)') + '$', 'i');
    if (REP_NAMES.some((r) => re.test(r))) return true;
  }
  if (!lastHasAny && !lastHasNum && last.every((s) => typeof s === 'string') && dirHasAny) {
    if (strongName(last.join(''))) return true;
  }
  // A folder that is itself protected, with the rest unknown.
  const ex = st.ctx.examples ? st.ctx.examples(writing) : [];
  if (ex.length) {
    const lit = item.filter((s) => typeof s === 'string').join('/');
    const rooted = typeof item[0] === 'string' && item[0].startsWith('/');
    const open = isUnk(item[0]) && item[0].kind === 'any'; // an unknown start may be any folder, the home folder included
    const prefix = open ? '' : rooted ? '^' : '^' + escRe(st.ctx.cwd.replace(/\/$/, '')) + '/';
    const re = new RegExp(prefix + segRegex(item, '[^/]*') + '$', 'i');
    for (const e of ex) {
      if (!e.relDir || !lit.includes(e.relDir.split('/').pop())) continue;
      if (re.test(e.abs)) return true;
    }
  }
  return false;
}

/* The path of a redirect or word as items, and the checks that apply to them. */
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'nodejs', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'osascript', 'pwsh', 'powershell']);
// File-valued options of the programs that send a file: a value that is entirely unknown names any file.
const SENDER_PROGS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie']);
const FILE_OPTS = { curl: new Set(['-T', '--upload-file', '-K', '--config', '--cert', '--key', '-E', '--netrc-file']), wget: new Set(['--post-file', '--body-file', '-i', '--input-file', '--certificate', '--private-key']) };
const FILE_OPT_GLUED_RE = /^--(?:upload-file|config|post-file|body-file|input-file|netrc-file|cert|key)=$/;
// @file, name=@file, name=<file: the program reads the file after the @ or <.
const FILE_REF_RE = /^(?:-[A-Za-z]|--[\w-]+=|[\w-]+=)?[@<]$/;

function checkItems(st, items, writing, wholeCheck, head, redirectTarget, fileValue) {
  for (const it of items) {
    if (!hasUnk(it)) {
      const t = it.join('');
      if (!t) continue;
      const push = (text) => st.out.words.push({ text, redirectTarget: !!redirectTarget, head, seq: 1e6 + st.out.words.length });
      push(t);
      // Interpreter code ("open('.env')") is read in pieces, the way the policy reads code it can see.
      if (INTERPRETERS.has(head)) for (const tok of t.split(/[\s'"`$(){};|&<>=,]+/)) if (tok && tok !== t) push(tok);
      continue;
    }
    if (st.out.refuse) continue;
    if (SENDER_PROGS.has(head) && it.length === 2 && typeof it[0] === 'string' && wholeUnknown([it[1]]) && (FILE_REF_RE.test(it[0]) || FILE_OPT_GLUED_RE.test(it[0]))) { st.out.refuse = RUNTIME_NAME_MESSAGE; continue; }
    if (SENDER_PROGS.has(head) && fileValue && wholeUnknown(it)) { st.out.refuse = RUNTIME_NAME_MESSAGE; continue; }
    if (partialProtected(it, writing, st)) { st.out.refuse = RUNTIME_NAME_MESSAGE; continue; }
    if (wholeCheck && wholeUnknown(it)) {
      const u = it.find((s) => isUnk(s) && s.kind === 'any');
      st.out.refuse = u && u.bad ? protectedListMessage('a list of files', u.bad.name) : RUNTIME_NAME_MESSAGE;
    }
  }
}

const READ_ONLY = new Set(['cat', 'head', 'tail', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'stat', 'wc', 'diff', 'file', 'bat', 'jq', 'echo', 'pwd']);

function runCommands(cmds, st, mode) {
  for (let ci = 0; ci < cmds.length; ci++) runCommand(cmds, ci, st, mode);
}

function setIfs(st) {
  const e = st.vars.get('IFS');
  if (!e) return;
  const lits = e.items.map(literalOf);
  if (lits.some((l) => l === null)) { st.ifs = ''; st.ifsUnknown = true; return; }
  st.ifs = lits.length === 1 ? lits[0] : null;
  if (lits.length > 1) st.ifsUnknown = true;
}

function shellCodeOf(cmd, pi, st) {
  // sh -c CODE args...: the index of CODE's word and the word after it, or null.
  const ws = cmd.words;
  let k = pi + 1;
  for (; k < ws.length; k++) {
    const t = plainText(ws[k]);
    if (t === null) return null;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
      // the code is the next word (options that take a value may sit between)
      if (ws[k + 1]) return { code: k + 1, args: k + 2 };
      return null;
    }
    if (t === '-O' || t === '+O' || t === '-o' || t === '+o' || t === '--rcfile' || t === '--init-file') { k++; continue; }
    if (!t.startsWith('-') && !t.startsWith('+')) return null;
  }
  return null;
}

function runCommand(cmds, ci, st, mode) {
  const cmd = cmds[ci];
  const out = st.out;
  const ws = cmd.words;
  if (!ws.length && !cmd.redirs.length) return;
  // for NAME in WORDS / select NAME in WORDS
  const first = ws.length ? plainText(ws[0]) : null;
  if ((first === 'for' || first === 'select') && ws.length >= 2) {
    if (ws[1].parts[0] && ws[1].parts[0].t === 'arithcmd') {
      for (const m of ws[1].parts[0].text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:[-+*/%&|^]|<<|>>)?=/g)) setVar(st, m[1], [[unk('num')]], false, mode);
      return;
    }
    const name = plainText(ws[1]);
    if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      const inIdx = ws.length > 2 && plainText(ws[2]) === 'in' ? 2 : -1;
      if (inIdx < 0) { setUnknown(st, name, 'argument'); return; }
      const items = [];
      for (const w of ws.slice(inIdx + 1)) for (const it of evalWord(w, st, mode)) items.push(it);
      setVar(st, name, items.length ? items : [[]], false, mode);
      if (mode === 'check') checkItems(st, items, false, false, first, false);
      // The values are what the loop goes over; a loop word is also an argument that was spelled by an expansion.
      return;
    }
  }
  const pi = programIndex(cmd, st);
  const head = pi >= 0 && plainText(ws[pi]) !== null ? base(plainText(ws[pi])) : '';
  if (head === 'cd' || head === 'pushd' || head === 'popd') st.cdSeen = true;
  const rawHead = pi >= 0 ? plainText(ws[pi]) : null;
  // Assignments before the program (or alone) and the declare family.
  const upto = pi >= 0 ? pi : ws.length;
  for (let k = 0; k < upto; k++) {
    if (ws[k].parts[0] && ws[k].parts[0].t === 'lit' && !ws[k].parts[0].q && ASSIGN_PREFIX_RE.test(plainText(ws[k]) === null ? ws[k].parts[0].v : plainText(ws[k]))) {
      assignWord(ws[k], st, mode === 'check' ? 'collect' : mode);
    }
  }
  if (mode !== 'check' && ws.length) {
    if (upto === ws.length || (pi >= 0 && ws.slice(0, pi).some((w) => w.parts[0] && /^IFS=/.test(w.parts[0].v || '')))) setIfs(st);
  }
  if (pi < 0) {
    if (mode === 'check') {
      // Standalone assignments: their values are read too (a = $(...), an array of built names).
      for (const w of ws) {
        if (w.parts.length === 2 && w.parts[1].t === 'arr') { for (const e of w.parts[1].words) checkItems(st, evalWord(e, st, 'check'), false, false, '', false); continue; }
        if (hasExpansion(w)) checkItems(st, evalWord(w, st, 'check'), false, false, '', false);
      }
      for (const r of cmd.redirs) if (hasExpansion(r.target)) checkItems(st, evalWord(r.target, st, 'check'), r.op !== '<', false, '', r.op !== '<');
      heredocCodes(cmd, null, st);
    }
    return;
  }
  const args = ws.slice(pi + 1);
  // Builtins that set variables.
  if (rawHead !== null) {
    if (DECLARE_CMDS.has(head)) {
      const isRef = args.some((w) => /^-[A-Za-z]*n/.test(plainText(w) || ''));
      for (const w of args) {
        const t = plainText(w);
        if (t !== null && t.startsWith('-')) continue;
        if (isRef) { const nm = (t || '').split('=')[0]; if (/^[A-Za-z_]\w*$/.test(nm)) setUnknown(st, nm, 'reference'); continue; }
        assignWord(w, st, mode === 'check' ? 'collect' : mode);
      }
    } else if (head === 'read') {
      const vals = readValues(sourceOf(cmds, ci, st), st);
      let k = 0;
      const names = [];
      for (; k < args.length; k++) {
        const t = plainText(args[k]);
        if (t === null) continue;
        if (t === '-a') { const nm = plainText(args[k + 1]); if (nm) { const e = st.vars.get(nm) || ent([]); st.vars.set(nm, e); e.arr = e.arr || []; for (const v of vals) e.arr.push(ent([v])); mergeItems(e, vals); } k++; continue; }
        if (/^-[A-Za-z]*[pdnNtu]$/.test(t)) { k++; continue; }
        if (t.startsWith('-')) continue;
        names.push(t);
      }
      if (!names.length) names.push('REPLY');
      for (const nm of names) if (/^[A-Za-z_]\w*$/.test(nm)) setVar(st, nm, vals, false, mode);
    } else if (head === 'mapfile' || head === 'readarray') {
      const nm = args.map((w) => plainText(w)).filter((t) => t && !t.startsWith('-')).pop();
      if (nm) {
        const e = st.vars.get(nm) || ent([]);
        st.vars.set(nm, e);
        e.arr = e.arr || [];
        for (const v of readValues(sourceOf(cmds, ci, st), st)) e.arr.push(ent([v]));
      }
    } else if (head === 'getopts') {
      const nm = args[1] ? plainText(args[1]) : null;
      if (nm) setUnknown(st, nm, 'getopts');
    } else if (head === 'printf' && args.length >= 3 && plainText(args[0]) === '-v') {
      const nm = plainText(args[1]);
      if (nm && /^[A-Za-z_]\w*$/.test(nm)) {
        const r = printfOutput(args.slice(2).map((w) => evalWord(w, st, 'collect')), st);
        if (r) setVar(st, nm, r, false, mode); else setUnknown(st, nm, 'printf');
      }
    } else if (head === 'set' && args.length) {
      const t0 = plainText(args[0]);
      if (t0 === '--' || (t0 !== null && !t0.startsWith('-') && !t0.startsWith('+'))) {
        const vals = [];
        for (const w of args.slice(t0 === '--' ? 1 : 0)) vals.push(evalWord(w, st, 'collect'));
        st.positional = vals.map((alts) => ent(alts));
      }
    } else if (head === 'let') {
      for (const w of args) { const t = plainText(w); const m = t && /^([A-Za-z_]\w*)/.exec(t); if (m) setVar(st, m[1], [[unk('num')]], false, mode); }
    }
  }
  if (mode !== 'check') {
    // eval 'a=.env': assignments of literal code count too.
    if (head === 'eval' && args.every((w) => plainText(w) !== null)) {
      const code = args.map((w) => plainText(w)).join(' ');
      try { const sub = lex(code, st.ctx.home); runCommands(sub, st, 'collect'); } catch (_) { /* unreadable: the check pass refuses */ }
    }
    return;
  }
  // ---- check mode ----
  const writing = !READ_ONLY.has(head);
  // The words of the command, evaluated: resolved text goes to the path check, partly unknown words are judged.
  const spec = Object.prototype.hasOwnProperty.call(DUMP, head) ? DUMP[head] : null;
  let operandKeys = null;
  if (spec) {
    if (spec.dd) {
      operandKeys = new Set();
      args.forEach((w, k) => { const t = plainText(w); if ((t !== null && /^if=/.test(t)) || (w.parts[0] && w.parts[0].t === 'lit' && /^if=$/.test(w.parts[0].v) && w.parts.length > 1)) operandKeys.add(pi + 1 + k); });
    } else operandKeys = new Set(operandsOf(spec, head, cmd, pi, st).map((o) => o.k));
  }
  const evaluated = [];
  for (let k = 0; k < ws.length; k++) {
    if (k === pi || k < pi) {
      // prefix assignments are checked through their values; the program word is not a file
      if (k < pi && hasExpansion(ws[k])) { const items = evalWord(ws[k], st, 'check'); evaluated[k] = items; checkItems(st, items.map((it) => it), writing, false, head, false); }
      continue;
    }
    if (hasExpansion(ws[k])) {
      const items = evalWord(ws[k], st, 'check');
      evaluated[k] = items;
      const isOperand = operandKeys && operandKeys.has(k);
      const dd = spec && spec.dd && isOperand;
      const prev = k > 0 ? plainText(ws[k - 1]) : null;
      checkItems(st, items.map((it) => (dd && typeof it[0] === 'string' ? normItem([it[0].replace(/^if=/, '')].concat(it.slice(1))) : it)), writing, !!isOperand, head, false, prev !== null && !!FILE_OPTS[head] && FILE_OPTS[head].has(prev));
    }
  }
  // Redirects: a file read into a program that sends or shows it, a file written.
  for (const r of cmd.redirs) {
    if (!hasExpansion(r.target)) continue;
    const items = evalWord(r.target, st, 'check');
    const reading = r.op === '<' || r.op === '<>' || r.op === '<<<';
    if (r.op === '<<<') {
      // A here-string given to a shell is code.
      if (SHELLS.has(head) || head === 'source' || head === '.') codeCheck(st, [r.target], null, cmd);
      else checkItems(st, items.filter((it) => !hasUnk(it)), false, false, head, false);
      continue;
    }
    const senderish = reading && (spec || STDIN_SENDERS.has(head) || head === 'while' || head === '');
    checkItems(st, items, !reading, !!senderish, head, !reading);
  }
  if (out.refuse) return;
  // xargs: its operands are what the commands before it print.
  if (head === 'xargs') {
    xargsCheck(cmds, ci, cmd, pi, st);
    return;
  }
  // find ... -exec CMD {} +
  if (head === 'find') {
    const texts = cmd.words.slice(pi).map((w) => plainText(w));
    for (let k = 0; k < texts.length; k++) {
      if (texts[k] === '-exec' || texts[k] === '-execdir' || texts[k] === '-ok' || texts[k] === '-okdir') {
        const sub = { words: cmd.words.slice(pi + k + 1), redirs: [], pipeIn: false, heredocs: [] };
        const spi = programIndex(sub, st);
        const sname = spi >= 0 && plainText(sub.words[spi]) !== null ? base(plainText(sub.words[spi])) : '';
        const dump = Object.prototype.hasOwnProperty.call(DUMP, sname) || SHELLS.has(sname) || (sub.words[spi] && plainText(sub.words[spi]) === null);
        if (dump) {
          const r = findList(texts, st);
          if (r.bad) { out.refuse = protectedListMessage('the files find lists', r.bad.name); return; }
          if (!r.ok) { out.refuse = RUNTIME_NAME_MESSAGE; return; }
        }
        break;
      }
    }
  }
  // Shell code built at run time: eval, trap, sh -c, source of a process substitution.
  if (head === 'eval' || head === 'trap') {
    const codeWords = head === 'trap' ? args.slice(0, 1) : args;
    codeCheck(st, codeWords, null, cmd);
    return;
  }
  if (SHELLS.has(head) || head === 'su' || head === 'sg') {
    const sc = shellCodeOf(cmd, pi, st);
    if (sc) {
      const codeWord = ws[sc.code];
      const argWords = ws.slice(sc.args);
      codeCheck(st, [codeWord], argWords, cmd);
      return;
    }
    // A shell that reads its code from standard input (x | sh, sh < file, sh -s).
    const hasScript = args.some((w) => { const t = plainText(w); return t === null || (!t.startsWith('-') && !t.startsWith('+')); }) && !args.some((w) => plainText(w) === '-s');
    if (!hasScript && SHELLS.has(head) && (cmd.pipeIn || cmd.redirs.some((x) => x.op === '<'))) {
      const src = sourceOf(cmds, ci, st);
      if (src.items) {
        for (const it of src.items) if (!hasUnk(it)) out.codes.push({ text: it.join(''), vars: st.vars, positional: null });
          else { out.refuse = RUNTIME_CODE_MESSAGE; return; }
      } else if (src.unk && src.unk.kind === 'any' && !NET_SOURCES.has(src.unk.why)) { out.refuse = RUNTIME_CODE_MESSAGE; return; }
    }
  }
  heredocCodes(cmd, head, st);
}

/* The code of eval, sh -c and the like: read it when it is known, refuse it when it is not. */
function codeCheck(st, codeWords, argWords, cmd) {
  const out = st.out;
  if (!codeWords.length) return;
  const alts = [];
  const per = codeWords.map((w) => evalWord(w, st, 'check'));
  let combos = [[]];
  per.forEach((items, k) => {
    const next = [];
    for (const c of combos) for (const it of items) next.push(c.concat(k ? [' '] : [], it));
    combos = next.slice(0, MAX_BRANCHES);
  });
  for (const c of combos) alts.push(normItem(c));
  for (const it of alts) {
    // bash -c CODE arg0 arg1: $0 is arg0, $1 is arg1.
    if (!hasUnk(it)) { out.codes.push({ text: it.join(''), vars: st.vars, positional: argWords ? argWords.slice(1).map((w) => ent(evalWord(w, st, 'check'))) : null }); continue; }
    // The code is partly or wholly built from a value zn cannot read.
    const whole = it.every(isUnk);
    const safeAll = it.every((s) => !isUnk(s) || s.kind !== 'any');
    if (safeAll) continue;
    if (whole && it.length === 1 && it[0].why === 'init') continue;
    if (whole && cmd && codeFromInitTool(codeWords, st)) continue;
    if (whole) { out.refuse = RUNTIME_CODE_MESSAGE; return; }
    // Partly known code: read it with a variable standing for each unknown part, and keep the checks of that reading.
    const vars = new Map(st.vars);
    let text = '';
    let n = 0;
    for (const s of it) {
      if (typeof s === 'string') text += s;
      else { const nm = '__ZN_UNK' + (n++); vars.set(nm, ent([[s]])); text += '${' + nm + '}'; }
    }
    out.codes.push({ text, vars, positional: null });
  }
}

/* eval "$(ssh-agent -s)": the output of a well-known environment tool is not an agent's choice. */
function codeFromInitTool(codeWords, st) {
  for (const w of codeWords) {
    if (w.parts.length !== 1 || w.parts[0].t !== 'cmd') continue;
    let sub;
    try { sub = lex(w.parts[0].code, st.ctx.home); } catch (_) { return false; }
    if (sub.length !== 1) continue;
    const pi = programIndex(sub[0], st);
    if (pi < 0) continue;
    const t = plainText(sub[0].words[pi]);
    if (t !== null && EVAL_SAFE.has(base(t))) return true;
  }
  return false;
}

/* The body of a here-document given to a shell is code. */
function heredocCodes(cmd, head, st) {
  if (!cmd.heredocs.length) return;
  if (head !== null && !SHELLS.has(head) && head !== 'source' && head !== '.') return;
  for (const h of cmd.heredocs) st.out.codes.push({ text: h.body, vars: st.vars, positional: null });
}

function xargsCheck(cmds, ci, cmd, pi, st) {
  const out = st.out;
  const ws = cmd.words;
  // options of xargs
  const XVAL = new Set(['-n', '-L', '-P', '-s', '-E', '-e', '-I', '-d', '-a', '-l', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--delimiter', '--arg-file', '--replace', '--eof', '--process-slot-var']);
  let k = pi + 1;
  let argFile = false;
  let replace = null;
  for (; k < ws.length; k++) {
    const t = plainText(ws[k]);
    if (t === null) break;
    if (!t.startsWith('-') || t === '-') break;
    if (t === '--') { k++; break; }
    if (t === '-a' || t === '--arg-file') argFile = plainText(ws[k + 1]) || true;
    else if (/^--arg-file=/.test(t)) argFile = t.slice(11) || true;
    else if (/^-a./.test(t)) argFile = t.slice(2);
    if (t === '-I' || t === '--replace') replace = plainText(ws[k + 1]);
    else if (/^-I./.test(t)) replace = t.slice(2);
    else if (/^--replace=/.test(t)) replace = t.slice(10);
    else if (t === '-i') replace = '{}';
    if (XVAL.has(t)) k++;
  }
  const sub = { words: ws.slice(k), redirs: [], pipeIn: false, heredocs: [] };
  if (!sub.words.length) return;
  const spi = programIndex(sub, st);
  if (spi < 0) return;
  const sraw = plainText(sub.words[spi]);
  const sname = sraw === null ? '' : base(sraw);
  const src = argFile ? (typeof argFile === 'string' ? readList(argFile, st) : { unk: unk('any', { why: 'xargs -a' }) }) : sourceOf(cmds, ci, st);
  const dumpish = sraw === null || Object.prototype.hasOwnProperty.call(DUMP, sname) || SHELLS.has(sname) || sname === 'eval';
  // The source gives known names (echo a b | xargs cat): they are checked as words of the command.
  if (src.items) {
    for (const it of src.items) {
      if (hasUnk(it)) continue;
      for (const f of splitFields(it.join(''), st)) if (f) out.words.push({ text: f, redirectTarget: false, head: sname, seq: 1e6 + out.words.length });
    }
    return;
  }
  const u = src.unk;
  if (!dumpish) return;
  if (SHELLS.has(sname)) {
    // xargs sh -c 'cat "$1"' _ : the operands are the positional arguments of the code.
    const sc = shellCodeOf(sub, spi, st);
    if (sc) {
      const codeAlts = evalWord(sub.words[sc.code], st, 'check');
      for (const it of codeAlts) {
        if (hasUnk(it)) { out.refuse = RUNTIME_CODE_MESSAGE; return; }
        let text = it.join('');
        const vars = new Map(st.vars);
        if (replace) {
          vars.set('__ZN_XARG', ent([[u]]));
          text = text.split(replace).join('${__ZN_XARG}');
        }
        const pos = [ent([[u]])].concat(sub.words.slice(sc.args + 1).map((w) => ent(evalWord(w, st, 'check'))));
        out.codes.push({ text, vars, positional: [ent([[u]])].concat(pos.slice(1)), xargs: u });
      }
      return;
    }
  }
  if (u && u.kind === 'any') {
    out.refuse = u.bad ? protectedListMessage('the files that come before xargs', u.bad.name) : RUNTIME_NAME_MESSAGE;
  }
}

/* ------------------------------ entry point ------------------------------ */

const QUICK_RE = /[$`]|<<<|<\s*[^\s<(]|\|\s*&?\s*(?:[\w.-]+\/)*(?:ba|z|da|k|a|mk)?sh\b|\beval\b|\bxargs\b|-exec|-execdir|-ok\b|\bread\b|\bmapfile\b|\breadarray\b|<\(|>\(|\btrap\b|\bsource\b|^\s*\.\s|[;&|(]\s*\.\s|\bfor\b|\bwhile\b|\bprintf\b/;

/*
 * analyse(cmd, ctx) -> { refuse, words, codes }
 *   ctx: { home, cwd, env, fileDeny(abs), examples(writing), spend(n), vars?, positional? }
 *   refuse: a deny message, or null
 *   words: resolved words for the normal protected-path check: {text, head, redirectTarget, seq}
 *   codes: shell code the command runs, as {text, vars, positional}: each is read as a command of its own
 */
function analyse(cmd, ctx0, seed) {
  const ctx = Object.assign({}, ctx0, { cmdText: String(cmd) });
  const out = { refuse: null, words: [], codes: [] };
  if (!QUICK_RE.test(cmd)) return out;
  let cmds;
  work = 0;
  try { cmds = lex(cmd, ctx.home); } catch (e) {
    if (e instanceof TooComplex || (e && e.message === 'too many commands')) { out.refuse = TOO_COMPLEX_MESSAGE; return out; }
    throw e;
  }
  const st = {
    ctx,
    vars: new Map(seed && seed.vars ? seed.vars : []),
    positional: seed && seed.positional ? seed.positional : null,
    depth: seed && seed.depth ? seed.depth : 0,
    out,
    ifs: undefined,
    ifsUnknown: false,
  };
  work = 0;
  try {
    // Variables first, twice, so a value set later in a loop reaches an earlier use; then the checks.
    runCommands(cmds, st, 'collect');
    runCommands(cmds, st, 'collect');
    runCommands(cmds, st, 'check');
  } catch (e) {
    // A command that builds more than zn works through is refused, not checked in part.
    if (e instanceof TooComplex) { out.refuse = TOO_COMPLEX_MESSAGE; return out; }
    throw e;
  }
  // Two words with the same text and head are one.
  const seen = new Set();
  out.words = out.words.filter((w) => { const k = w.text + '\u0000' + w.head + '\u0000' + w.redirectTarget; if (seen.has(k)) return false; seen.add(k); return true; });
  return out;
}

module.exports = { analyse };
