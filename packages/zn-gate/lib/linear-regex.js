'use strict';

// Linear-time matcher for the custom patterns of a project (.znrules, zn.config.json).
//
// A project's own pattern must never be able to hang the hook that checks every
// command, so it is not compiled with the JavaScript RegExp engine, whose
// backtracking can take exponential time. This file accepts a safe subset of the
// syntax and runs it as an NFA simulation: the time is proportional to the input
// length times the pattern size, whatever the pattern is.
//
// Accepted: literals, `.`, classes `[a-z]` `[^x]`, `\d \w \s` (and the negations),
// `\b \B`, `^`, `$`, groups `( )` and `(?: )`, alternation `|`, and the quantifiers
// `? * + {n} {n,} {n,m}` (a trailing `?` for a lazy match is accepted and has no
// effect on whether a text matches). Matching is always case-insensitive, as before.
// Rejected, with a message that says why: backreferences, lookahead and lookbehind,
// named groups, `\p{..}`, flags, a quantifier on a group that already holds a
// quantifier (`(a+)+`), repeat counts above MAX_REPEAT, and patterns that are too
// long or too large once the counted repeats are expanded.

const MAX_PATTERN_LENGTH = 500;
const MAX_PATTERNS = 100;
const MAX_REPEAT = 100;
const MAX_PROGRAM = 4000;

class UnsupportedPattern extends Error {}

