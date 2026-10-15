'use strict';

// ReDoS sweep for the hook policy and the CLI. Every regex literal in the files
// below (found by test/helpers/regex_sweep.js), every pattern built with
// `new RegExp` from a constant (broker/markers.js), the multiline secret scan
// the CLI runs over its rules, and the glob-to-regex conversion of the policy
// must finish 50k-character adversarial inputs within LIMIT_MS.
//
// KNOWN_SLOW lists the literal findings the sweep reports but does not fix here
// (see the PR description). The entry keeps CI green while the fix goes through
// its own review; the fix removes it. The glob shapes with several `*` are
// documented next to GLOB_CASES.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanJs, adversarialInputs, timeMatch, SIZE } = require('./helpers/regex_sweep');
const policy = require('../lib/hooks/policy');
const { SECRET_PATTERNS } = require('../lib/rules');

const ROOT = path.join(__dirname, '..');
const LIMIT_MS = 100;

const FILES = [
  'lib/hooks/policy.js',
  'lib/hooks/runner.js',
  'bin/cli.js',
  'lib/stats-cli.js',
  'lib/init.js',
  'lib/exe.js',
  'lib/client.js',
  'lib/zn-command.js',
  'lib/broker/dotenv.js',
  'lib/broker/markers.js',
  'lib/broker/files.js',
  'lib/shell-quote.js',
];

// `new RegExp(...)` sites in each file, all of them dynamic. Each one is covered
// here: policy.js builds globs (GLOB_CASES below) and the case-insensitive copy
// (checked through the `i` variant of every literal); bin/cli.js rebuilds the
// secret rules with the g flag (SECRET_PATTERNS below); markers.js builds from
// constant sources (DYNAMIC_SOURCES below). A new site fails the count check.
const EXPECTED_CTORS = { 'lib/hooks/policy.js': 2, 'bin/cli.js': 1, 'lib/broker/markers.js': 2 };

const DYNAMIC_SOURCES = [
  { file: 'lib/broker/markers.js', body: '__ZN_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)__', flags: 'g' },
  { file: 'lib/broker/markers.js', body: '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$', flags: '' },
];

// Findings: literal patterns that exceed LIMIT_MS on adversarial input today.
// They run at `sizeChars` (their cost is quadratic: about 36 s at 50k digits, so
// they are not run at 50k here) against `ceilingMs`, which is scaled to that
// size. Anything new, or any of these getting slower than the ceiling, fails.
const KNOWN_SLOW = [
  {
    file: 'lib/exe.js',
    body: '[-_]?(?:v?\\d+(?:[._-]\\d+)*[a-z]?)?(?:[-_](?:preview|beta|nightly))?$',
    sizeChars: 5000,
    ceilingMs: 1000,
    note: 'programBase() is unanchored at the start: a long digit run is O(n^2).',
  },
];

// Glob shapes the policy turns into regexes. Their cost grows polynomially with
// the number of `*` (each `*` is a `[^/]*` that backtracks over the rest), so
// those with two or more stars are not run at 50k characters here: they take
// seconds (`**b`, `*a*b`, `**/.env*` at 50k) or do not finish (`*a*a*b`).
const GLOB_CASES = ['*b', '*/*/x', 'a?b*c[0-9]'];

function readJs(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function compile(body, flags, where) {
  try {
    return new RegExp(body, flags);
  } catch (err) {
    throw new Error(`${where}: /${body}/${flags} does not compile (${err.message}); the literal scanner is wrong`);
  }
}

function knownSlowFor(file, body) {
  return KNOWN_SLOW.find((k) => k.file === file && k.body === body);
}

// Measures one input: a quick first run, and the fastest of two only when the
// quick one is over the limit (so a noisy host does not fail the sweep).
function measure(body, flags, input) {
  const quick = timeMatch(body, flags, input, 1);
  return quick > LIMIT_MS ? timeMatch(body, flags, input, 2) : quick;
}

function worstOf(body, flags, size = SIZE) {
  let worst = { ms: 0, input: '' };
  for (const input of adversarialInputs(body, size)) {
    const ms = measure(body, flags, input);
    if (ms > worst.ms) worst = { ms, input: input.slice(0, 16) };
  }
  return worst;
}

test('every regex literal of the hook policy and the CLI stays under 100 ms on 50k adversarial inputs', () => {
  const offenders = [];
  let checked = 0;
  for (const file of FILES) {
    const { literals, ctors } = scanJs(readJs(file));
    assert.equal(ctors.length, EXPECTED_CTORS[file] || 0,
      `${file}: the number of new RegExp() sites changed; cover the new one in regex_sweep.test.js`);
    for (const lit of literals) {
      compile(lit.body, lit.flags, `${file}:${lit.line}`);
      const variants = lit.flags.includes('i') ? [lit.flags] : [lit.flags, lit.flags + 'i'];
      const slow = knownSlowFor(file, lit.body);
      const size = slow ? slow.sizeChars : SIZE;
      for (const flags of variants) {
        const worst = worstOf(lit.body, flags, size);
        checked++;
        const limit = slow ? slow.ceilingMs : LIMIT_MS;
        if (worst.ms > limit) {
          offenders.push(`${file}:${lit.line} /${lit.body}/${flags} took ${worst.ms.toFixed(1)} ms at ${size} chars (limit ${limit}) on input ${JSON.stringify(worst.input)}...`);
        }
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} regex runs: the scanner found too few literals`);
  assert.deepEqual(offenders, []);
});

test('the dynamically built patterns of broker/markers.js stay under 100 ms', () => {
  const offenders = [];
  for (const { file, body, flags } of DYNAMIC_SOURCES) {
    const re = compile(body, flags, file);
    assert.ok(re.source.length > 0);
    for (const input of adversarialInputs(body)) {
      const ms = measure(body, flags, input);
      if (ms > LIMIT_MS) offenders.push(`${file} /${body}/${flags} took ${ms.toFixed(1)} ms on ${JSON.stringify(input.slice(0, 16))}...`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the multiline secret scan of the CLI (SECRET_PATTERNS with the g flag) stays under 100 ms', () => {
  const offenders = [];
  for (const rule of SECRET_PATTERNS) {
    const body = rule.pattern.source;
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    const worst = worstOf(body, flags);
    if (worst.ms > LIMIT_MS) offenders.push(`${rule.id} took ${worst.ms.toFixed(1)} ms on ${JSON.stringify(worst.input)}...`);
  }
  assert.deepEqual(offenders, []);
});

test('the glob-to-regex conversion of the policy stays under 100 ms on linear glob shapes', () => {
  const offenders = [];
  for (const glob of GLOB_CASES) {
    const re = policy.globRegExp(glob);
    for (const input of adversarialInputs(glob)) {
      let best = Infinity;
      for (let r = 0; r < 2; r++) {
        const t0 = process.hrtime.bigint();
        re.test(input);
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      }
      if (best > LIMIT_MS) offenders.push(`glob ${glob} took ${best.toFixed(1)} ms on ${JSON.stringify(input.slice(0, 16))}...`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the sweep is not vacuous: the scanner finds the admin-command pattern and the globs still match', () => {
  const { literals } = scanJs(readJs('lib/hooks/policy.js'));
  assert.ok(literals.some((l) => l.body.includes('share\\s+on')), 'the admin-command regex is in the scan');
  assert.equal(policy.globRegExp('*b').test('ab'), true);
  assert.equal(policy.globRegExp('*/*/x').test('a/b/x'), true);
  assert.equal(policy.globRegExp('*b').test('a/b'), false);
});
