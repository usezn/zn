'use strict';
/**
 * Custom secret formats from the organization policy (`detectors`), run by
 * the local scrubber next to the built-in patterns. They only add
 * redactions; they can never stop a built-in one.
 *
 * A pattern comes from the network, so it is treated as untrusted. A
 * JavaScript regular expression cannot be interrupted once it runs, so the
 * client only accepts a grammar whose cost is bounded before running it:
 *   - the same checks as the server: no nested quantifiers, no
 *     back-references, no lookaround, must compile, must not match "";
 *   - no unbounded repetition (`*`, `+`, `{n,}`): token formats have a
 *     known length, written as `{n}` or `{m,n}`;
 *   - at most two variable-length repetitions (`?` or `{m,n}` with m < n),
 *     each spanning at most 64, and n at most 256;
 *   - no repeated group with alternatives, such as (a|ab){2,4};
 *   - text is scanned in windows of at most 4096 characters (one line at a
 *     time, long lines split);
 *   - as a last guard, a detector whose run on one window takes longer than
 *     50 ms is switched off for the rest of the process.
 * Patterns the server accepts but this grammar does not are skipped here.
 * A value split across two windows of a very long line is not found by a
 * custom detector; the built-in layers are not affected.
 */

const WINDOW = 4096;
const SLOW_MS = 50;
const TYPE_RE = /^[A-Z0-9](?:[A-Z0-9_]{0,62}[A-Z0-9])?$/;
const ID_RE = /^[a-z0-9_]{1,64}$/;

const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;
const QUANTIFIED_ALTERNATION_RE = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{?]/;

const MAX_VARIABLE = 2;
const MAX_SPAN = 64;
const MAX_REPEAT = 256;

/* Walk the pattern and check every quantifier (outside character classes
 * and escapes). Returns a reason or null. */
function checkQuantifiers(p) {
  let variable = 0;
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '*' || ch === '+') return 'unbounded repetition (* or +) is not allowed; use {n} or {m,n}';
    if (ch === '?') {
      if (p[i - 1] === '(') continue;                       // (?: group syntax
      variable++;                                           // x? is a variable repetition
      continue;
    }
    if (ch === '{') {
      const m = /^\{(\d{1,3})(?:(,)(\d{0,3}))?\}/.exec(p.slice(i));
      if (!m) continue;                                     // a literal brace
      const lo = Number(m[1]);
      if (m[2] && m[3] === '') return 'unbounded repetition ({n,}) is not allowed';
      const hi = m[2] ? Number(m[3]) : lo;
      if (hi > MAX_REPEAT || hi < lo) return 'repetition bounds must be at most ' + MAX_REPEAT;
      if (hi > lo) {
        if (hi - lo > MAX_SPAN) return 'a variable repetition can span at most ' + MAX_SPAN;
        variable++;
      }
      i += m[0].length - 1;
      if (p[i + 1] === '?') i++;                            // lazy {m,n}?
    }
  }
  if (variable > MAX_VARIABLE) return 'at most ' + MAX_VARIABLE + ' variable-length repetitions are allowed';
  return null;
}

/** Why a pattern is refused, or null. */
function checkPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length < 4 || pattern.length > 256) return 'invalid length';
  if (NESTED_QUANTIFIER_RE.test(pattern)) return 'nested quantifiers are not allowed';
  const q = checkQuantifiers(pattern);
  if (q) return q;
  if (QUANTIFIED_ALTERNATION_RE.test(pattern)) return 'a repeated group with alternatives is not allowed';
  if (/\\[1-9]|\\k</.test(pattern)) return 'back-references are not allowed';
  if (/\(\?<?[=!]/.test(pattern)) return 'lookaround is not allowed';
  let re;
  try { re = new RegExp(pattern); } catch (err) { return 'invalid regular expression'; }
  if (re.test('')) return 'pattern must not match the empty string';
  return null;
}

/** compile(detectors) -> [{id, type, re}] for the ones that pass the checks. */
function compile(detectors) {
  const out = [];
  for (const d of Array.isArray(detectors) ? detectors.slice(0, 50) : []) {
    if (!d || !ID_RE.test(d.id || '') || !TYPE_RE.test(d.type || '') || checkPattern(d.pattern)) continue;
    out.push({ id: d.id, type: d.type, re: new RegExp(d.pattern, 'g'), off: false });
  }
  return out;
}

function* windows(text) {
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    for (let s = pos; s < end; s += WINDOW) yield [s, Math.min(end, s + WINDOW)];
    if (end === pos) yield [pos, pos];
    pos = end + 1;
  }
}

/** find(text, compiled) -> [{start, end, type, source: 'pattern', detector}] */
function find(text, compiled) {
  const spans = [];
  if (!compiled || compiled.length === 0 || typeof text !== 'string' || text.length === 0) return spans;
  for (const d of compiled) {
    if (d.off) continue;
    for (const [a, b] of windows(text)) {
      if (b - a < 1) continue;
      const chunk = text.slice(a, b);
      d.re.lastIndex = 0;
      const t0 = Date.now();
      let m;
      while ((m = d.re.exec(chunk)) !== null) {
        if (m[0].length === 0) { d.re.lastIndex++; continue; }
        spans.push({ start: a + m.index, end: a + m.index + m[0].length, type: d.type, source: 'pattern', detector: d.id });
      }
      if (Date.now() - t0 > SLOW_MS) { d.off = true; break; }
    }
  }
  return spans;
}

module.exports = { checkPattern, compile, find, WINDOW, MAX_VARIABLE, MAX_SPAN };