const WS = new Set([9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const isWs = (c) => WS.has(c) || (c >= 0x2000 && c <= 0x200a);
const isDigit = (c) => c >= 48 && c <= 57;
const isWord = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isLineEnd = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

// ---- parser ---------------------------------------------------------------

function fail(msg) { throw new UnsupportedPattern(msg); }

function parse(src) {
  let i = 0;
  const peek = () => src[i];

  function parseAlt() {
    const branches = [parseSeq()];
    while (peek() === '|') { i++; branches.push(parseSeq()); }
    return branches.length === 1 ? branches[0] : { t: 'alt', branches };
  }

  function parseSeq() {
    const items = [];
    while (i < src.length && peek() !== '|' && peek() !== ')') {
      let atom = parseAtom();
      const q = parseQuant();
      if (q) {
        if (atom.t === 'assert') fail('a quantifier cannot follow ^, $ or \\b');
        if (q.max > 1 && hasRepeat(atom)) fail('a quantifier on a group that already contains a quantifier (for example (a+)+) is not allowed: it can take exponential time');
        atom = { t: 'rep', child: atom, min: q.min, max: q.max };
      }
      items.push(atom);
    }
    return { t: 'seq', items };
  }

  function hasRepeat(n) {
    if (n.t === 'rep') return n.max > 1 || hasRepeat(n.child);
    if (n.t === 'seq') return n.items.some(hasRepeat);
    if (n.t === 'alt') return n.branches.some(hasRepeat);
    return false;
  }

  function parseQuant() {
    const c = peek();
    let q = null;
    if (c === '*') { i++; q = { min: 0, max: Infinity }; }
    else if (c === '+') { i++; q = { min: 1, max: Infinity }; }
    else if (c === '?') { i++; q = { min: 0, max: 1 }; }
    else if (c === '{') {
      const m = /^\{(\d{1,6})(?:(,)(\d{0,6}))?\}/.exec(src.slice(i));
      if (m) {
        const min = Number(m[1]);
        const max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
        if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) fail('a repeat count above ' + MAX_REPEAT + ' is not allowed');
        if (max < min) fail('the repeat count {' + min + ',' + max + '} is out of order');
        i += m[0].length;
        q = { min, max };
      }
    }
    if (q && peek() === '?') i++; // lazy: same set of matching texts
    if (q && (peek() === '*' || peek() === '+' || peek() === '?')) fail('two quantifiers in a row');
    return q;
  }

  function parseAtom() {
    const c = src[i];
    if (c === '(') {
      i++;
      if (src[i] === '?') {
        if (src.startsWith('?:', i)) i += 2;
        else if (src.startsWith('?=', i) || src.startsWith('?!', i)) fail('lookahead (?= ) and (?! ) are not supported');
        else if (src.startsWith('?<=', i) || src.startsWith('?<!', i)) fail('lookbehind is not supported');
        else if (src.startsWith('?<', i)) fail('named groups are not supported');
        else fail('this group syntax is not supported');
      }
      const inner = parseAlt();
      if (src[i] !== ')') fail('a group is not closed');
      i++;
      return inner;
    }
    if (c === ')') fail('an unmatched )');
    if (c === '*' || c === '+' || c === '?') fail('a quantifier has nothing to repeat');
    if (c === '[') return parseClass();
    if (c === '.') { i++; return { t: 'set', test: (x) => !isLineEnd(x) }; }
    if (c === '^') { i++; return { t: 'assert', kind: 'bol' }; }
    if (c === '$') { i++; return { t: 'assert', kind: 'eol' }; }
    if (c === '\\') return parseEscape(false);
    i++;
    return literal(c.charCodeAt(0));
  }

  function literal(code) {
    const ch = String.fromCharCode(code);
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    const set = new Set([code]);
    if (lo.length === 1) set.add(lo.charCodeAt(0));
    if (up.length === 1) set.add(up.charCodeAt(0));
    return { t: 'set', test: (x) => set.has(x) };
  }

  // Returns a node (outside a class) or a {code}|{test} item (inside one).
  function parseEscape(inClass) {
    i++; // the backslash
    const c = src[i];
    if (c === undefined) fail('a pattern cannot end with a backslash');
    i++;
    const wrap = (test) => (inClass ? { test } : { t: 'set', test });
    switch (c) {
      case 'd': return wrap(isDigit);
      case 'D': return wrap((x) => !isDigit(x));
      case 'w': return wrap(isWord);
      case 'W': return wrap((x) => !isWord(x));
      case 's': return wrap(isWs);
      case 'S': return wrap((x) => !isWs(x));
      case 'b':
        if (inClass) return { code: 8 };
        return { t: 'assert', kind: 'wb' };
      case 'B':
        if (inClass) fail('\\B is not allowed inside a class');
        return { t: 'assert', kind: 'nwb' };
      case 't': return code(9);
      case 'n': return code(10);
      case 'r': return code(13);
      case 'f': return code(12);
      case 'v': return code(11);
      case '0':
        if (isDigit((src.charCodeAt(i)))) fail('octal escapes are not supported');
        return code(0);
      case 'x': {
        const m = /^[0-9a-fA-F]{2}/.exec(src.slice(i));
        if (!m) fail('a bad \\x escape');
        i += 2;
        return code(parseInt(m[0], 16));
      }
      case 'u': {
        const m = /^[0-9a-fA-F]{4}/.exec(src.slice(i));
        if (!m) fail('a bad \\u escape');
        i += 4;
        return code(parseInt(m[0], 16));
      }
      case 'p': case 'P': fail('\\p{..} classes are not supported');
      // eslint-disable-next-line no-fallthrough
      case 'k': fail('named backreferences are not supported');
      // eslint-disable-next-line no-fallthrough
      case 'c': fail('\\c escapes are not supported');
      // eslint-disable-next-line no-fallthrough
      default:
        if (c >= '1' && c <= '9') fail('backreferences (\\1 ...) are not supported');
        if (/[A-Za-z]/.test(c)) fail('the escape \\' + c + ' is not supported');
        return code(c.charCodeAt(0));
    }
    function code(n) { return inClass ? { code: n } : literal(n); }
  }

  function parseClass() {
    i++; // [
    let negate = false;
    if (src[i] === '^') { negate = true; i++; }
    const items = [];
    let closed = false;
    while (i < src.length) {
      if (src[i] === ']') { i++; closed = true; break; }
      const a = classAtom();
      if (src[i] === '-' && src[i + 1] !== ']' && src[i + 1] !== undefined && a.code !== undefined) {
        i++;
        const b = classAtom();
        if (b.code === undefined) fail('a class range ends in a class escape');
        if (b.code < a.code) fail('a class range is out of order');
        items.push({ lo: a.code, hi: b.code });
      } else if (a.code !== undefined) items.push({ lo: a.code, hi: a.code });
      else items.push(a);
    }
    if (!closed) fail('a class is not closed');
    const hit = (x) => items.some((it) => (it.test ? it.test(x) : x >= it.lo && x <= it.hi));
    const test = (x) => {
      if (hit(x)) return true;
      const ch = String.fromCharCode(x);
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      return (lo.length === 1 && hit(lo.charCodeAt(0))) || (up.length === 1 && hit(up.charCodeAt(0)));
    };
    return { t: 'set', test: negate ? (x) => !test(x) : test };
  }

  function classAtom() {
    if (src[i] === '\\') return parseEscape(true);
    const code = src.charCodeAt(i);
    i++;
    return { code };
  }

  const ast = parseAlt();
  if (i < src.length) fail('an unmatched )');
  return ast;
}

// ---- compiler (Thompson NFA) ---------------------------------------------

const CHAR = 0; const SPLIT = 1; const JMP = 2; const ASSERT = 3; const MATCH = 4;

function compileProgram(ast) {
  const op = []; const x = []; const y = [];
  const push = (o, a, b) => {
    if (op.length >= MAX_PROGRAM) fail('the pattern is too large once its repeat counts are expanded');
    op.push(o); x.push(a); y.push(b);
    return op.length - 1;
  };
  function emit(n) {
    switch (n.t) {
      case 'set': push(CHAR, n.test, 0); break;
      case 'assert': push(ASSERT, n.kind, 0); break;
      case 'seq': n.items.forEach(emit); break;
      case 'alt': {
        const jumps = [];
        for (let b = 0; b < n.branches.length; b++) {
          if (b < n.branches.length - 1) {
            const s = push(SPLIT, 0, 0);
            x[s] = op.length;
            emit(n.branches[b]);
            jumps.push(push(JMP, 0, 0));
            y[s] = op.length;
          } else emit(n.branches[b]);
        }
        for (const j of jumps) x[j] = op.length;
        break;
      }
      case 'rep': {
        for (let k = 0; k < n.min; k++) emit(n.child);
        if (n.max === Infinity) {
          const s = push(SPLIT, 0, 0);
          x[s] = op.length;
          emit(n.child);
          push(JMP, s, 0);
          y[s] = op.length;
        } else {
          const splits = [];
          for (let k = n.min; k < n.max; k++) {
            const s = push(SPLIT, 0, 0);
            x[s] = op.length;
            splits.push(s);
            emit(n.child);
          }
          for (const s of splits) y[s] = op.length;
        }
        break;
      }
      default: fail('internal error');
    }
  }
  emit(ast);
  push(MATCH, 0, 0);
  return { op, x, y };
}

function makeMatcher(prog) {
  const { op, x, y } = prog;
  const size = op.length;
  const mark = new Int32Array(size);
  const stack = new Int32Array(size * 2 + 2);
  let clist = new Int32Array(size);
  let nlist = new Int32Array(size);

  return function test(s) {
    const n = s.length;
    mark.fill(0);
    let cn = 0;
    let nn = 0;
    // Adds the closure of `pc0` at position `pos`; returns true when MATCH is reached.
    function add(list, count, pc0, pos) {
      const tag = pos + 1;
      const prev = pos > 0 ? s.charCodeAt(pos - 1) : -1;
      const next = pos < n ? s.charCodeAt(pos) : -1;
      let sp = 0;
      stack[sp++] = pc0;
      while (sp > 0) {
        const pc = stack[--sp];
        if (mark[pc] === tag) continue;
        mark[pc] = tag;
        switch (op[pc]) {
          case JMP: stack[sp++] = x[pc]; break;
          case SPLIT: stack[sp++] = y[pc]; stack[sp++] = x[pc]; break;
          case ASSERT: {
            const k = x[pc];
            let ok;
            if (k === 'bol') ok = pos === 0;
            else if (k === 'eol') ok = pos === n;
            else {
              const a = prev >= 0 && isWord(prev);
              const b = next >= 0 && isWord(next);
              ok = k === 'wb' ? a !== b : a === b;
            }
            if (ok) stack[sp++] = pc + 1;
            break;
          }
          case MATCH: return -1;
          default: list[count++] = pc;
        }
      }
      return count;
    }
    for (let pos = 0; pos <= n; pos++) {
      cn = add(clist, cn, 0, pos);
      if (cn === -1) return true;
      if (pos === n) break;
      const c = s.charCodeAt(pos);
      nn = 0;
      // Threads that read char `pos` move to the closure at pos + 1.
      const stepped = [];
      for (let k = 0; k < cn; k++) {
        const pc = clist[k];
        if (x[pc](c)) stepped.push(pc + 1);
      }
      for (const pc of stepped) {
        nn = add(nlist, nn, pc, pos + 1);
        if (nn === -1) return true;
      }
      const t = clist; clist = nlist; nlist = t;
      cn = nn;
    }
    return false;
  };
}

// ---- public API -----------------------------------------------------------

/**
 * Compiles one custom pattern. Returns { ok: true, rule } where rule has `source`
 * and `test(text)`, or { ok: false, error } with a message for the user.
 */
function compileCustomPattern(source) {
  if (typeof source !== 'string') return { ok: false, error: 'a pattern must be a string' };
  if (source.length === 0) return { ok: false, error: 'a pattern cannot be empty' };
  if (source.length > MAX_PATTERN_LENGTH) return { ok: false, error: 'the pattern is longer than ' + MAX_PATTERN_LENGTH + ' characters' };
  try {
    const matcher = makeMatcher(compileProgram(parse(source)));
    return { ok: true, rule: { source, test: matcher } };
  } catch (err) {
    if (err instanceof UnsupportedPattern) return { ok: false, error: err.message };
    throw err;
  }
}

module.exports = { compileCustomPattern, MAX_PATTERN_LENGTH, MAX_PATTERNS };
