'use strict';

// Edge cases of lib/broker/run.js that the other run tests do not reach:
// batchInvocation (refusals, boundaries, non-Windows behaviour), the argument
// and marker helpers, and parseRunArgs corner cases. Fictitious values only.

const test = require('node:test');
const assert = require('node:assert/strict');

const run = require('../lib/broker/run');
const { batchInvocation, systemCmdExe, parseRunArgs, requiredSecrets, argvMarkers, optionalSecrets, referencedSecrets } = run;

const WIN = process.platform === 'win32';
const BAT = 'C:\\tools\\deploy.cmd';

const denied = (fn, re) => assert.throws(fn, (e) => e.code === 'ZN_POLICY_DENIED' && (!re || re.test(e.message)));

test('batchInvocation: an argument that differs from the original is refused, even if harmless', () => {
  denied(() => batchInvocation(BAT, ['changed'], ['original']), /deploy\.cmd is a batch file/);
});

test('batchInvocation: more arguments than originals counts as changed', () => {
  denied(() => batchInvocation(BAT, ['a', 'b'], ['a']));
});

test('batchInvocation: fewer arguments than originals is not treated as changed', () => {
  // Only the arguments that are passed are compared. Without cmd.exe on this
  // platform the outcome is a policy denial, never a crash.
  if (WIN) {
    // With cmd.exe present, only the arguments passed are compared, so the call is allowed.
    assert.doesNotThrow(() => batchInvocation(BAT, ['a'], ['a', 'b']));
  } else {
    denied(() => batchInvocation(BAT, ['a'], ['a', 'b']), /could not find the system cmd\.exe/);
  }
});

test('batchInvocation: each metacharacter is refused alone, including carriage return', () => {
  for (const c of ['&', '|', '<', '>', '^', '%', '!', '"', '\r', '\n']) {
    denied(() => batchInvocation(BAT, ['x' + c + 'y'], ['x' + c + 'y']), /shell metacharacters/);
  }
});

test('batchInvocation: characters that are safe in an argument do not trigger the metacharacter refusal', () => {
  const args = ['--flag=value', 'two words', 'a;b', "it's", '(x)', '', 'C:\\dir\\file.txt'];
  if (WIN) {
    const b = batchInvocation(BAT, args, args);
    assert.equal(b.args[3], '/c');
  } else {
    denied(() => batchInvocation(BAT, args, args), /could not find the system cmd\.exe/);
  }
});

test('batchInvocation: the program path is refused for %, !, quote and line breaks, but not for & or ^', () => {
  for (const p of ['C:\\a%b\\x.cmd', 'C:\\a!b\\x.cmd', 'C:\\a"b\\x.cmd', 'C:\\a\rb\\x.cmd', 'C:\\a\nb\\x.cmd']) {
    denied(() => batchInvocation(p, [], []), /is a batch file: zn run will not pass/);
  }
  // & and ^ in the path are not in the path's refusal set: the call goes on to cmd.exe lookup.
  if (!WIN) denied(() => batchInvocation('C:\\a&b\\x.cmd', [], []), /could not find the system cmd\.exe/);
});

test('batchInvocation: the refusal names the file by its base name only', () => {
  const resolved = require('path').join('some-dir', 'deploy.cmd');
  try {
    batchInvocation(resolved, ['a&b'], ['a&b']);
    assert.fail('expected a refusal');
  } catch (e) {
    assert.equal(e.code, 'ZN_POLICY_DENIED');
    assert.ok(e.message.startsWith('deploy.cmd is a batch file'));
    assert.ok(!e.message.includes('some-dir'));
  }
});

test('batchInvocation: without a system cmd.exe (not Windows) nothing is started and the next step is named', { skip: WIN && 'non-Windows only' }, () => {
  assert.equal(systemCmdExe(), null);
  denied(() => batchInvocation(BAT, [], []), /Next step: run a program file \(\.exe\)/);
});

