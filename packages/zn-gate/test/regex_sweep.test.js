'use strict';

// Timing sweep for the package. Every regex literal in every JS file under lib/
// and bin/ (found by test/helpers/regex_sweep.js), every pattern built with
// `new RegExp` from a constant (broker/markers.js), the multiline secret scan
// the CLI runs over its rules, and the glob-to-regex conversion and the glob
// shapes of the policy must finish 50k-character adversarial inputs within
// LIMIT_MS.
//
// KNOWN_SLOW lists the literals that still exceed LIMIT_MS on their input size,
// each with the measurement that keeps it there (see the PR description).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanJs, adversarialInputs, timeMatch, SIZE, GuardedTimer } = require('./helpers/regex_sweep');
const policy = require('../lib/hooks/policy');
const exe = require('../lib/exe');
const { SECRET_PATTERNS } = require('../lib/rules');

const ROOT = path.join(__dirname, '..');
const LIMIT_MS = 100;
// Files whose regexes can also run case-insensitively: policy.js adds the i flag
// on case-insensitive file systems (ci()). Elsewhere a literal runs with its own flags.
const CI_FILES = new Set(['lib/hooks/policy.js']);
// Hard cap per literal and flag variant (all its inputs) in the main sweep.
const CAP_MS = 10000;

const CORE_FILES = [
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
  // Files changed by the MCP pinning, scan and Team warn changes.
  'lib/mcp-pins.js',
  'lib/shield.js',
  'lib/broker/mcp.js',
  'lib/broker/run.js',
  'lib/agents/claude-code.js',
  'lib/team/api.js',
  'lib/team/daemon-ops.js',
  'lib/team/effective.js',
  'lib/team/otel.js',
  'lib/team/policy.js',
  'lib/vault/audit.js',
  'lib/vault/client.js',
  'lib/vault/daemon.js',
  'lib/vault/cli.js',
  'lib/scrub/engine.js',
];

// Every JS file under lib/ and bin/, so a new file is timed without being listed.
function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const FILES = [...listJs('lib'), ...listJs('bin')].sort();

// `new RegExp(...)` sites in each file. Sites built from a constant source are
// timed where the source is listed (policy.js: GLOB_CASES; bin/cli.js: the
// SECRET_PATTERNS rebuilt with g; markers.js: DYNAMIC_SOURCES). The other sites
// are counted: a new one fails the count check until it is reviewed and, if it
// builds a pattern from input-dependent text, added to the sweep.
const EXPECTED_CTORS = {
  'bin/cli.js': 1,
  // Built from constants or from the agent id of the install command.
  'lib/agents/config-file.js': 1,
  // Hook command shapes, path globs from the audited config and a fixed trigger list.
  'lib/audit/index.js': 7,
  'lib/audit/patterns.js': 1,
  'lib/broker/markers.js': 2,
  // Alternation of escaped literal secret values (escapeRe), no quantifiers from input.
  'lib/broker/mask.js': 1,
  'lib/broker/run.js': 1,
  'lib/hooks/policy.js': 2,
  // Copies of constant sources with other flags, plus bannedPatterns from the
  // user's own local config file (same trust as the user).
  'lib/rules.js': 20,
  'lib/scrub/engine.js': 7,
  'lib/scrub/patterns.js': 5,
  'lib/team/daemon-ops.js': 1,
  // Org detector patterns: checkPattern() limits them to a bounded subset with a
  // cost cap, and find() runs them per window under a time budget.
  'lib/team/detectors.js': 2,
  'lib/team/effective.js': 1,
  'lib/vault/confirm.js': 2,
};

const DYNAMIC_SOURCES = [
  { file: 'lib/broker/markers.js', body: '__ZN_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)__', flags: 'g' },
  { file: 'lib/broker/markers.js', body: '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$', flags: '' },
];

// Literals that exceed LIMIT_MS on their input size today. Each runs at
// `sizeChars` against `ceilingMs`, which is set above the measured time so that
// host load does not fail CI. Anything new, or one of these getting slower than
// its ceiling, fails. Measured on the merged code (timing sweep, 2 runs, worst
// adversarial input):
const KNOWN_SLOW = [
  {
    // Measured: 23.6 s at 50k characters, 0.5 ms at 255. programBase() returns
    // early for names longer than 255 characters, so the literal only ever runs
    // on up to 255 characters; the function itself is timed at 50k below.
    file: 'lib/exe.js',
    body: '[-_]?(?:v?\\d+(?:[._-]\\d+)*[a-z]?)?(?:[-_](?:preview|beta|nightly))?$',
    sizeChars: 255,
    ceilingMs: 100,
    note: 'the literal is slow above 255 characters; programBase() guards that length.',
  },
];

// Glob shapes the policy turns into regexes, run at full size. Shapes with
// several `*`, runs of bracket openers and long brace lists are included.
const GLOB_CASES = ['*b', '*/*/x', 'a?b*c[0-9]', '**b', '**/x', '*a*b', '*a*a*b', '**/.env*',
  '[:'.repeat(SIZE / 2), '[[:'.repeat(SIZE / 3), '{' + ','.repeat(SIZE - 2) + '}'];

