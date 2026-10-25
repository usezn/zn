'use strict';

// Invisible-tolerant variants of the prompt-injection phrase rules.
//
// The stripped view ("ignoreall...") and the spaced view ("ig nore all...") each read one use of the invisible
// characters. A text that uses one as a space AND another inside a word ("ig<U+200B>nore<U+200B>all ...") fits
// neither. The variant built here accepts any invisible character after every element of the pattern, and in
// place of every whitespace element, so it matches that text on the original string. Python
// (zn_gate/rules.py) and Rust (src/prompt_guard/tolerant.rs) have the same transformer.
//
// A small tokenizer walks the pattern source: it knows escapes, character classes, groups, lookarounds and
// quantifiers, and never inserts inside a class or inside a negative lookahead or a lookbehind (a positive
// lookahead is read like any group).

const { BMP_CLASS, ASTRAL_CLASS } = require('./invisible');

const HAS_INVISIBLE_RE = new RegExp('[' + BMP_CLASS + ASTRAL_CLASS + ']', 'u');
const INVISIBLE_RUN_RE = new RegExp('[' + BMP_CLASS + ASTRAL_CLASS + ']+', 'gu');

function hasInvisible(text) {
  return HAS_INVISIBLE_RE.test(text);
}

// Every run of invisible characters becomes one character, so the optional gaps of a tolerant pattern never
// face a long run (the work stays linear however long the run is).
function collapseInvisibleRuns(text) {
  return text.replace(INVISIBLE_RUN_RE, '\u200B');
}

// A supplementary character is a surrogate pair in a pattern without the u flag.
const SURROGATE_ALT = '\\uDB40[\\uDC00-\\uDC7F\\uDD00-\\uDDEF]';
function invisibleAlt(unicode) {
  return unicode ? '[' + BMP_CLASS + ASTRAL_CLASS + ']' : '(?:[' + BMP_CLASS + ']|' + SURROGATE_ALT + ')';
}