test('batchInvocation: on Windows the line is quoted per part and quotes are doubled by cmdQuote only when allowed', { skip: !WIN && 'Windows only' }, () => {
  const b = batchInvocation(BAT, ['one', 'two words'], ['one', 'two words']);
  assert.deepEqual(b.args, ['/d', '/v:off', '/s', '/c', '"' + '"C:\\tools\\deploy.cmd" "one" "two words"' + '"']);
  const empty = batchInvocation(BAT, [], []);
  assert.equal(empty.args[4], '""C:\\tools\\deploy.cmd""');
});

test('batchInvocation: an empty original list with extra arguments is refused as changed', () => {
  denied(() => batchInvocation(BAT, ['x'], []));
});

test('parseRunArgs: empty and repeated separators in the secret list are ignored', () => {
  assert.deepEqual(parseRunArgs(['--secrets', ',A_ONE,, ,B_TWO,', '--', 'x']), { secrets: ['A_ONE', 'B_TWO'], command: ['x'] });
  assert.deepEqual(parseRunArgs(['--secrets=', '--', 'x']), { secrets: [], command: ['x'] });
});

test('parseRunArgs: agent id boundaries (1 and 32 characters, digits and dashes)', () => {
  assert.equal(parseRunArgs(['--agent', 'a', '--', 'x']).agent, 'a');
  assert.equal(parseRunArgs(['--agent', 'a'.repeat(32), '--', 'x']).agent, 'a'.repeat(32));
  assert.equal(parseRunArgs(['--agent', 'a-1', '--', 'x']).agent, 'a-1');
  assert.throws(() => parseRunArgs(['--agent', '', '--', 'x']), /invalid --agent/);
  assert.throws(() => parseRunArgs(['--agent', 'UPPER', '--', 'x']), /invalid --agent/);
  assert.throws(() => parseRunArgs(['--agent', 'a_b', '--', 'x']), /invalid --agent/);
});

test('parseRunArgs: options after the first -- belong to the command; text before it is refused', () => {
  assert.deepEqual(parseRunArgs(['--', '--secrets', 'A_ONE']), { secrets: [], command: ['--secrets', 'A_ONE'] });
  assert.throws(() => parseRunArgs(['x', '--', 'y']), /unexpected argument before --: x/);
});

test('parseRunArgs: the second of two valid secrets being invalid is still refused', () => {
  assert.throws(() => parseRunArgs(['--secrets', 'A_ONE,bad name', '--', 'x']), /invalid secret name "bad name"/);
});

test('requiredSecrets: removes duplicates and keeps order; empty input gives an empty list', () => {
  assert.deepEqual(requiredSecrets({ secrets: ['B_TWO', 'A_ONE', 'B_TWO'] }), ['B_TWO', 'A_ONE']);
  assert.deepEqual(requiredSecrets({ secrets: [] }), []);
});

test('argvMarkers: finds named markers in any argument once, none in plain arguments', () => {
  assert.deepEqual(argvMarkers({ command: [] }), []);
  assert.deepEqual(argvMarkers({ command: ['tool', '--flag', 'plain', ''] }), []);
  assert.deepEqual(argvMarkers({ command: ['tool', '--k=__ZN_A_ONE__', 'x__ZN_B_TWO__y', '__ZN_A_ONE__'] }), ['A_ONE', 'B_TWO']);
});

test('optionalSecrets: reads markers from environment values, skips required names, tolerates a missing env', () => {
  assert.deepEqual(optionalSecrets({ secrets: [] }, undefined), []);
  assert.deepEqual(optionalSecrets({ secrets: [] }, {}), []);
  const env = { ONE: '__ZN_A_ONE__', TWO: 'pre-__ZN_B_TWO__-post', THREE: 'plain', FOUR: '__ZN_A_ONE__' };
  assert.deepEqual(optionalSecrets({ secrets: [] }, env), ['A_ONE', 'B_TWO']);
  assert.deepEqual(optionalSecrets({ secrets: ['A_ONE'] }, env), ['B_TWO']);
});

test('referencedSecrets: required names come first, then optional ones from the environment', () => {
  assert.deepEqual(referencedSecrets({ secrets: ['C_THREE'] }, { X: '__ZN_A_ONE__' }), ['C_THREE', 'A_ONE']);
  assert.deepEqual(referencedSecrets({ secrets: [] }, {}), []);
});
