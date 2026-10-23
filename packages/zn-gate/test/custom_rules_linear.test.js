'use strict';

// Project rules (.znrules, zn.config.json): patterns run in linear time, patterns
// that could take exponential time are rejected, and a rules file with an error
// blocks instead of being half applied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../lib/rules');
const { compileCustomPattern, MAX_PATTERN_LENGTH, MAX_PATTERNS } = require('../lib/linear-regex');

// Pieces are joined at run time so the test file holds no ready-made adversarial expression.
const NESTED = ['(a+)', '+$'].join('');
const NESTED_STAR = ['(x*', ')*y'].join('');

function inProject(files, fn) {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-rules-'));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    process.chdir(dir);
    rules.loadCustomConfig(true);
    return fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    rules.loadCustomConfig(true);
  }
}

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('a normal custom pattern still matches, ignoring case', () => {
  const r = compileCustomPattern('CONFIDENTIAL_PROJECT_[A-Z0-9]+');
  assert.equal(r.ok, true);
  assert.equal(r.rule.test('see confidential_project_x7 here'), true);
  assert.equal(r.rule.test('nothing here'), false);
  assert.equal(r.rule.source, 'CONFIDENTIAL_PROJECT_[A-Z0-9]+');
});

test('the accepted syntax behaves like the JavaScript engine', () => {
  const cases = [
    ['^foo$', ['foo', 'FOO', 'xfoo', 'foo\n']],
    ['a.c', ['abc', 'a\nc', 'ac']],
    ['colou?r', ['color', 'colour', 'colr']],
    ['\\bcat\\b', ['a cat sat', 'concat', 'cat', 'cats']],
    ['\\Bcat', ['concat', 'cat']],
    ['(?:ab|cd)+e', ['abcde', 'e', 'abe', 'ce']],
    ['x{2,3}y', ['xy', 'xxy', 'xxxy', 'xxxxy']],
    ['x{2}', ['x', 'xx']],
    ['x{2,}z', ['xz', 'xxz', 'xxxxz']],
    ['[^a-c]+d', ['abcd', 'xd', 'd']],
    ['\\d{3}-\\d{4}', ['555-1234', '55-1234']],
    ['\\.env$', ['config.env', 'config.envx']],
    ['a|b|', ['zzz', '']],
    ['[\\w.-]+@example\\.com', ['bob.k@example.com', '@example.com', 'bob@exampleXcom']],
    ['\\x41\\u0042', ['ab', 'AB', 'xb']],
    ['\\s+end', ['a   end', 'end']],
  ];
  for (const [src, inputs] of cases) {
    const re = new RegExp(src, 'i');
    const mine = compileCustomPattern(src);
    assert.equal(mine.ok, true, src);
    for (const input of inputs) assert.equal(mine.rule.test(input), re.test(input), `${src} on ${JSON.stringify(input)}`);
  }
});

test('patterns that can take exponential time are rejected with a reason', () => {
  for (const src of [NESTED, NESTED_STAR, '(a|b+){2,5}', '(\\w+\\s?)+$']) {
    const r = compileCustomPattern(src);
    assert.equal(r.ok, false, src);
    assert.match(r.error, /quantifier|exponential/, src);
  }
});

test('backreferences, lookaround, named groups and unicode classes are rejected', () => {
  for (const [src, word] of [['(a)\\1', 'backreference'], ['a(?=b)', 'lookahead'], ['a(?!b)', 'lookahead'], ['(?<=a)b', 'lookbehind'],
    ['(?<n>a)', 'named'], ['\\p{L}+', 'not supported'], ['(a', 'not closed'], ['a)', 'unmatched'], ['*a', 'nothing to repeat'],
    ['[a', 'not closed'], ['a{5,2}', 'out of order'], ['a{1000}', 'above'], ['a**', 'two quantifiers']]) {
    const r = compileCustomPattern(src);
    assert.equal(r.ok, false, src);
    assert.match(r.error, new RegExp(word), src);
  }
});

test('too long and too large patterns are rejected', () => {
  assert.equal(compileCustomPattern('a'.repeat(MAX_PATTERN_LENGTH)).ok, true); // plain text
  assert.match(compileCustomPattern('a?'.repeat(MAX_PATTERN_LENGTH / 2)).error, /too large/);
  assert.match(compileCustomPattern('a'.repeat(MAX_PATTERN_LENGTH + 1)).error, /longer than/);
  assert.match(compileCustomPattern('').error, /empty/);
  // Small source, huge after expanding the repeat counts.
  const big = '((((a{100}){100}){100}){100})';
  assert.equal(compileCustomPattern(big).ok, false);
  assert.equal(compileCustomPattern('(a{100}){100}').ok, false);
});

