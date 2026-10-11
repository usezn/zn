'use strict';
/**
 * Minimal scrubber engine for tests, shaped like lib/scrub/engine.js in the
 * contract. Exact values come from the fake vault; a handful of prefix
 * patterns stand in for the real ~30. It is a test double only: the real
 * engine (and its quality gates) belong to the scrub/ package.
 */

const PATTERNS = [
  ['AWS_KEY', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GITHUB_TOKEN', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['ANTHROPIC_KEY', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['STRIPE_KEY', /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g],
  ['DB_PASSWORD', /(?<=\b[a-z+]+:\/\/[^:/\s@]*:)(?!__ZN_)[^@/\s]{4,}(?=@)/g],
];

const RESTORE = new Set(['assistant', 'write_ignored', 'bash_local']);

function spansOf(text, ctx) {
  const spans = [];
  const exact = ctx && ctx.vault && typeof ctx.vault._exactSync === 'function' ? ctx.vault._exactSync() : [];
  for (const { name, value } of exact.sort((a, b) => b.value.length - a.value.length)) {
    if (value.length < 8) continue;
    let i = text.indexOf(value);
    while (i !== -1) {
      spans.push({ start: i, end: i + value.length, type: name, source: 'exact', name });
      i = text.indexOf(value, i + value.length);
    }
  }
  for (const [type, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ start, end, type, source: 'pattern' });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function scan(text, ctx) {
  return spansOf(String(text), ctx);
}

async function tokenize(text, ctx) {
  const s = String(text);
  const spans = spansOf(s, ctx);
  let out = '';
  let last = 0;
  const replaced = [];
  for (const sp of spans) {
    const token = sp.source === 'exact'
      ? '__ZN_' + sp.name + '__'
      : await ctx.vault.mapToken(ctx.project, sp.type, s.slice(sp.start, sp.end));
    out += s.slice(last, sp.start) + token;
    last = sp.end;
    replaced.push({ type: sp.type, token, source: sp.source });
  }
  out += s.slice(last);
  return { text: out, replaced };
}

async function detokenize(text, ctx) {
  const s = String(text);
  const restored = [];
  const withheld = [];
  let out = s;
  for (const m of s.matchAll(/__ZN_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_\d+)__/g)) {
    if (!RESTORE.has(ctx.destination)) {
      withheld.push({ token: m[0], reason: 'destination ' + ctx.destination });
      continue;
    }
    const v = await ctx.vault.resolve(ctx.project, m[0]);
    if (v == null) { withheld.push({ token: m[0], reason: 'unknown token' }); continue; }
    out = out.split(m[0]).join(v);
    restored.push(m[0]);
  }
  return { text: out, restored, withheld };
}

module.exports = { scan, tokenize, detokenize };
