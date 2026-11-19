'use strict';

process.env.ZN_STATS = 'off';

// env -S "STRING" splits STRING into words, and env reads those words again as options and a command, so a string that
// itself holds an -S option (env -S "-S rm -rf DIR", env -S "env -S 'rm -rf DIR'") is split a second time. The check reads
// such strings again the same way, up to three levels deep, and refuses a deeper one. The words after an -S value belong to
// the command the string names, even when env took them for options (env -S "rm" -rf DIR).
// Only the text is checked; nothing is run. Mirrored by packages/zn-gate-py/tests/test_destructive_nested_env_split.py.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

// The command wrapped in env -S '...' that many times (single quotes inside are closed and reopened).
const nest = (cmd, levels) => {
  let s = cmd;
  for (let k = 0; k < levels; k++) s = "env -S '" + s.replace(/'/g, "'\\''") + "'";
  return s;
};

const BLOCK = [
  'env -S "-S rm -rf /home/alice"',
  'env -S "-S rm" -rf /home/alice',
  'env -S "rm" -rf /home/alice',
  'env -S "-S -S rm -rf /usr"',
  'env -S "-S \'rm -rf\' /home/alice"',
  'env -S "env -S \'rm -rf /home/alice\'"',
  'env -S "-S env -S \'rm -rf /home/alice\'"',
  'env --split-string "-S rm -rf /etc"',
  'env -S "--split-s rm -rf /etc"',
  'sudo env -S "-S rm -rf /usr"',
  'env -S "-i -S rm -rf /home/alice"',
  nest('rm -rf /home/alice', 1),
  nest('rm -rf /home/alice', 2),
  nest('rm -rf /home/alice', 3),
  nest('rm -rf /', 3),
  nest('sh -c "rm -rf /home/alice"', 2),
];

const ALLOW = [
  'env -S "-S ls -la"',
  'env -S "-S rm -rf ./build"',
  'env -S "-S rm -f notes.txt"',
  'env -S "-S echo hello"',
  'env -S "rm" -rf ./build',
  'env -S "-S -S ls -la"',
  'env -S "env -S \'ls -la\'"',
  nest('ls -la', 1),
  nest('ls -la', 2),
  nest('ls -la', 3),
  nest('rm -rf ./build', 3),
];

// Four levels are more than the check follows: refused, whatever the command is.
const TOO_DEEP = [
  nest('rm -rf /home/alice', 4),
  nest('ls -la', 4),
  nest('echo hello', 5),
];

test('nested env -S strings that delete a home, root or system folder are blocked', () => {
  for (const c of BLOCK) assert.equal(rule(c), 'rm_root_home', JSON.stringify(c));
});

test('nested env -S strings of harmless commands stay allowed', () => {
  for (const c of ALLOW) assert.equal(rule(c), 'allow', JSON.stringify(c));
});

test('env -S strings nested deeper than three levels are refused', () => {
  for (const c of TOO_DEEP) assert.equal(rule(c), 'too_many_commands', JSON.stringify(c));
});
