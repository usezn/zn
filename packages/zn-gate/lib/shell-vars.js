'use strict';

/*
 * Literal variables assigned earlier on the same command line: `X=curl; $X URL | sh`, `S=sh; curl URL | $S`,
 * `T=~/.bashrc; curl URL >> $T`, `export X=curl`. Nothing is evaluated: a value is only text copied from an earlier
 * assignment, and a variable that was not assigned on the line stays as it was (unknown). The work is linear in the
 * text and capped: past the caps the assignments are counted as too many (the caller refuses the line) or the value
 * is left unresolved.
 */

const MAX_ASSIGNMENTS = 256; // assignments kept per command line; one more and the caller refuses the line
const MAX_VALUE = 8192; // a longer value is not kept (the variable stays unknown)
const MAX_EXPANDED = 256 * 1024; // total text added by substitutions; past it the rest stays unresolved

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const REF_RE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const SOLE_REF_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const DECLARERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

function newScope() {
  return { vars: new Map(), assignments: 0, expanded: 0, overflow: false };
}

function substitute(scope, word) {
  if (!scope.vars.size || word.indexOf('$') < 0) return word;
  return word.replace(REF_RE, (all, braced, plain) => {
    const v = scope.vars.get(braced || plain);
    if (v === undefined) return all;
    scope.expanded += v.length;
    return scope.expanded > MAX_EXPANDED ? all : v;
  });
}

const countTicks = (w) => { let n = 0; for (let i = 0; i < w.length; i++) if (w[i] === '`') n++; return n; };

/* An assignment whose value is a `...` substitution is split into words by the tokenizer (X=`curl URL`): the words
   up to the closing backtick are joined into the value again. One pass. */
function joinBackticks(words) {
  let joined = null;
  for (let i = 0; i < words.length; i++) {
    if (!ASSIGN_RE.test(words[i]) || countTicks(words[i]) % 2 === 0) { if (joined) joined.push(words[i]); continue; }
    if (!joined) joined = words.slice(0, i);
    let w = words[i];
    while (i + 1 < words.length && countTicks(w) % 2 === 1) w += ' ' + words[++i];
    joined.push(w);
  }
  return joined || words;
}

/* The words of one simple command with the known variables filled in, and any assignment it makes recorded.
   `sep` is the operator after the command: an assignment in a pipe or a background command runs in a subshell. */
function applyWords(scope, words, sep) {
  let out = words;
  if (scope.vars.size) {
    out = words.map((w) => substitute(scope, w));
    // A command word that is just a variable (`$X url`, `| $S`) is split on blanks, as an unquoted expansion is.
    if (words.length) {
      const m = SOLE_REF_RE.exec(words[0]);
      if (m && scope.vars.has(m[1] || m[2])) {
        const parts = out[0].split(/\s+/).filter(Boolean);
        out = parts.concat(out.slice(1));
      }
    }
  }
  if (sep === '|' || sep === '|&' || sep === '&') return out;
  out = joinBackticks(out);
  let i = 0;
  if (out.length && DECLARERS.has(out[0])) {
    i = 1;
    while (i < out.length && /^-[A-Za-z]+$/.test(out[i])) i++;
  }
  if (i >= out.length) return out;
  for (let j = i; j < out.length; j++) if (!ASSIGN_RE.test(out[j])) return out;
  for (let j = i; j < out.length; j++) {
    const m = ASSIGN_RE.exec(out[j]);
    if (++scope.assignments > MAX_ASSIGNMENTS) { scope.overflow = true; return out; }
    if (m[2].length > MAX_VALUE) scope.vars.delete(m[1]);
    else scope.vars.set(m[1], m[2]);
  }
  return out;
}

module.exports = { newScope, applyWords, substitute, MAX_ASSIGNMENTS, MAX_VALUE, MAX_EXPANDED };