test('matching a long input stays fast, also for patterns that are slow in a backtracking engine', () => {
  const N = 200000;
  const inputs = ['a'.repeat(N) + '!', 'x'.repeat(N), ('ab'.repeat(N / 2)) + 'c'];
  // Accepted patterns that a backtracking engine runs in quadratic or worse time on these inputs.
  for (const src of ['a*a*a*a*b', '[a-z]+X', '.*a.*b.*c.*d', '(a|aa)b', 'a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?b']) {
    const r = compileCustomPattern(src);
    assert.equal(r.ok, true, src);
    for (const input of inputs) {
      const { ms } = timed(() => r.rule.test(input));
      assert.ok(ms < 3000, `${src} took ${ms} ms`);
    }
  }
});

test('too many patterns in a file is an error', () => {
  const many = Array.from({ length: MAX_PATTERNS + 1 }, (_, k) => `RULE_${k}`).join('\n');
  inProject({ '.znrules': many }, () => {
    const cfg = rules.loadCustomConfig();
    assert.equal(cfg.errors.length, 1);
    assert.match(cfg.errors[0], /more than/);
    assert.equal(rules.evaluate('anything harmless').rule, 'custom:invalid_rules');
  });
  const exact = Array.from({ length: MAX_PATTERNS }, (_, k) => `RULE_${k}`).join('\n');
  inProject({ '.znrules': exact }, () => {
    assert.equal(rules.loadCustomConfig().errors.length, 0);
    assert.equal(rules.evaluate('anything harmless').verdict, 'allow');
    assert.equal(rules.evaluate('contains rule_7 here').rule, 'custom:banned_pattern');
  });
});

test('a rejected pattern in .znrules blocks with the line and the reason, and a fixed file works again', () => {
  inProject({ '.znrules': '# rules\nFOO_[0-9]+\n' + NESTED + '\npath:/prod\n' }, () => {
    const res = rules.evaluate('hello there');
    assert.equal(res.verdict, 'block');
    assert.equal(res.rule, 'custom:invalid_rules');
    assert.match(res.reason, /\.znrules/);
    assert.match(res.reason, /line 3/);
    assert.match(res.reason, /exponential/);
  });
  inProject({ '.znrules': '# rules\nFOO_[0-9]+\npath:/prod\n' }, () => {
    assert.equal(rules.evaluate('hello there').verdict, 'allow');
    assert.equal(rules.evaluate('uses foo_12 now').rule, 'custom:banned_pattern');
    assert.equal(rules.evaluate('reads /prod/db').rule, 'custom:forbidden_path');
  });
});

test('zn.config.json: a bad pattern, invalid JSON or a wrong shape never gives a partial policy', () => {
  const bad = {
    'one bad pattern': JSON.stringify({ bannedPatterns: ['GOOD_[0-9]+', NESTED], forbiddenPaths: ['/prod'] }),
    'invalid JSON': '{ "bannedPatterns": [',
    'not an object': '[]',
    'patterns not a list': JSON.stringify({ bannedPatterns: 'GOOD' }),
    'pattern not a string': JSON.stringify({ bannedPatterns: [42] }),
    'paths not strings': JSON.stringify({ forbiddenPaths: [1] }),
  };
  for (const [name, text] of Object.entries(bad)) {
    inProject({ 'zn.config.json': text }, () => {
      const cfg = rules.loadCustomConfig();
      assert.ok(cfg.errors.length > 0, name);
      assert.equal(rules.evaluate('hello there').rule, 'custom:invalid_rules', name);
    });
  }
  inProject({ 'zn.config.json': JSON.stringify({ bannedPatterns: ['GOOD_[0-9]+'], forbiddenPaths: ['/prod'], strict: true }) }, () => {
    const cfg = rules.loadCustomConfig();
    assert.equal(cfg.errors.length, 0);
    assert.equal(cfg.strict, true);
    assert.equal(rules.evaluate('hello there').verdict, 'allow');
    assert.equal(rules.evaluate('good_5').rule, 'custom:banned_pattern');
  });
});

test('the output prefilter does not skip the rules while the project rules have errors', () => {
  const { mayMatchRules } = require('../lib/hooks/output_prefilter');
  assert.equal(mayMatchRules('plain text', { bannedPatterns: [], forbiddenPaths: [], errors: ['x'] }), true);
  assert.equal(mayMatchRules('plain text', { bannedPatterns: [], forbiddenPaths: [], errors: [] }), false);
});

// ---- review fixes: cost bound, one configuration finding, syntax edges ---------------------

