'use strict';

// lib/linear-text.js: string helpers that replaced regexes which backtracked on long runs.
// test/redos_linear.test.js compares them with the old regexes on random input; this file pins the
// hand-picked cases: empty input, long runs (1 MB, with a time bound), control characters and Windows paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const lt = require('../lib/linear-text');

const MB = 1024 * 1024;
const LIMIT_MS = 1000;

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('trimTrailing removes only the listed characters from the end', () => {
  assert.equal(lt.trimTrailing('abc///', '/'), 'abc');
  assert.equal(lt.trimTrailing('a*=*', '*='), 'a');
  assert.equal(lt.trimTrailing('a/b', '/'), 'a/b');
  assert.equal(lt.trimTrailing(' \t x \t ', ' \t'), ' \t x');
  assert.equal(lt.trimTrailing('C:\\Users\\me\\x\\', '\\'), 'C:\\Users\\me\\x');
});

test('trimTrailing on empty and all-matching input', () => {
  assert.equal(lt.trimTrailing('', '/'), '');
  assert.equal(lt.trimTrailing('///', '/'), '');
});

test('trimTrailing leaves control characters alone', () => {
  assert.equal(lt.trimTrailing('a\u0001', '/'), 'a\u0001');
});

test('trimTrailing on 1 MB of one character is linear', () => {
  const { out, ms } = timed(() => lt.trimTrailing('x' + '='.repeat(MB), '='));
  assert.equal(out, 'x');
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
});

test('stripInlineComment cuts at the whitespace before " #"', () => {
  assert.equal(lt.stripInlineComment('value # comment'), 'value');
  assert.equal(lt.stripInlineComment('value\t#comment'), 'value');
  assert.equal(lt.stripInlineComment('value'), 'value');
  assert.equal(lt.stripInlineComment(''), '');
  assert.equal(lt.stripInlineComment('a#b'), 'a#b');
});

test('stripInlineComment only looks at the last line of a multi-line value', () => {
  // Same results as the old /\s+#.*$/: the comment has to run to the end of the value.
  assert.equal(lt.stripInlineComment('value # a\n# b'), 'value # a');
  assert.equal(lt.stripInlineComment('value\n# b'), 'value');
  assert.equal(lt.stripInlineComment('a\nb'), 'a\nb');
  assert.equal(lt.stripInlineComment('key=val\r # c'), 'key=val');
});

test('stripInlineComment with control characters and Windows paths', () => {
  assert.equal(lt.stripInlineComment('a\u0000 # b'), 'a\u0000');
  assert.equal(lt.stripInlineComment('a \u0001 # c'), 'a \u0001');
  assert.equal(lt.stripInlineComment('C:\\Users\\me\\x # note'), 'C:\\Users\\me\\x');
  assert.equal(lt.stripInlineComment('C:\\Users\\me#x'), 'C:\\Users\\me#x');
});

test('stripInlineComment on 1 MB of spaces is linear', () => {
  const spaces = 'a' + ' '.repeat(MB);
  const { out, ms } = timed(() => lt.stripInlineComment(spaces));
  assert.equal(out, spaces);
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
  const cut = timed(() => lt.stripInlineComment('a' + ' '.repeat(MB) + '# c'));
  assert.equal(cut.out, 'a');
  assert.ok(cut.ms < LIMIT_MS, `took ${cut.ms} ms`);
});

test('lines splits at every kind of line break', () => {
  assert.deepEqual(lt.lines('a\nb\r\nc\rd\u2028e\u2029f'), ['a', 'b', '', 'c', 'd', 'e', 'f']);
  assert.deepEqual(lt.lines(''), ['']);
  assert.deepEqual(lt.lines('no breaks'), ['no breaks']);
  assert.deepEqual(lt.lines('a\n'), ['a', '']);
});

test('lines keeps tabs, NULs and Windows paths inside a line', () => {
  assert.deepEqual(lt.lines('a\tb\u0000c'), ['a\tb\u0000c']);
  assert.deepEqual(lt.lines('C:\\Users\\me\\x\r\nD:\\y'), ['C:\\Users\\me\\x', '', 'D:\\y']);
});

