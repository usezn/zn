'use strict';
// The skip accounting of run-all.js: which skips it reads from node:test output, and which ones it lets through.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseSkips, unexpectedSkips, loadExpected } = require('./run-all');

test('parseSkips reads the TAP and the spec form, and nothing else', () => {
  const tap = [
    'ok 1 - a normal test',
    'ok 2 - needs pwsh # SKIP pwsh not installed',
    '    ok 3 - nested # SKIP',
    'not ok 4 - failing',
    'ok 5 - mentions # SKIP only inside the name?',
  ].join('\n');
  const names = parseSkips(tap).map((s) => s.name);
  assert.deepEqual(names, ['needs pwsh', 'nested', 'mentions']);
  assert.equal(parseSkips(tap)[0].reason, 'pwsh not installed');
  const spec = ['✔ fine (1.2ms)', '﹣ needs sh (0.2ms) # needs sh', '  ﹣ bare (0.1ms)', 'skipped 2'].join('\n');
  assert.deepEqual(parseSkips(spec).map((s) => s.name), ['needs sh', 'bare']);
  assert.deepEqual(parseSkips('ok 1 - fine\nall tests passed'), []);
});

test('unexpectedSkips lets through only what the list names for this platform', () => {
  const expected = [
    { platforms: ['linux'], test: '^only on linux$', reason: 'r' },
    { platforms: ['*'], test: 'anywhere', reason: 'r' },
  ];
  const skips = [{ name: 'only on linux' }, { name: 'runs anywhere ok' }, { name: 'pwsh missing' }];
  assert.deepEqual(unexpectedSkips(skips, expected, 'linux').map((s) => s.name), ['pwsh missing']);
  assert.deepEqual(unexpectedSkips(skips, expected, 'win32').map((s) => s.name), ['only on linux', 'pwsh missing']);
});

test('expected-skips.json is well formed and every entry has a reason', () => {
  const list = loadExpected(path.join(__dirname, 'expected-skips.json'));
  assert.ok(list.length > 0);
  for (const e of list) assert.ok(e.reason.trim().length > 5, e.test);
});
