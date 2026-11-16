'use strict';

// Edge cases of the process-table parsers behind the parent-process check: text from Linux (/proc stat),
// macOS (ps) and Windows (CIM JSON) with missing columns, spaces in names and empty output. All values are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../lib/broker/ancestry');

const { agentOf, parseStat, parsePs, parseCim } = _internal;

test('parseStat: empty, truncated and odd names', () => {
  assert.equal(parseStat(''), null);
  assert.equal(parseStat('no closing bracket here'), null);
  // Nothing after the name: the parent is unknown and reads as 0.
  assert.deepEqual(parseStat('4242 (bash)'), { name: 'bash', ppid: 0 });
  assert.deepEqual(parseStat('4242 (bash) S'), { name: 'bash', ppid: 0 });
  // A parent field that is not a number reads as 0.
  assert.deepEqual(parseStat('4242 (bash) S abc 1'), { name: 'bash', ppid: 0 });
  assert.deepEqual(parseStat('4242 () S 9 1'), { name: '', ppid: 9 });
  assert.deepEqual(parseStat('4242 (Web Content) S 311 4242 4242 0 -1\n'), { name: 'Web Content', ppid: 311 });
  assert.deepEqual(parseStat('4242 (a) b) S 12 1'), { name: 'a) b', ppid: 12 });
  assert.deepEqual(parseStat('1 (systemd) S 0 1 1 0 -1'), { name: 'systemd', ppid: 0 });
});

test('parsePs: empty output, blank and malformed lines, missing columns', () => {
  assert.equal(parsePs('').size, 0);
  assert.equal(parsePs('\n\n   \n').size, 0);
  assert.equal(parsePs(undefined).size, 0);
  const t = parsePs([
    '  PID  PPID COMMAND',
    '  100',
    '  100   1',
    'abc def ghi jkl',
    '  200     1 launchd',
    '  300   200 zsh -zsh',
    '',
  ].join('\n'));
  assert.deepEqual([...t.keys()], [200, 300]);
  // No args column: the program name stands in for the arguments.
  assert.deepEqual(t.get(200), { pid: 200, ppid: 1, name: 'launchd', argv: ['launchd'] });
  assert.deepEqual(t.get(300).argv, ['-zsh']);
});

test('parsePs: Linux ps output, tabs and a name with spaces', () => {
  const t = parsePs('    1     0 systemd /sbin/init splash\n  900     1 claude claude --resume  abc\n' +
    '  901   900 Google Chrome Helper --type=gpu\n');
  assert.deepEqual(t.get(1).argv, ['/sbin/init', 'splash']);
  assert.deepEqual(t.get(900).argv, ['claude', '--resume', 'abc']);
  assert.equal(agentOf(t.get(900)), 'claude');
  // A name with spaces is cut at the first space; the rest becomes arguments.
  assert.equal(t.get(901).name, 'Google');
  assert.deepEqual(t.get(901).argv, ['Chrome', 'Helper', '--type=gpu']);
  assert.equal(agentOf(t.get(901)), null);
  assert.equal(parsePs('\t12\t3\tbash\tbash -l').get(12).ppid, 3);
});

test('parsePs: a later line with the same pid replaces the earlier one', () => {
  const t = parsePs('  5   1 old old\n  5   2 new new\n');
  assert.equal(t.size, 1);
  assert.equal(t.get(5).name, 'new');
  assert.equal(t.get(5).ppid, 2);
});

test('parseCim: empty and invalid output', () => {
  for (const text of ['', '   ', '\n', undefined, 'null', '[]', '{}', '[null, 1, "x"]', '{"ProcessId": "7"}', '[{"ProcessId": 1.5}]', '[{"Name": "a.exe"}]']) {
    assert.equal(parseCim(text).size, 0, String(text));
  }
});

test('parseCim: missing columns', () => {
  const t = parseCim(JSON.stringify([
    { ProcessId: 1 },
    { ProcessId: 2, ParentProcessId: 'x', Name: null, CommandLine: '' },
    { ProcessId: 3, ParentProcessId: 2, Name: 'cmd.exe' },
    { ProcessId: 4, ParentProcessId: 3, Name: 'codex.exe', CommandLine: '   ' },
  ]));
  assert.equal(t.get(1).ppid, 0);
  assert.equal(t.get(1).name, '');
  assert.equal(t.get(1).created, undefined);
  assert.equal(t.get(2).ppid, 0);
  assert.equal(t.get(2).name, '');
  assert.equal(t.get(3).ppid, 2);
  assert.deepEqual(t.get(3).argv, ['cmd.exe']);
  // A blank command line falls back to the process name for the program.
  assert.deepEqual(t.get(4).argv, ['codex.exe']);
  assert.equal(agentOf(t.get(4)), 'codex');
});

test('parseCim: spaces in the program path, quoted or not, and the Created column', () => {
  const t = parseCim(JSON.stringify([
    { ProcessId: 10, ParentProcessId: 4, Name: 'claude.exe', CommandLine: String.raw`"C:\Users\Jane Doe\bin\claude.exe" --resume`, Created: 1700000000000 },
    { ProcessId: 11, ParentProcessId: 10, Name: 'cmd.exe', CommandLine: String.raw`C:\Windows\System32\cmd.exe /c  echo   hi` },
    { ProcessId: 12, ParentProcessId: 10, Name: 'x.exe', CommandLine: '""', Created: 'soon' },
    { ProcessId: 13, ParentProcessId: 10, Name: 'y.exe', CommandLine: 'y.exe', Created: -5 },
    { ProcessId: 14, ParentProcessId: 10, Name: 'z.exe', CommandLine: 'z.exe', Created: 0 },
  ]));
  assert.deepEqual(t.get(10).argv, [String.raw`C:\Users\Jane Doe\bin\claude.exe`, '--resume']);
  assert.equal(t.get(10).created, 1700000000000);
  assert.equal(agentOf(t.get(10)), 'claude');
  assert.deepEqual(t.get(11).argv, [String.raw`C:\Windows\System32\cmd.exe`, '/c', 'echo', 'hi']);
  assert.equal(t.get(11).created, undefined);
  assert.deepEqual(t.get(12).argv, ['']);
  for (const pid of [12, 13, 14]) assert.equal(t.get(pid).created, undefined, String(pid));
});

test('parseCim: a single object, not an array, and a padded document', () => {
  const one = parseCim('\n  {"ProcessId": 8, "ParentProcessId": 2, "Name": "opencode.exe", "CommandLine": "opencode.exe"}  \n');
  assert.equal(one.size, 1);
  assert.equal(agentOf(one.get(8)), 'opencode');
});
