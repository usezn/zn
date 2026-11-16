'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/broker/markers');

test('isLoopbackHost accepts the loopback forms', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST', 'LocalHost']) {
    assert.equal(m.isLoopbackHost(host), true, 'should be loopback: ' + host);
  }
});

test('isLoopbackHost rejects public names and addresses', () => {
  for (const host of ['example.com', 'api.example.com', '192.0.2.10', '203.0.113.7', '::2', '2001:db8::1']) {
    assert.equal(m.isLoopbackHost(host), false, 'should not be loopback: ' + host);
  }
});

test('isLoopbackHost rejects names that only look local', () => {
  const lookalikes = [
    'localhost.example.com',
    'notlocalhost',
    'localhost.invalid',
    '127.0.0.1.example.com',
    'x127.0.0.1',
    '127.0.0',
    '127.0.0.1.5',
    '1127.0.0.1',
    '::1.example.com',
    '::ffff:127.0.0.1',
    'local host',
  ];
  for (const host of lookalikes) {
    assert.equal(m.isLoopbackHost(host), false, 'should not be loopback: ' + host);
  }
});

test('isLoopbackHost treats empty and missing input as not loopback', () => {
  for (const host of ['', null, undefined]) {
    assert.equal(m.isLoopbackHost(host), false);
  }
});

test('markerRegex returns a fresh global regex on every call', () => {
  const a = m.markerRegex();
  const b = m.markerRegex();
  assert.notEqual(a, b);
  assert.equal(a.flags, 'g');
  assert.equal(a.lastIndex, 0);
  assert.deepEqual('__ZN_A__ __ZN_B_1__'.match(a), ['__ZN_A__', '__ZN_B_1__']);
  assert.equal(b.lastIndex, 0);
});

test('markers are found on lines in several comment styles', () => {
  const lines = {
    'hash': '# token: __ZN_API_KEY__',
    'slashes': '// token: __ZN_API_KEY__',
    'block': '/* __ZN_API_KEY__ */',
    'html': '<!-- __ZN_API_KEY__ -->',
    'sql': '-- __ZN_API_KEY__',
    'semicolon': '; key=__ZN_API_KEY__',
    'jsdoc': ' * @token __ZN_API_KEY__',
    'trailing': 'key = 1 # __ZN_API_KEY__',
  };
  for (const [style, line] of Object.entries(lines)) {
    assert.deepEqual(
      m.findMarkers(line),
      [{ marker: '__ZN_API_KEY__', name: 'API_KEY', detected: false }],
      'comment style: ' + style
    );
    assert.equal(m.substitute(line, new Map([['API_KEY', 'fake']])).includes('fake'), true, style);
  }
});

test('markers on several comment lines keep their order and flags', () => {
  const text = ['# __ZN_FIRST__', '// __ZN_SECOND_2__', '/* __ZN_FIRST__ */', '-- __ZN_THIRD__'].join('\n');
  assert.deepEqual(m.findMarkers(text).map((x) => [x.name, x.detected]), [
    ['FIRST', false],
    ['SECOND_2', true],
    ['THIRD', false],
  ]);
});

test('matchCommandEntry matches a bare command and its arguments as a prefix', () => {
  assert.equal(m.matchCommandEntry('psql', ['psql']), true);
  assert.equal(m.matchCommandEntry('psql', ['psql', '-c', 'select 1']), true);
  assert.equal(m.matchCommandEntry('  psql  ', ['psql']), true);
  assert.equal(m.matchCommandEntry('npm run migrate', ['npm', 'run', 'migrate', '--', 'x']), true);
  assert.equal(m.matchCommandEntry('npm run migrate', ['npm', 'run']), false);
  assert.equal(m.matchCommandEntry('npm run migrate', ['npm', 'run', 'build']), false);
  assert.equal(m.matchCommandEntry('psql', ['pg_dump']), false);
});

test('matchCommandEntry rejects empty entries and bad argv', () => {
  assert.equal(m.matchCommandEntry('', ['psql']), false);
  assert.equal(m.matchCommandEntry('   ', ['psql']), false);
  assert.equal(m.matchCommandEntry(null, ['psql']), false);
  assert.equal(m.matchCommandEntry('psql', []), false);
  assert.equal(m.matchCommandEntry('psql', 'psql'), false);
  assert.equal(m.matchCommandEntry('psql', null), false);
});

test('matchCommandEntry never lets a bare entry match an explicit path', () => {
  assert.equal(m.matchCommandEntry('psql', ['./psql']), false);
  assert.equal(m.matchCommandEntry('psql', ['/usr/bin/psql']), false);
  assert.equal(m.matchCommandEntry('psql', ['bin/psql']), false);
});

test('matchCommandEntry compares path entries by their resolved path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-markers-'));
  try {
    const tool = path.join(dir, 'tool');
    const other = path.join(dir, 'other');
    assert.equal(m.matchCommandEntry(tool, [tool]), true);
    assert.equal(m.matchCommandEntry(tool + ' sub', [tool, 'sub', 'more']), true);
    assert.equal(m.matchCommandEntry(tool, [path.join(dir, '.', 'tool')]), true);
    assert.equal(m.matchCommandEntry(tool, [other]), false);
    assert.equal(m.matchCommandEntry(tool, ['tool']), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matchAllowCommands returns the normalised first matching entry', () => {
  assert.equal(m.matchAllowCommands(['pg_dump', '  npm   run  migrate '], ['npm', 'run', 'migrate']), 'npm run migrate');
  assert.equal(m.matchAllowCommands(['psql'], ['node']), null);
  assert.equal(m.matchAllowCommands(undefined, ['node']), null);
});
