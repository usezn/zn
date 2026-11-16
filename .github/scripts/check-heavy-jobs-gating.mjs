#!/usr/bin/env node
// Proves that the heavy required checks of a pull request into next run only in the merge queue, or when the
// pull request has the full-ci label, and that every required check still reports under its exact name.
//
//   node .github/scripts/check-heavy-jobs-gating.mjs [repository-root]     default: the current directory
//
// The heavy checks are Node.js 18.x, 22.x and 24.x, Python 3.12 (ubuntu-latest), and "build, test, clippy, fmt".
// A job skipped by its `if` reports under its literal name, as skipped, and a skipped job counts as passed for a
// required check; a matrix job skipped that way reports under its unexpanded name and leaves the check pending.
// So each heavy job must have a literal name (no `${{`). The check evaluates the job-level `if` of each heavy
// and light job for each event, with a small evaluator of the expression subset the workflows use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The eleven required checks of a pull request into next, as they appear on the pull request. */
export const REQUIRED = [
  'Node.js 18.x tests & benchmarks',
  'Node.js 22.x tests & benchmarks',
  'Node.js 24.x tests & benchmarks',
  'Python 3.12 tests & benchmarks (ubuntu-latest)',
  'Python package (build, twine check, install)',
  'npm package (pack, inspect, install)',
  'leak bench (node 22 / ubuntu-latest)',
  'scrubber + vault (node 22 / ubuntu-latest)',
  'Lint (eslint, ruff, mypy)',
  'Public facts',
  'build, test, clippy, fmt',
];

/** Heavy: skipped on a pull request into next without the label. Light: always run on a pull request. */
export const HEAVY = [
  { file: 'ci.yml', name: 'Node.js 18.x tests & benchmarks' },
  { file: 'ci.yml', name: 'Node.js 22.x tests & benchmarks' },
  { file: 'ci.yml', name: 'Node.js 24.x tests & benchmarks' },
  { file: 'ci.yml', name: 'Python 3.12 tests & benchmarks (ubuntu-latest)' },
  { file: 'rust.yml', name: 'build, test, clippy, fmt' },
];
export const LIGHT = [
  { file: 'ci.yml', name: 'Lint (eslint, ruff, mypy)' },
  { file: 'ci.yml', name: 'npm package (pack, inspect, install)' },
  { file: 'ci.yml', name: 'Python package (build, twine check, install)' },
];

/* ---------- the jobs of a workflow file (read line by line, no YAML library) ---------- */

/** Returns [{ id, name, if }] for the jobs of a workflow's text; `if` is the raw expression or null. */
export function jobsOf(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    let m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) { cur = { id: m[1], name: null, if: null }; jobs.push(cur); continue; }
    if (!cur) continue;
    m = l.match(/^ {4}name:\s*(.*?)\s*$/);
    if (m) { cur.name = unquote(m[1]); continue; }
    m = l.match(/^ {4}if:\s*(.*?)\s*$/);
    if (m) cur.if = unquote(m[1]);
  }
  return jobs;
}

function unquote(s) {
  return /^(["']).*\1$/.test(s) && !s.startsWith("'${{") ? s.slice(1, -1) : s;
}

/* ---------- a small evaluator of the expressions in `if:` ---------- */

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1, out = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { out += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        out += src[j++];
      }
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!='].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('!(),'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.*-]*/);
    if (!m) throw new Error(`cannot read the expression at: ${src.slice(i, i + 30)}`);
    toks.push({ t: 'id', v: m[0] });
    i += m[0].length;
  }
  return toks;
}

function lookup(ctx, dotted) {
  if (dotted === 'true') return true;
  if (dotted === 'false') return false;
  if (dotted === 'null') return null;
  const parts = dotted.split('.');
  let v = ctx;
  for (let k = 0; k < parts.length; k++) {
    if (v == null) return null;
    if (parts[k] === '*') {
      const rest = parts.slice(k + 1);
      return (Array.isArray(v) ? v : []).map((x) => rest.reduce((a, p) => (a == null ? null : a[p]), x));
    }
    v = v[parts[k]];
  }
  return v === undefined ? null : v;
}

