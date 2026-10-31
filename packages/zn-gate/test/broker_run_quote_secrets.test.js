'use strict';

// cmdQuote and referencedSecrets of `zn run` (lib/broker/run.js). Pure functions: no process is started
// except the POSIX round trip through sh. Fictitious names and values only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const { referencedSecrets, cmdQuote } = require('../lib/broker/run');

test('cmdQuote: plain words, spaces and empty strings are wrapped in double quotes', () => {
  assert.equal(cmdQuote('plain'), '"plain"');
  assert.equal(cmdQuote('a b'), '"a b"');
  assert.equal(cmdQuote('  leading and trailing  '), '"  leading and trailing  "');
  assert.equal(cmdQuote(''), '""');
});

test('cmdQuote: a double quote is doubled, a single quote is left alone', () => {
  assert.equal(cmdQuote('say "hi"'), '"say ""hi"""');
  assert.equal(cmdQuote('"'), '""""');
  assert.equal(cmdQuote("it's"), '"it\'s"');
  assert.equal(cmdQuote("'quoted'"), '"\'quoted\'"');
});

test('cmdQuote: newlines and tabs stay inside the quotes as they are', () => {
  assert.equal(cmdQuote('line one\nline two'), '"line one\nline two"');
  assert.equal(cmdQuote('a\tb'), '"a\tb"');
  assert.equal(cmdQuote('a\r\nb'), '"a\r\nb"');
});

test('cmdQuote: backslashes inside an argument are left alone', () => {
  assert.equal(cmdQuote('C:\\Program Files\\zn\\bin'), '"C:\\Program Files\\zn\\bin"');
  assert.equal(cmdQuote('\\\\server\\share'), '"\\\\server\\share"');
});

test('cmdQuote: backslashes before a double quote or the closing quote are doubled (MSVCRT rules)', () => {
  assert.equal(cmdQuote('C:\\dir\\'), '"C:\\dir\\\\"');
  assert.equal(cmdQuote('a\\\\'), '"a\\\\\\\\"');
  assert.equal(cmdQuote('x y\\'), '"x y\\\\"');
  assert.equal(cmdQuote('\\'), '"\\\\"');
  assert.equal(cmdQuote('dir\\"'), '"dir\\\\"""');
  assert.equal(cmdQuote('a\\\\"b'), '"a\\\\\\\\""b"');
});

test('cmdQuote: non-string arguments are converted with String()', () => {
  assert.equal(cmdQuote(42), '"42"');
  assert.equal(cmdQuote(null), '"null"');
});

test('cmdQuote: on POSIX, sh -c gives back the original argv for arguments without double quotes', (t) => {
  if (process.platform === 'win32') { t.skip('POSIX shell round trip'); return; }
  const args = ['plain', 'a b', "it's", '', 'line one\nline two', 'C:\\Users\\zn', '  spaced  ', '--flag=value'];
  // printf writes each argument followed by NUL, so newlines inside an argument survive the split.
  const script = 'set -- ' + args.map(cmdQuote).join(' ') + '; printf \'%s\\0\' "$@"';
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = r.stdout.split('\0');
  got.pop(); // the empty piece after the last NUL
  assert.deepEqual(got, args);
});

test('referencedSecrets: names from --secrets are returned, duplicates once', () => {
  assert.deepEqual(referencedSecrets({ secrets: ['DEMO_KEY', 'DEMO_TWO', 'DEMO_KEY'], command: ['x'] }, {}), ['DEMO_KEY', 'DEMO_TWO']);
  assert.deepEqual(referencedSecrets({ secrets: [], command: ['x'] }, {}), []);
});

test('referencedSecrets: a named marker in an inherited environment value is found', () => {
  const env = { PATH: '/bin', DEMO_URL: 'https://user:__ZN_DEMO_DB__@db.example.test/app', OTHER: 'nothing here' };
  assert.deepEqual(referencedSecrets({ secrets: [], command: ['x'] }, env), ['DEMO_DB']);
});

test('referencedSecrets: a marker already in --secrets is not listed twice', () => {
  const env = { A: '__ZN_DEMO_KEY__ and __ZN_DEMO_KEY__', B: '__ZN_DEMO_KEY__' };
  assert.deepEqual(referencedSecrets({ secrets: ['DEMO_KEY'], command: ['x'] }, env), ['DEMO_KEY']);
});

test('referencedSecrets: several different markers in one value are all found, in order', () => {
  const env = { A: '__ZN_DEMO_ONE__:__ZN_DEMO_TWO__' };
  assert.deepEqual(referencedSecrets({ secrets: [], command: ['x'] }, env), ['DEMO_ONE', 'DEMO_TWO']);
});

test('referencedSecrets: detected markers (name ending in _digits) are not secret names', () => {
  const env = { A: '__ZN_DEMO_KEY_1__ __ZN_DEMO_2__' };
  assert.deepEqual(referencedSecrets({ secrets: [], command: ['x'] }, env), []);
});

test('referencedSecrets: look-alikes that are not markers are ignored', () => {
  const env = {
    LOWER: '__ZN_demo_key__',          // lower case name
    NO_CLOSE: '__ZN_DEMO_KEY',         // unterminated
    ONE_SIDE: 'ZN_DEMO_KEY__',         // no leading underscores
    SINGLE: '_ZN_DEMO_KEY_',           // one underscore each side
    EMPTY: '__ZN____',                 // empty name
    DIGIT_START: '__ZN_1DEMO__',       // name must start with a letter
    '__ZN_KEY_ONLY_IN_NAME__': 'plain value',
  };
  assert.deepEqual(referencedSecrets({ secrets: [], command: ['x'] }, env), []);
});

test('referencedSecrets: a marker in the command arguments is not a referenced secret (argvMarkers refuses it)', () => {
  const parsed = { secrets: [], command: ['tool', '--token', '__ZN_DEMO_KEY__'] };
  assert.deepEqual(referencedSecrets(parsed, {}), []);
});

test('referencedSecrets: a null or missing environment is treated as empty', () => {
  assert.deepEqual(referencedSecrets({ secrets: ['DEMO_KEY'], command: ['x'] }, null), ['DEMO_KEY']);
  assert.deepEqual(referencedSecrets({ secrets: ['DEMO_KEY'], command: ['x'] }), ['DEMO_KEY']);
});

test('referencedSecrets: non-string environment values are skipped without error', () => {
  const env = { N: 42, U: undefined, O: { nested: '__ZN_DEMO_KEY__' }, S: '__ZN_DEMO_OK__' };
  assert.deepEqual(referencedSecrets({ secrets: [], command: ['x'] }, env), ['DEMO_OK']);
});
