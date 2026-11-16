'use strict';
// zn-gate report: argument parsing (--since) and the display name of an MCP server (safeName).
const test = require('node:test');
const assert = require('node:assert/strict');
const report = require('../lib/report');

const days = (args) => report.parse(args).days;
const bad = (args) => report.parse(args).bad;

test('parse: --since takes a whole number of days from 1 to 90', () => {
  for (const [args, want] of [[['--since', '1d'], 1], [['--since', '30d'], 30], [['--since=90d'], 90], [['--since', '007d'], 7]]) {
    const o = report.parse(args);
    assert.equal(o.bad, false, args.join(' '));
    assert.equal(o.days, want, args.join(' '));
  }
  assert.deepEqual(report.parse([]), { days: 7, json: false, teamLine: true, bad: false });
});

test('parse: zero, negative, fractional, text and out-of-range values are rejected', () => {
  for (const v of ['0d', '-3d', '1.5d', 'abc', 'd', '', '7', '91d', '1000d', '0000d', ' 7d', '7d ', '7D', '+7d', '7dd']) {
    assert.equal(bad(['--since', v]), true, JSON.stringify(v));
    assert.equal(bad([`--since=${v}`]), true, `--since=${JSON.stringify(v)}`);
    assert.equal(days(['--since', v]), 7, 'the window stays at the default: ' + JSON.stringify(v));
  }
});

test('parse: a missing value or a flag in place of a value is rejected', () => {
  assert.equal(bad(['--since']), true);
  assert.equal(bad(['--since=']), true);
  const o = report.parse(['--since', '--json']);
  assert.equal(o.bad, true);
  assert.equal(o.json, false, 'the next word is taken as the value');
});

test('parse: repeated flags', () => {
  assert.equal(days(['--since', '1d', '--since', '30d']), 30, 'the last valid value wins');
  assert.equal(days(['--since=5d', '--since', '10d']), 10);
  assert.equal(bad(['--since', '1d', '--since', 'x']), true, 'a later bad value is still an error');
  assert.equal(bad(['--since', 'x', '--since', '30d']), true, 'a later good value does not clear an earlier error');
  const o = report.parse(['--json', '--json', '--no-team-line', '--no-team-line']);
  assert.equal(o.json, true);
  assert.equal(o.teamLine, false);
  assert.equal(o.bad, false);
});

test('parse: unknown words and the old --days spelling are rejected', () => {
  for (const args of [['--days', '7'], ['--days=7d'], ['--bogus'], ['7d'], ['--JSON'], ['--json=1']]) {
    assert.equal(bad(args), true, args.join(' '));
  }
});

test('safeName: folders, drive letters and separators are dropped', () => {
  const cases = {
    'node ../../srv/main.js': 'node main.js',
    'node ./srv.js': 'node srv.js',
    'node /opt/srv/': 'node srv',
    'node srv/': 'node srv',
    '/usr/local/bin/python3 /opt/app/server.py': 'python3 server.py',
    'D:\\tools\\node.exe D:\\app\\srv.js': 'node srv.js',
    'node a\\b/c.js': 'node c.js',
    '/opt/tools/my-server --flag': 'my-server',
    'npx @scope/pkg': 'npx @scope/pkg',
    'npx @scope/pkg/sub': 'npx @scope/pkg/sub',
    'NODE.EXE srv.js': 'NODE', // runner names are matched in lower case only
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(report.safeName(cmd), want, cmd);
});

test('safeName: unusual characters in the program or package fall back to a safe label', () => {
  const cases = {
    'node sr$v.js': 'node',
    'node srv;ls': 'node',
    'node "srv.js"': 'node',
    "node 'srv.js'": 'node',
    'node srv\u202e.js': 'node',
    'node s\u00e9rv.js': 'node',
    'node ..': 'node',
    'node .hidden.js': 'node',
    'node ~/srv.js': 'node srv.js',
    [`npx ${'a'.repeat(61)}`]: 'npx',
    'sr$v --x': 'MCP server',
    '.hidden-srv': 'MCP server',
    'srv\u0000x': 'MCP server',
    '   ': 'MCP server',
    'env': 'MCP server',
    '-x': 'MCP server',
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(report.safeName(cmd), want, JSON.stringify(cmd));
  assert.equal(report.safeName(`npx ${'a'.repeat(60)}`), `npx ${'a'.repeat(60)}`);
  for (const v of [null, undefined, 0, false]) assert.equal(report.safeName(v), 'MCP server');
});
