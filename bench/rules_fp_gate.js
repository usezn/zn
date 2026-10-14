#!/usr/bin/env node
'use strict';

/**
 * False-positive gate for the local rules engine (packages/zn-gate/lib/rules.js).
 *
 * Runs evaluate() over two sets of benign text:
 *   (a) the pinned benign corpus: real npm and Python code, downloaded by
 *       packages/zn-gate/test/fixtures/benign/fetch_corpus.sh;
 *   (b) ordinary developer sentences: packages/zn-gate/test/fixtures/benign_phrases.json.
 *
 * It fails when the engine blocks more of this text than the committed
 * baseline (bench/rules_fp_baseline.json): a higher total, a higher count for
 * any rule, or a different number of scanned texts. When the counts are lower,
 * it passes and (in CI) prints a warning that the baseline is stale: lock the
 * improvement in with --update-baseline.
 *
 * The rules read .znrules and zn.config.json from the working directory, so
 * the gate evaluates from a fresh empty directory: a local config file cannot
 * change the counts.
 *
 * Usage:
 *   node bench/rules_fp_gate.js                     check against the baseline
 *   node bench/rules_fp_gate.js --update-baseline   rewrite the baseline
 *   node bench/rules_fp_gate.js --json report.json  also write the report
 *
 * Without the corpus (local runs) the gate checks the phrases only and exits 0.
 * With CI=true a missing corpus is an error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'packages', 'zn-gate', 'test', 'fixtures');
const CORPUS_DIR = path.join(FIXTURES, 'benign');
const CORPUS_SUBDIRS = ['python-stdlib', 'npm', 'licenses'];
const PHRASES_FILE = path.join(FIXTURES, 'benign_phrases.json');
const BASELINE_FILE = path.join(__dirname, 'rules_fp_baseline.json');
const IN_CI = process.env.CI === 'true';

const { evaluate, RULES_VERSION } = require(path.join(ROOT, 'packages', 'zn-gate', 'lib', 'rules.js'));

function fail(message) {
  console.error('rules false-positive gate: ' + message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { update: false, json: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--update-baseline') args.update = true;
    // Resolved here, before the gate changes into an empty temp directory.
    else if (argv[i] === '--json' && argv[i + 1]) args.json = path.resolve(argv[++i]);
    else fail('unknown argument: ' + argv[i]);
  }
  return args;
}

// Evaluate from a fresh empty directory so .znrules / zn.config.json in the
// caller's working directory cannot change the counts.
function enterEmptyWorkingDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-fp-gate-'));
  process.chdir(dir);
  process.on('exit', () => {
    process.chdir(ROOT);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function corpusPresent() {
  return CORPUS_SUBDIRS.every((d) => fs.existsSync(path.join(CORPUS_DIR, d)));
}

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function corpusFiles() {
  const files = [];
  for (const d of CORPUS_SUBDIRS) walk(path.join(CORPUS_DIR, d), files);
  return files;
}

function emptyTally() {
  return { files: 0, blocked: 0, by_rule: {}, advisories: 0, advisory_by_rule: {} };
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function tally(t, text) {
  const res = evaluate(text);
  t.files += 1;
  if (res.verdict === 'block') {
    t.blocked += 1;
    bump(t.by_rule, res.rule || 'unknown');
  }
  // An advisory is { rule, reason } on an allowed result: count it by its rule.
  if (res.advisory) {
    t.advisories += 1;
    bump(t.advisory_by_rule, (typeof res.advisory === 'object' && res.advisory.rule) || 'unknown');
  }
}

function merge(a, b) {
  const out = emptyTally();
  for (const t of [a, b]) {
    out.files += t.files;
    out.blocked += t.blocked;
    out.advisories += t.advisories;
    for (const [k, v] of Object.entries(t.by_rule)) out.by_rule[k] = (out.by_rule[k] || 0) + v;
    for (const [k, v] of Object.entries(t.advisory_by_rule)) out.advisory_by_rule[k] = (out.advisory_by_rule[k] || 0) + v;
  }
  return out;
}

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function baselineOf(total) {
  return { files: total.files, blocked: total.blocked, by_rule: sortedObject(total.by_rule) };
}

function withRate(t) {
  const rate = t.files ? ((t.blocked / t.files) * 100).toFixed(2) + '%' : 'n/a';
  return Object.assign({}, t, { block_rate: rate });
}

function describe(name, t) {
  const rules = Object.keys(t.by_rule).sort().map((r) => `${r}=${t.by_rule[r]}`).join(', ') || 'none';
  const adv = Object.keys(t.advisory_by_rule).sort().map((r) => `${r}=${t.advisory_by_rule[r]}`).join(', ') || 'none';
  return [
    `${name}: files ${t.files}, blocked ${t.blocked} (${t.block_rate}), by rule: ${rules}`,
    `${name}: advisories ${t.advisories}, by rule: ${adv}`,
  ];
}

// Reject a hand-edited or truncated baseline before comparing against it.
function validateBaseline(b) {
  const bad = (why) => fail(`baseline file is malformed (${path.relative(ROOT, BASELINE_FILE)}): ${why}`);
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  if (!b || typeof b !== 'object' || Array.isArray(b)) bad('expected a JSON object');
  if (!isCount(b.files)) bad('"files" must be a non-negative integer');
  if (!isCount(b.blocked)) bad('"blocked" must be a non-negative integer');
  if (!b.by_rule || typeof b.by_rule !== 'object' || Array.isArray(b.by_rule)) bad('"by_rule" must be an object');
  for (const [rule, n] of Object.entries(b.by_rule)) {
    if (!isCount(n)) bad(`"by_rule.${rule}" must be a non-negative integer`);
  }
}

function readBaseline() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch (err) {
    fail(`baseline file is not valid JSON (${path.relative(ROOT, BASELINE_FILE)}): ${err.message}`);
  }
  validateBaseline(parsed);
  return parsed;
}

function compare(base, cur) {
  const problems = [];
  if (cur.files !== base.files) {
    problems.push(`scanned ${cur.files} texts but the baseline has ${base.files}: the corpus or the phrase list changed; run with --update-baseline`);
  }
  if (cur.blocked > base.blocked) {
    problems.push(`blocked ${cur.blocked} benign texts, the baseline allows ${base.blocked}`);
  }
  for (const [rule, n] of Object.entries(cur.by_rule)) {
    const allowed = base.by_rule[rule] || 0;
    if (n > allowed) problems.push(`rule ${rule} blocks ${n} benign texts, the baseline allows ${allowed}`);
  }
  return problems;
}

function isLower(base, cur) {
  if (cur.blocked < base.blocked) return true;
  return Object.keys(base.by_rule).some((r) => (cur.by_rule[r] || 0) < base.by_rule[r]);
}

function main() {
  const args = parseArgs(process.argv);
  const phrases = JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf8')).phrases;
  if (!Array.isArray(phrases) || phrases.length === 0) fail('no phrases in ' + PHRASES_FILE);

  const hasCorpus = corpusPresent();
  if (!hasCorpus) {
    if (IN_CI) fail('benign corpus is missing in CI; run packages/zn-gate/test/fixtures/benign/fetch_corpus.sh first');
    if (args.update) fail('refusing to write the baseline without the benign corpus; run fetch_corpus.sh first');
    enterEmptyWorkingDir();
    const phraseTally = emptyTally();
    for (const p of phrases) tally(phraseTally, p);
    console.log(`rules false-positive gate (rules ${RULES_VERSION})`);
    console.log('benign corpus not downloaded: the corpus check is skipped locally.');
    console.log('To run it: bash packages/zn-gate/test/fixtures/benign/fetch_corpus.sh');
    for (const line of describe('phrases', withRate(phraseTally))) console.log(line);
    process.exit(0);
  }

  enterEmptyWorkingDir();
  const corpus = emptyTally();
  for (const f of corpusFiles()) tally(corpus, fs.readFileSync(f, 'utf8'));
  const phraseTally = emptyTally();
  for (const p of phrases) tally(phraseTally, p);
  const total = merge(corpus, phraseTally);

  const report = {
    rules_version: RULES_VERSION,
    corpus: withRate(corpus),
    phrases: withRate(phraseTally),
    total: withRate(total),
  };
  console.log(`rules false-positive gate (rules ${RULES_VERSION})`);
  for (const [name, t] of [['corpus', report.corpus], ['phrases', report.phrases], ['total', report.total]]) {
    for (const line of describe(name, t)) console.log(line);
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2) + '\n');

  const candidate = baselineOf(total);
  const candidateText = JSON.stringify(candidate, null, 2);
  if (args.update) {
    fs.writeFileSync(BASELINE_FILE, candidateText + '\n');
    console.log(`wrote ${path.relative(ROOT, BASELINE_FILE)}`);
    console.log(candidateText);
    process.exit(0);
  }

  if (!fs.existsSync(BASELINE_FILE)) {
    console.log('RULES_FP_BASELINE_BEGIN');
    console.log(candidateText);
    console.log('RULES_FP_BASELINE_END');
    fail(`no baseline at ${path.relative(ROOT, BASELINE_FILE)}; copy the JSON printed above into that file (or run with --update-baseline locally)`);
  }

  const base = readBaseline();
  const problems = compare(base, total);
  if (problems.length) {
    console.error('rules false-positive gate: FAILED');
    for (const p of problems) console.error('  - ' + p);
    console.error('The local rules block more benign text than the baseline allows. Fix the rule, or explain the change in the pull request and run --update-baseline.');
    process.exit(1);
  }

  if (isLower(base, total)) {
    const msg = 'the rules block fewer benign texts than the baseline records; the baseline is stale. Update bench/rules_fp_baseline.json with --update-baseline to lock in the improvement.';
    if (IN_CI) console.log('::warning::rules false-positive baseline is stale: ' + msg);
    else console.log('note: ' + msg);
    // The new baseline, ready to copy from the log into bench/rules_fp_baseline.json.
    console.log('RULES_FP_BASELINE_BEGIN');
    console.log(candidateText);
    console.log('RULES_FP_BASELINE_END');
  }
  console.log('rules false-positive gate: PASS');
}

main();