test('lines on 1 MB of line breaks is linear', () => {
  const { out, ms } = timed(() => lt.lines('\n'.repeat(MB)));
  assert.equal(out.length, MB + 1);
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
});

test('npmAuth reads an auth key from a trimmed .npmrc line', () => {
  assert.deepEqual(lt.npmAuth('//registry.npmjs.org/:_authToken=abc123'), ['_authToken', 'abc123']);
  assert.deepEqual(lt.npmAuth('_auth=dXNlcjpwYXNz'), ['_auth', 'dXNlcjpwYXNz']);
  assert.deepEqual(lt.npmAuth('_password=pw'), ['_password', 'pw']);
  assert.deepEqual(lt.npmAuth('_authToken = abc'), ['_authToken', 'abc']);
});

test('npmAuth returns null when there is no key or no single-token value', () => {
  assert.equal(lt.npmAuth(''), null);
  assert.equal(lt.npmAuth('registry=https://registry.example.com'), null);
  assert.equal(lt.npmAuth('_authToken='), null);
  assert.equal(lt.npmAuth('_authToken=abc def'), null);
});

test('npmAuth keeps control characters in the value and finds a key after a Windows path', () => {
  assert.deepEqual(lt.npmAuth('_authToken=abc\u0000'), ['_authToken', 'abc\u0000']);
  assert.deepEqual(lt.npmAuth('C:\\Users\\me\\.npmrc:_authToken=abc'), ['_authToken', 'abc']);
});

test('npmAuth on long input is linear', () => {
  const long = timed(() => lt.npmAuth('_authToken=' + 'a'.repeat(MB)));
  assert.equal(long.out[1].length, MB);
  assert.ok(long.ms < LIMIT_MS, `took ${long.ms} ms`);
  const colons = timed(() => lt.npmAuth(':'.repeat(MB)));
  assert.equal(colons.out, null);
  assert.ok(colons.ms < LIMIT_MS, `took ${colons.ms} ms`);
  const spaces = timed(() => lt.npmAuth('_authToken' + ' '.repeat(MB) + '=x'));
  assert.deepEqual(spaces.out, ['_authToken', 'x']);
  assert.ok(spaces.ms < LIMIT_MS, `took ${spaces.ms} ms`);
});

test('znrulesValue reads the value after "secret:"', () => {
  assert.equal(lt.znrulesValue('secret: abc123'), 'abc123');
  assert.equal(lt.znrulesValue('   secret:   value  '), 'value');
  assert.equal(lt.znrulesValue('secret: C:\\Users\\me\\x'), 'C:\\Users\\me\\x');
  assert.equal(lt.znrulesValue('secret: a\u0000b'), 'a\u0000b');
});

test('znrulesValue returns null for other lines and empty values', () => {
  assert.equal(lt.znrulesValue('secret:'), null);
  assert.equal(lt.znrulesValue('secret:\r'), null);
  assert.equal(lt.znrulesValue('SECRET: x'), null);
  assert.equal(lt.znrulesValue('secretary: x'), null);
  assert.equal(lt.znrulesValue('NAME=abc'), null);
  assert.equal(lt.znrulesValue(''), null);
});

test('znrulesValue on a whitespace-only value gives the last space, as the old regex did', () => {
  // Same as /^\s*secret:\s*(.+?)\s*$/: the one-character group takes the last space or tab. The caller
  // (lib/scrub/exact.js) drops any value shorter than 8 characters, so this never becomes a scrubbed value.
  assert.equal(lt.znrulesValue('secret:   '), ' ');
  assert.equal(lt.znrulesValue('secret:\t'), '\t');
});

test('znrulesValue on long input is linear', () => {
  const spaces = timed(() => lt.znrulesValue('secret:' + ' '.repeat(MB) + 'x'));
  assert.equal(spaces.out, 'x');
  assert.ok(spaces.ms < LIMIT_MS, `took ${spaces.ms} ms`);
  const value = timed(() => lt.znrulesValue('secret: ' + 'a'.repeat(MB)));
  assert.equal(value.out.length, MB);
  assert.ok(value.ms < LIMIT_MS, `took ${value.ms} ms`);
});