test('the worst accepted file (the whole budget in patterns that keep every state alive) scans 256K characters in about two seconds at most', () => {
  const { MAX_TOTAL_PROGRAM, MAX_PROGRAM } = require('../lib/linear-regex');
  assert.ok(MAX_TOTAL_PROGRAM <= 2000 && MAX_PROGRAM <= 500);
  // Chains of optional characters: all of their states stay alive on a text of 'a'.
  const lines = [];
  const budget = { left: MAX_TOTAL_PROGRAM };
  for (let k = 0; k < MAX_PATTERNS; k++) {
    const src = `[a-z]{0,99}Z${k}`;
    const r = compileCustomPattern(src, budget);
    if (!r.ok) break;
    lines.push(src);
  }
  // Fill what is left of the budget with one smaller chain of the same kind.
  const rest = Math.floor((budget.left - 3) / 2);
  if (rest > 0) {
    const src = `[a-z]{0,${rest}}Zr`;
    if (compileCustomPattern(src, budget).ok) lines.push(src);
  }
  assert.ok(lines.length >= 3 && budget.left < 4);
  const text = 'a'.repeat(256 * 1024);
  inProject({ '.znrules': lines.join('\n') }, () => {
    const cfg = rules.loadCustomConfig();
    assert.deepEqual(cfg.errors, []);
    assert.equal(cfg.bannedPatterns.length, lines.length);
    const { ms } = timed(() => { for (const p of cfg.bannedPatterns) assert.equal(p.test(text), false); });
    console.log(`# worst accepted file: ${lines.length} patterns, 256K characters, ${ms.toFixed(0)} ms`);
    assert.ok(ms < 6000, `the worst accepted file took ${ms} ms`);
  });
});

test('patterns that are too large together are an error with a visible reason, each one alone is fine', () => {
  const { MAX_TOTAL_PROGRAM } = require('../lib/linear-regex');
  const one = '[a-z]{0,99}Z'; // 200 steps
  const n = Math.floor(MAX_TOTAL_PROGRAM / 200) + 2;
  assert.equal(compileCustomPattern(one).ok, true);
  const text = Array.from({ length: n }, (_, k) => one + k).join('\n');
  inProject({ '.znrules': text }, () => {
    const cfg = rules.loadCustomConfig();
    assert.ok(cfg.errors.length >= 1);
    assert.match(cfg.errors[0], /too large together/);
    assert.match(cfg.errors[0], /line [345]:/);
    const res = rules.evaluate('hello there');
    assert.equal(res.rule, 'custom:invalid_rules');
    assert.match(res.reason, /too large together/);
  });
  assert.match(compileCustomPattern('a{100}'.repeat(6)).error, /too large/);
});

test('a repeat count with many digits and two counted quantifiers in a row are rejected, not read as literal text', () => {
  for (const [src, word] of [['a{1234567}', 'above'], ['a{2}{3}', 'two quantifiers'], ['a{2,3}{4}', 'two quantifiers'], ['a+{2}', 'two quantifiers'], ['{2}', 'nothing to repeat']]) {
    const r = compileCustomPattern(src);
    assert.equal(r.ok, false, src);
    assert.match(r.error, new RegExp(word), src);
  }
  // Not quantifiers in JavaScript either: still literal text.
  for (const src of ['a{', 'a{x}', 'a{,3}', 'a{1']) assert.equal(compileCustomPattern(src).ok, true, src);
});

test('the JSON error shows the position only, never the text of the file', () => {
  const secret = 'SECRETVALUE_9f3a';
  inProject({ 'zn.config.json': `{\n  "bannedPatterns": ["x"],\n  "note": "${secret}" oops\n}` }, () => {
    const cfg = rules.loadCustomConfig();
    assert.equal(cfg.errors.length, 1);
    assert.ok(!cfg.errors[0].includes(secret), cfg.errors[0]);
    assert.match(cfg.errors[0], /not valid JSON/);
    const res = rules.evaluate('hello there');
    assert.ok(!res.reason.includes(secret));
    if (/line/.test(cfg.errors[0])) assert.match(cfg.errors[0], /line 3, column \d+/);
  });
});

test('an invalid rules file tells the user what to do, and the doctor command lists the errors', () => {
  inProject({ '.znrules': 'FOO_[0-9]+\n' + NESTED + '\n' }, () => {
    const res = rules.evaluate('hello there');
    assert.match(res.reason, /edit \.znrules at line 2 or delete that line/);
    assert.match(res.reason, /zn-gate check/);
  });
  inProject({ 'zn.config.json': JSON.stringify({ bannedPatterns: ['ok', NESTED] }) }, () => {
    assert.match(rules.evaluate('hello there').reason, /edit zn\.config\.json at bannedPatterns\[1\] or delete that entry/);
  });
  inProject({ '.znrules': NESTED + '\n' }, () => {
    const cli = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), 'doctor'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ZN_STATS: 'off', HOME: process.cwd(), USERPROFILE: process.cwd() }, timeout: 60000,
    });
    assert.match(cli.stdout, /Project rules: \.znrules has 1 error/);
    assert.match(cli.stdout, /line 1:/);
  });
});