// Shapes timed end to end through classifyWord and bashDenial (a cat command
// with the shape as its argument). classifyWord stays under LIMIT_MS. bashDenial
// is under 100 ms on an idle host (4 to 50 ms measured) but reached 40 to 225 ms
// on a loaded one, so it uses BASH_LIMIT_MS, the same 2000 ms ceiling as
// test/policy_glob_linear.test.js.
const BASH_LIMIT_MS = 2000;
const GLOB_SHAPE_LINES = [
  '**b', '**/x', '*a*b', '*a*a*b', '**/.env*', '[:'.repeat(SIZE / 2), '[[:'.repeat(SIZE / 3),
  '{' + ','.repeat(SIZE - 2) + '}', '{' + 'a,'.repeat(SIZE / 2 - 1) + 'b}',
];

function bestOf(fn) {
  let best = Infinity;
  for (let r = 0; r < 2; r++) {
    const t0 = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

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

test('the guarded timer reports a pattern that hangs instead of waiting for it', () => {
  const timer = new GuardedTimer(1500);
  try {
    assert.equal(timer.worst('^(a+)+$', '', SIZE, LIMIT_MS).timedOut, true);
    const fine = timer.worst('^abc', '', SIZE, LIMIT_MS);
    assert.equal(fine.timedOut, undefined);
    assert.ok(fine.ms < LIMIT_MS);
  } finally {
    timer.close();
  }
});

test('the sweep covers every JS file of lib/ and bin/', () => {
  for (const f of CORE_FILES) assert.ok(FILES.includes(f), `${f} is not discovered`);
  for (const f of Object.keys(EXPECTED_CTORS)) assert.ok(FILES.includes(f), `${f} in EXPECTED_CTORS does not exist`);
  assert.ok(FILES.length > CORE_FILES.length);
});

test('every regex literal under lib/ and bin/ stays under 100 ms on 50k adversarial inputs', () => {
  const offenders = [];
  let checked = 0;
  const timer = new GuardedTimer(CAP_MS);
  try {
    for (const file of FILES) {
      const { literals, ctors } = scanJs(readJs(file));
      assert.equal(ctors.length, EXPECTED_CTORS[file] || 0,
        `${file}: the number of new RegExp() sites changed; cover the new one in regex_sweep.test.js`);
      for (const lit of literals) {
        compile(lit.body, lit.flags, `${file}:${lit.line}`);
        const variants = lit.flags.includes('i') || !CI_FILES.has(file) ? [lit.flags] : [lit.flags, lit.flags + 'i'];
        const slow = knownSlowFor(file, lit.body);
        const size = slow ? slow.sizeChars : SIZE;
        for (const flags of variants) {
          const limit = slow ? slow.ceilingMs : LIMIT_MS;
          const worst = timer.worst(lit.body, flags, size, limit);
          checked++;
          if (worst.timedOut) {
            offenders.push(`${file}:${lit.line} /${lit.body}/${flags} did not finish within ${CAP_MS} ms at ${size} chars`);
          } else if (worst.ms > limit) {
            offenders.push(`${file}:${lit.line} /${lit.body}/${flags} took ${worst.ms.toFixed(1)} ms at ${size} chars (limit ${limit}) on input ${JSON.stringify(worst.input)}...`);
          }
        }
      }
    }
  } finally {
    timer.close();
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

test('the glob-to-regex conversion of the policy stays under 100 ms on the glob shapes', () => {
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

test('the glob shapes stay fast through classifyWord and bashDenial at 50k', () => {
  const opts = { cwd: '/home/u/project', home: '/home/u', env: {} };
  const offenders = [];
  for (const shape of GLOB_SHAPE_LINES) {
    const timings = {
      classifyWord: [bestOf(() => policy.classifyWord(shape, opts)), LIMIT_MS],
      bashDenial: [bestOf(() => policy.bashDenial('cat ' + shape, opts)), BASH_LIMIT_MS],
      bashDenialHome: [bestOf(() => policy.bashDenial('cat ~/' + shape, opts)), BASH_LIMIT_MS],
    };
    for (const [name, [ms, limit]] of Object.entries(timings)) {
      if (ms > limit) offenders.push(`${name} on ${shape.slice(0, 12)}... (${shape.length} chars) took ${ms.toFixed(1)} ms (limit ${limit})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('programBase (through interpreterBase) stays under 100 ms on 50k inputs', () => {
  const body = KNOWN_SLOW.find((k) => k.file === 'lib/exe.js').body;
  const offenders = [];
  for (const input of adversarialInputs(body)) {
    const ms = bestOf(() => exe.interpreterBase(input));
    if (ms > LIMIT_MS) offenders.push(`interpreterBase took ${ms.toFixed(1)} ms on ${JSON.stringify(input.slice(0, 16))}...`);
  }
  for (const word of ['python' + '1'.repeat(SIZE) + ' x.py', 'node' + '-1'.repeat(SIZE / 2) + ' x.js', '1'.repeat(SIZE)]) {
    const ms = bestOf(() => exe.interpreterBase(word));
    if (ms > LIMIT_MS) offenders.push(`interpreterBase took ${ms.toFixed(1)} ms on a ${word.length}-character word`);
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
