'use strict';
// Shared by the ReDoS sweep: finds the regex literals of a JavaScript file (a
// text lexer, not a parser) and builds long adversarial inputs for them. Also
// counts `new RegExp(` sites, so a dynamically built pattern cannot escape the
// sweep without the test noticing.

const BS = String.fromCharCode(92);
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of']);
const SIZE = 50000;

function scanJs(src) {
  const literals = [];
  const ctors = [];
  const n = src.length;
  let i = src.startsWith('#!') ? (src.indexOf('\n') + 1 || n) : 0;
  let last = null;
  const lineOf = (p) => src.slice(0, p).split('\n').length;

  const regexAllowed = () => {
    if (!last) return true;
    if (last.type === 'punc') return last.v !== ')' && last.v !== ']';
    if (last.type === 'id') return REGEX_AFTER.has(last.v);
    return false;
  };
  const skipQuoted = (q) => {
    i++;
    while (i < n && src[i] !== q) i += src[i] === BS ? 2 : 1;
    i++;
  };
  const skipTemplate = () => {
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === BS) i += 2;
      else if (src[i] === '$' && src[i + 1] === '{') { i += 2; codeUntilBrace(); }
      else i++;
    }
    i++;
  };
  const codeUntilBrace = () => {
    let depth = 0;
    while (i < n) {
      if (src[i] === '{') { depth++; i++; continue; }
      if (src[i] === '}') { i++; if (depth === 0) return; depth--; continue; }
      lexOne();
    }
  };
  const lexOne = () => {
    const c = src[i];
    if (/\s/.test(c)) { i++; return; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; return; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; return; }
    if (c === '"' || c === "'") { skipQuoted(c); last = { type: 'str' }; return; }
    if (c === '`') { skipTemplate(); last = { type: 'str' }; return; }
    if (c === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      let closed = false;
      while (i < n && src[i] !== '\n') {
        const d = src[i];
        if (d === BS) { i += 2; continue; }
        if (inClass) { if (d === ']') inClass = false; }
        else if (d === '[') inClass = true;
        else if (d === '/') { closed = true; break; }
        i++;
      }
      if (closed) {
        const body = src.slice(start + 1, i);
        i++;
        const f0 = i;
        while (i < n && /[a-z]/.test(src[i])) i++;
        literals.push({ line: lineOf(start), body, flags: src.slice(f0, i) });
        last = { type: 'regex' };
        return;
      }
      i = start + 1;
      last = { type: 'punc', v: '/' };
      return;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
      const word = src.slice(s, i);
      if (word === 'RegExp' && last && last.type === 'id' && last.v === 'new') ctors.push({ line: lineOf(s) });
      last = { type: 'id', v: word };
      return;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9A-Za-z_.]/.test(src[i])) i++;
      last = { type: 'num' };
      return;
    }
    last = { type: 'punc', v: c };
    i++;
  };
  while (i < n) lexOne();
  return { literals, ctors };
}

const fill = (unit, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

// Characters a class admits, read literally (escapes and ranges are skipped).
function classChars(body) {
  const chars = [];
  const re = /\[((?:\\.|[^\]\\])*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const inner = m[1];
    for (let k = 0; k < inner.length && chars.length < 16; k++) {
      if (inner[k] === BS || inner[k + 1] === '-') { k++; continue; }
      if (inner[k] !== '^') chars.push(inner[k]);
    }
  }
  return [...new Set(chars)];
}

// Runs of literal text in a pattern ("ignore", "sk-", "Invoke-WebRequest").
function literalWords(body) {
  const words = body.match(/[^\\[\](){}|*+?.^$,=!<>:#&/-]{2,}/gu) || [];
  return [...new Set(words)].slice(0, 8);
}

// Adversarial inputs of `size` characters (default 50k) for one pattern body:
// repeated units, repeated almost-matches (the pattern's own words with the last
// character broken), long whitespace runs, nested quotes and brackets, and runs
// of the characters its classes admit.
function adversarialInputs(body, size = SIZE) {
  const out = new Set();
  const add = (s) => out.add(s);
  const f = (unit) => fill(unit, size);
  const units = [' ', '\n', '\t', '\r\n', 'a', 'A', '0', '-', '_', '.', '/', BS, '"', "'", '`',
    '(', ')', '[', ']', '{', '}', '<', '>', '$', '*', '+', '?', '|', '&', ';', ',', ':', '#', '%',
    '=', '!', '@', '~', 'ab', 'a-', 'a.', 'a/', BS + '"', '"\'', '--a ', 'é', '忽略', 'забудь ',
    '​', '‮', 'ignore ', 'sk-', 'eyJ', 'aB3dE5fG7h/', 'A_TOKEN=', '<a x=', '![', '/*'];
  for (const u of units) { add(f(u)); add(f(u) + '!'); }
  for (const w of literalWords(body)) {
    add(f(w));
    add(f(w.slice(0, -1)) + '#');
    add(f(w + ' ') + '#');
    add(f(' ' + w) + '!');
    add(f(w + '\n') + '!');
  }
  for (const c of classChars(body)) add(f(c) + '!');
  const all = classChars(body).join('');
  if (all) { add(f(all)); add(f(all) + '!'); }
  add(f(body.slice(0, 24)));
  add(f(body.slice(0, 24)) + '!');
  add(' '.repeat(size - 1) + '!');
  add(' '.repeat(size / 2) + 'x'.repeat(size / 2) + '!');
  return [...out];
}

// Fastest of `runs` timings of one match over `input` (ms). The regex is built
// outside the timed block; global patterns are run through replace() so every
// match is visited, as the callers that loop over matches do.
function timeMatch(body, flags, input, runs = 2) {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const re = new RegExp(body, flags);
    const t0 = process.hrtime.bigint();
    if (flags.includes('g')) input.replace(re, '');
    else re.test(input);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

// Times literals in a worker with a hard cap per literal, so a pattern that
// backtracks for minutes is reported as an offender instead of hanging the test
// run until the CI job times out.
class GuardedTimer {
  constructor(capMs) {
    this.capMs = capMs;
    this.worker = null;
  }

  start() {
    const { Worker } = require('worker_threads');
    this.sab = new SharedArrayBuffer(16);
    this.state = new Int32Array(this.sab, 0, 2);
    this.result = new Float64Array(this.sab, 8, 1);
    this.worker = new Worker(require('path').join(__dirname, 'regex_sweep_worker.js'), { workerData: { sab: this.sab } });
  }

  // -> { ms, input } with the worst time and the start of that input, or
  //    { ms: Infinity, timedOut: true } when the literal ran past capMs.
  worst(body, flags, size, limitMs) {
    if (!this.worker) this.start();
    Atomics.store(this.state, 0, 0);
    this.worker.postMessage({ body, flags, size, limitMs });
    if (Atomics.wait(this.state, 0, 0, this.capMs) === 'timed-out' && Atomics.load(this.state, 0) === 0) {
      this.worker.terminate();
      this.worker = null;
      return { ms: Infinity, timedOut: true, input: '' };
    }
    const index = Atomics.load(this.state, 1);
    const inputs = index >= 0 ? Array.from(adversarialInputs(body, size)) : [];
    return { ms: this.result[0], input: index >= 0 ? inputs[index].slice(0, 16) : '' };
  }

  close() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

module.exports = { scanJs, adversarialInputs, timeMatch, fill, SIZE, GuardedTimer };