const truthy = (v) => !(v === null || v === false || v === '' || v === 0 || v === undefined);
const same = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? '') === (b ?? '') || a === b);

/** Evaluates a GitHub Actions expression (with or without the ${{ }} wrapper) against a context object. */
export function evalExpr(expr, ctx) {
  let src = expr.trim();
  const w = src.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (w) src = w[1];
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { if (peek() && peek().t === 'op' && peek().v === v) { p++; return true; } return false; };
  function primary() {
    const k = toks[p++];
    if (!k) throw new Error('unexpected end of expression');
    if (k.t === 'str') return k.v;
    if (k.t === 'op' && k.v === '!') return !truthy(primary());
    if (k.t === 'op' && k.v === '(') { const v = or(); if (!eat(')')) throw new Error('missing )'); return v; }
    if (k.t === 'id') {
      if (eat('(')) {
        const args = [];
        if (!eat(')')) { do { args.push(or()); } while (eat(',')); if (!eat(')')) throw new Error('missing ) after arguments'); }
        const fn = k.v;
        if (fn === 'contains') {
          const [a, b] = args;
          return Array.isArray(a) ? a.some((x) => same(x, b)) : String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
        }
        if (fn === 'startsWith') return String(args[0] ?? '').toLowerCase().startsWith(String(args[1] ?? '').toLowerCase());
        if (fn === 'cancelled' || fn === 'always') return fn === 'always';
        throw new Error(`function not supported: ${fn}`);
      }
      return lookup(ctx, k.v);
    }
    throw new Error(`unexpected token ${k.v}`);
  }
  function eq() {
    let v = primary();
    while (peek() && peek().t === 'op' && (peek().v === '==' || peek().v === '!=')) {
      const op = toks[p++].v; const r = primary();
      v = op === '==' ? same(v, r) : !same(v, r);
    }
    return v;
  }
  function and() { let v = eq(); while (eat('&&')) { const r = eq(); v = truthy(v) ? r : v; } return v; }
  function or() { let v = and(); while (eat('||')) { const r = and(); v = truthy(v) ? v : r; } return v; }
  const result = or();
  if (p !== toks.length) throw new Error('unexpected trailing tokens');
  return result;
}

/** True when a job with this `if` (null = no `if`) runs for this context. */
export function jobRuns(ifExpr, ctx) {
  return ifExpr == null ? true : truthy(evalExpr(ifExpr, ctx));
}

/* ---------- the scenarios ---------- */

export const prCtx = (base, labels = [], draft = false) => ({
  event_name: 'pull_request', ref: 'refs/pull/1/merge', base_ref: base,
  event: { pull_request: { draft, labels: labels.map((name) => ({ name })) } },
});
export const mgCtx = (base) => ({
  event_name: 'merge_group', ref: `refs/heads/gh-readonly-queue/${base}/pr-1`, base_ref: '',
  event: { merge_group: { base_ref: `refs/heads/${base}` } },
});
export const pushCtx = (branch) => ({ event_name: 'push', ref: `refs/heads/${branch}`, base_ref: '', event: {} });

export const SCENARIOS = [
  { label: 'pull request into next, no label', ctx: prCtx('next'), heavy: false, light: true },
  { label: 'pull request into next, label full-ci', ctx: prCtx('next', ['full-ci']), heavy: true, light: true },
  { label: 'pull request into next, other label only', ctx: prCtx('next', ['docs']), heavy: false, light: true },
  { label: 'draft pull request into next, label full-ci', ctx: prCtx('next', ['full-ci'], true), heavy: false, light: false },
  { label: 'pull request into main, no label', ctx: prCtx('main'), heavy: true, light: true },
  { label: 'pull request into a release branch, no label', ctx: prCtx('release/1.0'), heavy: true, light: true },
  { label: 'merge queue on next', ctx: mgCtx('next'), heavy: true, light: true },
  { label: 'push to main', ctx: pushCtx('main'), heavy: true, light: true },
  { label: 'push to a release branch', ctx: pushCtx('release/1.0'), heavy: true, light: true },
  { label: 'schedule', ctx: { event_name: 'schedule', ref: 'refs/heads/main', event: {} }, heavy: true, light: true },
  { label: 'manual run', ctx: { event_name: 'workflow_dispatch', ref: 'refs/heads/main', event: {} }, heavy: true, light: true },
];