function tolerantSource(source, flags = '') {
  const unicode = flags.includes('u') || flags.includes('v');
  const inv = invisibleAlt(unicode);
  const gap = inv + '*';
  const c = Array.from(source);
  const n = c.length;

  // Index after the escape that starts at i (c[i] is a backslash).
  function escapeEnd(i) {
    const k = c[i + 1];
    if (k === undefined) return i + 1;
    if (k === 'x') return Math.min(n, i + 4);
    if (k === 'u') {
      if (c[i + 2] === '{') { const e = c.indexOf('}', i + 3); return e < 0 ? n : e + 1; }
      return Math.min(n, i + 6);
    }
    if ((k === 'p' || k === 'P') && c[i + 2] === '{') { const e = c.indexOf('}', i + 3); return e < 0 ? n : e + 1; }
    if (k === 'k' && c[i + 2] === '<') { const e = c.indexOf('>', i + 3); return e < 0 ? n : e + 1; }
    if (k === 'c') return Math.min(n, i + 3);
    if (k >= '0' && k <= '9') { let j = i + 2; while (j < n && c[j] >= '0' && c[j] <= '9') j++; return j; }
    return i + 2;
  }

  // The class that opens at i: its end (exclusive), whether it is negated and whether it holds a space.
  function classInfo(i) {
    let j = i + 1;
    let negated = false;
    if (c[j] === '^') { negated = true; j++; }
    let ws = false;
    while (j < n && c[j] !== ']') {
      if (c[j] === '\\') {
        if (c[j + 1] === 's') ws = true;
        j = escapeEnd(j);
      } else {
        if (c[j] === ' ') ws = true;
        j++;
      }
    }
    return { end: Math.min(n, j + 1), negated, ws };
  }

  // The end (exclusive) of the group that opens at i, for a lookaround that is copied as it is.
  function groupEnd(i) {
    let depth = 0;
    let j = i;
    while (j < n) {
      if (c[j] === '\\') { j = escapeEnd(j); continue; }
      if (c[j] === '[') { j = classInfo(j).end; continue; }
      if (c[j] === '(') depth++;
      else if (c[j] === ')') { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    return n;
  }

  // The end of a quantifier at i (i itself when there is none), with its lazy or possessive suffix.
  function quantEnd(i) {
    let j = i;
    if (c[j] === '?' || c[j] === '*' || c[j] === '+') {
      j++;
    } else if (c[j] === '{') {
      let k = j + 1;
      let digits = 0;
      while (k < n && c[k] >= '0' && c[k] <= '9') { k++; digits++; }
      if (c[k] === ',') { k++; while (k < n && c[k] >= '0' && c[k] <= '9') { k++; digits++; } }
      if (c[k] === '}' && digits > 0) j = k + 1;
      else return i;
    } else {
      return i;
    }
    if (c[j] === '?' || c[j] === '+') j++;
    return j;
  }

  const wsAtom = (tok, quant) => '(?:' + tok + '|' + inv + ')' + quant + gap;
  const slice = (a, b) => c.slice(a, b).join('');

  let out = '';
  let i = 0;
  // One entry per open group: true for a positive lookahead, whose closing parenthesis gets no gap (it is
  // zero-width), but whose content is tolerant like the rest.
  const open = [];
  while (i < n) {
    const ch = c[i];
    if (ch === '\\') {
      const e = escapeEnd(i);
      const tok = slice(i, e);
      if (/^\\[bBAzZ]$/.test(tok)) { out += tok; i = e; continue; }
      const q = quantEnd(e);
      const quant = slice(e, q);
      out += (tok === '\\s' || tok === '\\ ') ? wsAtom(tok, quant) : tok + quant + gap;
      i = q;
      continue;
    }
    if (ch === '[') {
      const info = classInfo(i);
      const tok = slice(i, info.end);
      const q = quantEnd(info.end);
      const quant = slice(info.end, q);
      out += info.ws && !info.negated ? wsAtom(tok, quant) : tok + quant + gap;
      i = q;
      continue;
    }
    if (ch === '(') {
      if (c[i + 1] === '?' && c[i + 2] === '=') { out += '(?='; open.push(true); i += 3; continue; }
      const look = c[i + 1] === '?' && (c[i + 2] === '!' || (c[i + 2] === '<' && (c[i + 3] === '=' || c[i + 3] === '!')));
      if (look) {
        const e = groupEnd(i);
        const q = quantEnd(e);
        out += slice(i, q);
        i = q;
        continue;
      }
      if (c[i + 1] === '?' && c[i + 2] === '#') {
        const e = c.indexOf(')', i);
        const end = e < 0 ? n : e + 1;
        out += slice(i, end);
        i = end;
        continue;
      }
      // Inline flags such as (?i) change nothing about the elements.
      const flagsOnly = /^\(\?[a-zA-Z-]+\)/.exec(slice(i, Math.min(n, i + 12)));
      if (flagsOnly) { out += flagsOnly[0]; i += Array.from(flagsOnly[0]).length; continue; }
      // The group header: "(", "(?:", "(?<name>" or "(?i:".
      let j = i + 1;
      if (c[j] === '?') {
        j++;
        if (c[j] === ':') j++;
        else if (c[j] === '<') { const e = c.indexOf('>', j); j = e < 0 ? n : e + 1; }
        else { while (j < n && c[j] !== ':') j++; j++; }
      }
      out += slice(i, j);
      open.push(false);
      i = j;
      continue;
    }
    if (ch === ')') {
      const q = quantEnd(i + 1);
      out += ')' + slice(i + 1, q) + (open.pop() ? '' : gap);
      i = q;
      continue;
    }
    if (ch === '|' || ch === '^' || ch === '$') { out += ch; i++; continue; }
    if (ch === '.') {
      const q = quantEnd(i + 1);
      out += '.' + slice(i + 1, q) + gap;
      i = q;
      continue;
    }
    if (ch === '?' || ch === '*' || ch === '+') { out += ch; i++; continue; }
    const q = quantEnd(i + 1);
    const quant = slice(i + 1, q);
    out += ch === ' ' ? wsAtom(' ', quant) : ch + quant + gap;
    i = q;
  }
  return out;
}

// The tolerant variant of a RegExp, with the same flags.
function tolerantRegex(re) {
  return new RegExp(tolerantSource(re.source, re.flags), re.flags);
}

module.exports = { tolerantSource, tolerantRegex, hasInvisible, collapseInvisibleRuns };