test('audit with an invalid rules file reports one configuration finding, not one per line', () => {
  const { audit } = require('../lib/audit');
  const cwd = process.cwd();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-rules-audit-')));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Notes\nRun the tests with npm test before you push.\nKeep functions short and well named.\n');
    fs.writeFileSync(path.join(dir, '.znrules'), '# mine\n' + NESTED + '\n');
    process.chdir(dir);
    rules.loadCustomConfig(true);
    const res = audit({ root: dir, agents: ['all'], env: {} });
    assert.equal(res.findings.filter((f) => f.id === 'ZNA012').length, 0);
    const cfgFindings = res.findings.filter((f) => f.file === '.znrules');
    assert.equal(cfgFindings.length, 1);
    assert.equal(cfgFindings[0].line, 2);
    assert.match(cfgFindings[0].detail, /not valid/);
    assert.match(cfgFindings[0].detail, /exponential/);
    assert.match(cfgFindings[0].detail, /edit \.znrules line 2 or delete it/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    rules.loadCustomConfig(true);
  }
});

test('the tool-output note does not call a broken rules file "instructions to you"', async () => {
  const adapter = require('../lib/agents/claude-code');
  const runner = require('../lib/hooks/runner');
  const { createFakeVault } = require('./helpers/fake_vault');
  const fakeEngine = require('./helpers/fake_engine');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-rules-home-')));
  const cwd = process.cwd();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-rules-out-')));
  try {
    fs.writeFileSync(path.join(dir, '.znrules'), NESTED + '\n');
    process.chdir(dir);
    rules.loadCustomConfig(true);
    const ev = { session_id: 'abc123', cwd: dir, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com/' }, tool_response: { result: 'Welcome to Example.com. Real content here, nothing special.' }, tool_use_id: 'toolu_09' };
    const res = await runner.handle(adapter, ev, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', home });
    assert.ok(!/reads like instructions|invalid_rules/.test(JSON.stringify(res.output || {})));
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    rules.loadCustomConfig(true);
  }
});

test('plain-text patterns match like the JavaScript engine with the i flag, on ASCII letters', () => {
  const srcs = ['abc', 'aab', 'ABAB', 'rule_7', 'a b', 'x-y/z', 'aaaaab', 'token=xyz', 'Hello, World!'];
  const texts = ['abc', 'xxABCxx', 'aaab', 'aaaab', 'abababab', 'ABAB', 'RULE_7 here', 'a  b', 'a b', 'X-Y/Z', 'aaaaaab', 'TOKEN=XYZ',
    'hello, world!', '', 'a', '\u212ABC', 'k\u212A', '\u017Fabc', 'ab\u0131c', 'ab'.repeat(50) + 'c'];
  for (const src of srcs) {
    const re = new RegExp(src, 'i');
    const mine = compileCustomPattern(src);
    assert.equal(mine.ok, true, src);
    for (const t of texts) {
      // Outside ASCII the JavaScript engine folds a few more letters; only the ASCII results must agree.
      if (/[^\x00-\x7f]/.test(t)) continue;
      assert.equal(mine.rule.test(t), re.test(t), `${src} on ${JSON.stringify(t)}`);
    }
  }
  // Characters outside ASCII never match an ASCII pattern by folding (Kelvin sign, long s, dotless i).
  assert.equal(compileCustomPattern('k').rule.test('\u212A'), false);
  assert.equal(compileCustomPattern('s').rule.test('\u017F'), false);
});

test('a file of the most plain-text rules stays within the budget and scans fast', () => {
  const lines = Array.from({ length: MAX_PATTERNS }, (_, k) => `SECRET_PROJECT_NAME_NUMBER_${k}`);
  inProject({ '.znrules': lines.join('\n') }, () => {
    const cfg = rules.loadCustomConfig();
    assert.deepEqual(cfg.errors, []);
    const text = 'secret_project_name_number_'.repeat(9000) + 'x';
    const { ms } = timed(() => { for (const p of cfg.bannedPatterns) p.test(text); });
    assert.ok(ms < 2000, `${ms} ms`);
    assert.equal(cfg.bannedPatterns[7].test('see secret_project_name_number_7 now'), true);
  });
});
