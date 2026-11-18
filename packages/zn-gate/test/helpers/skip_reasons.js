'use strict';
// Static check: every skipped test says why. Used by test/skip_reasons.test.js.
//
// A skipped test that prints "skipped" with no reason hides whether it is a platform limit, a
// missing tool or a known gap. node:test prints the reason only when the skip option (or the
// argument of t.skip) is a string, so this finds the places where it can never be one:
//   - `skip: <expr>` whose result never reads as a string (a bare condition such as
//     `process.platform === 'win32'`); write `cond && 'reason'` or `cond ? 'reason' : false`;
//   - `skip: NAME` where NAME is declared in the same file without a reason string;
//   - `skip: true` and `{ skip }`;
//   - t.skip() with no argument, or an empty string;
//   - test.skip(...), it.skip(...), describe.skip(...), which have no place for a reason.
// A string only counts as the reason when it is a result of the expression (after &&, ||, ??, ?
// or :), not when it is an operand of a comparison such as === 'win32'.

const PUNCT = ['===', '!==', '...', '&&=', '||=', '??=', '**=', '==', '!=', '<=', '>=', '&&', '||', '??', '=>', '?.', '++', '--', '+=', '-=', '*=', '/=', '**'];
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '&&', '||', '??', '=>', '===', '!==', '==', '!=', 'return', 'typeof', 'case', 'in', 'of']);

/** Split source into tokens: { t: 'id'|'str'|'num'|'p', v, line }. Comments are dropped. */
function tokenize(src, start, stopAtBrace, state) {
  const out = [];
  let i = start;
  let depth = 0;
  const n = src.length;
  const st = state || { line: 1 };
  const prevSig = () => (out.length ? out[out.length - 1] : null);
  while (i < n) {
    const c = src[i];
    if (c === '\n') { st.line += 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') st.line += 1; i += 1; }
      i += 2; continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') { while (i < n && src[i] !== '\n') i += 1; continue; }
    const line = st.line;
    if (c === '"' || c === "'") {
      let j = i + 1; let v = '';
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { v += src[j + 1] || ''; j += 2; } else { v += src[j]; j += 1; } }
      out.push({ t: 'str', v, line }); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let v = '';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { v += src[j + 1] || ''; if (src[j + 1] === '\n') st.line += 1; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          const inner = tokenize(src, j + 2, true, st);
          j = inner.end; v += '${}'; continue;
        }
        if (src[j] === '\n') st.line += 1;
        v += src[j]; j += 1;
      }
      out.push({ t: 'str', v, line }); i = j + 1; continue;
    }
    if (c === '/') {
      const p = prevSig();
      const regexOk = !p || (p.t === 'p' ? REGEX_PREV.has(p.v) : (p.t === 'id' && REGEX_PREV.has(p.v)));
      if (regexOk) {
        let j = i + 1; let cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j += 1;
        }
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        out.push({ t: 'num', v: '/re/', line }); i = j; continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < n && /[\w$]/.test(src[j])) j += 1;
      out.push({ t: 'id', v: src.slice(i, j), line }); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j += 1;
      out.push({ t: 'num', v: src.slice(i, j), line }); i = j; continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') { if (stopAtBrace && depth === 0) return { tokens: out, end: i + 1 }; depth -= 1; }
    const op = PUNCT.find((p) => src.startsWith(p, i));
    const v = op || c;
    out.push({ t: 'p', v, line }); i += v.length;
  }
  return { tokens: out, end: n };
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const RESULT_PREV = new Set(['&&', '||', '??', '?', ':']);
const TEST_FNS = /^(test|it|describe|suite)$/;

/** Tokens from `from` up to the depth-0 `,` `)` `]` `}` or `;` that ends the expression. */
function expression(tokens, from) {
  const out = [];
  let d = 0;
  for (let k = from; k < tokens.length; k += 1) {
    const tk = tokens[k];
    if (tk.t === 'p') {
      if (OPEN.has(tk.v)) d += 1;
      else if (CLOSE.has(tk.v)) { if (d === 0) break; d -= 1; }
      else if ((tk.v === ',' || tk.v === ';') && d === 0) break;
    }
    out.push(tk);
  }
  return out;
}

function hasReasonString(expr) {
  return expr.some((tk, k) => tk.t === 'str' && tk.v.trim() !== '' && (k === 0 || (expr[k - 1].t === 'p' && RESULT_PREV.has(expr[k - 1].v))));
}

/** Does the file declare NAME with an initializer that carries a reason string? */
function declaredWithReason(tokens, name) {
  for (let k = 1; k + 1 < tokens.length; k += 1) {
    if (tokens[k].t === 'id' && tokens[k].v === name && tokens[k + 1].v === '=' && tokens[k - 1].t === 'id' && /^(const|let|var)$/.test(tokens[k - 1].v)) {
      const init = expression(tokens, k + 2);
      if (hasReasonString(init)) return true;
      // An object such as { skip: cond && 'reason' } is judged where its skip: is written.
      if (init.length && init[0].v === '{') return true;
    }
  }
  return false;
}

/** Find the skips with no reason in one source text. Returns [{ line, why }]. */
function findUnreasoned(src) {
  const { tokens } = tokenize(String(src), 0, false);
  const found = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const tk = tokens[k];
    if (tk.t !== 'id' || tk.v !== 'skip') continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (prev && prev.v === '.') {
      const recv = tokens[k - 2];
      if (recv && recv.t === 'id' && TEST_FNS.test(recv.v)) {
        found.push({ line: tk.line, why: recv.v + '.skip has no place for a reason: use the skip option with a string' });
      } else if (next && next.v === '(') {
        const arg = expression(tokens, k + 2);
        if (arg.length === 0 || (arg.length === 1 && arg[0].t === 'str' && arg[0].v.trim() === '')) found.push({ line: tk.line, why: 't.skip() without a reason' });
      }
      continue;
    }
    if (!prev || (prev.v !== '{' && prev.v !== ',')) continue;
    if (next && next.v === ':') {
      const val = expression(tokens, k + 2);
      if (val.length === 0) found.push({ line: tk.line, why: 'skip: with no value' });
      else if (val.length === 1 && /^(false|undefined|null)$/.test(val[0].v)) continue;
      else if (val[0].t === 'id' && /^skipUnless/.test(val[0].v) && val[1] && val[1].v === '(') continue;
      else if (val.length === 1 && val[0].t === 'id' && val[0].v !== 'true') {
        if (!declaredWithReason(tokens, val[0].v)) found.push({ line: tk.line, why: 'skip: ' + val[0].v + ' where ' + val[0].v + ' has no reason string in this file' });
      } else if (!hasReasonString(val)) found.push({ line: tk.line, why: "skip: expression with no reason string (write cond && 'reason')" });
    } else if (next && declaredWithReason(tokens, 'skip')) {
      continue;
    } else if (next && ((prev.v === '{' && (next.v === ',' || next.v === '}')) || (prev.v === ',' && next.v === '}'))) {
      found.push({ line: tk.line, why: 'shorthand { skip } carries no reason' });
    }
  }
  return found;
}

module.exports = { findUnreasoned, tokenize };