/** Returns a list of problem strings for the repository at `root`. */
export function check(root) {
  const problems = [];
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const jobsByFile = {};
  const jobFor = (file, name) => {
    jobsByFile[file] ??= jobsOf(read(`.github/workflows/${file}`));
    return jobsByFile[file].find((j) => j.name === name);
  };

  for (const { file, name } of [...HEAVY, ...LIGHT]) {
    const job = jobFor(file, name);
    if (!job) { problems.push(`${file}: no job is named exactly "${name}" (a required check needs a literal name)`); continue; }
    const heavy = HEAVY.some((h) => h.file === file && h.name === name);
    for (const s of SCENARIOS) {
      let runs;
      try { runs = jobRuns(job.if, { github: s.ctx }); } catch (e) { problems.push(`${file} "${name}": cannot evaluate the if (${e.message})`); break; }
      const want = heavy ? s.heavy : s.light;
      if (runs !== want) problems.push(`${file} "${name}": ${s.label}: ${runs ? 'runs' : 'is skipped'}, expected ${want ? 'run' : 'skipped'}`);
    }
  }

  // The required names are unchanged: the pull request list in CONTRIBUTING.md and the release list agree with REQUIRED.
  const contributing = read('CONTRIBUTING.md');
  for (const n of REQUIRED) if (!contributing.includes(`- ${n}\n`)) problems.push(`CONTRIBUTING.md: required check "${n}" is not listed`);
  const release = read('.github/release-required-checks.txt').split('\n').map((l) => l.trim());
  for (const n of REQUIRED) if (!release.includes(n)) problems.push(`release-required-checks.txt: "${n}" is missing`);

  // Every workflow that gates a job on the full-ci label starts again when the label is added or removed, and the
  // new run cancels the older run of the same pull request.
  const dir = path.join(root, '.github/workflows');
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    if (!text.includes("'full-ci'")) continue;
    const types = text.match(/^ {2}pull_request:\n(?:(?: {4}|\s*#).*\n)*? {4}types:\s*\[([^\]]*)\]/m);
    const list = types ? types[1].split(',').map((x) => x.trim()) : [];
    for (const t of ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
      if (!list.includes(t)) problems.push(`${f}: pull_request types lack "${t}" (a job depends on the full-ci label)`);
    }
    const group = text.match(/^concurrency:\n {2}group: (.*)\n {2}cancel-in-progress: (.*)\n/m);
    if (!group) problems.push(`${f}: no concurrency group`);
    else {
      if (!/github\.event\.pull_request\.number/.test(group[1])) problems.push(`${f}: the concurrency group does not include the pull request number`);
      if (!/github\.event_name == 'pull_request'/.test(group[2])) problems.push(`${f}: cancel-in-progress is off for pull requests`);
    }
  }
  return problems;
}

function main(argv) {
  const root = path.resolve(argv[0] || '.');
  const problems = check(root);
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error('\nThe heavy required checks must be skipped on a pull request into next without the full-ci label, and run in the merge queue.');
    return 1;
  }
  console.log(`heavy jobs gating OK: ${HEAVY.length} heavy and ${LIGHT.length} light jobs checked in ${SCENARIOS.length} scenarios; ${REQUIRED.length} required names unchanged`);
  return 0;
}

let isMain = false;
try { isMain = fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { /* not run as a script */ }
if (isMain) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-heavy-jobs-gating: ' + e.message); process.exitCode = 1; }
}
