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
  assert.equal(compileCustomPattern('a'.repeat(MAX_PATTERN_LENGTH)).ok, true);
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
