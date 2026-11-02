'use strict';
// scan and analyze take --option=value as well as --option value, as the Python CLI does. The table test below
// runs over every option the two commands take, so a new value option is covered without a new test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { COMMAND_OPTIONS, expandEqualsOptions, optionProblem } = require('../lib/cli-args');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const COMMANDS = ['scan', 'analyze'];

for (const command of COMMANDS) {
  for (const name of COMMAND_OPTIONS[command].value) {
    test(`${command} ${name}: the equals form reads the same as the spaced form`, () => {
      const spaced = [command, name, 'value', 'rest'];
      assert.deepStrictEqual(expandEqualsOptions(command, spaced), spaced);
      assert.deepStrictEqual(expandEqualsOptions(command, [command, `${name}=value`, 'rest']), spaced);
      assert.strictEqual(optionProblem(command, spaced), null);
      assert.strictEqual(optionProblem(command, expandEqualsOptions(command, [command, `${name}=value`])), null);
    });

    test(`${command} ${name}: an empty value and a value with equals signs or dashes`, () => {
      assert.deepStrictEqual(expandEqualsOptions(command, [command, `${name}=`]), [command, name, '']);
      assert.deepStrictEqual(expandEqualsOptions(command, [command, `${name}=a=b`]), [command, name, 'a=b']);
      assert.deepStrictEqual(expandEqualsOptions(command, [command, `${name}=--code`]), [command, name, '--code']);
      for (const args of [[command, `${name}=`], [command, `${name}=a=b`], [command, `${name}=--code`]]) {
        assert.strictEqual(optionProblem(command, expandEqualsOptions(command, args)), null, args.join(' '));
      }
    });

    test(`${command} ${name}: a spaced value that looks like an option is still the value`, () => {
      const args = [command, name, '--code'];
      assert.deepStrictEqual(expandEqualsOptions(command, args), args);
      assert.strictEqual(optionProblem(command, args), null);
    });
  }

  for (const flag of COMMAND_OPTIONS[command].flag) {
    test(`${command} ${flag}: a flag is still a flag and refuses a value`, () => {
      assert.strictEqual(optionProblem(command, [command, flag]), null);
      const withValue = expandEqualsOptions(command, [command, `${flag}=1`]);
      assert.deepStrictEqual(withValue, [command, `${flag}=1`]);
      assert.match(optionProblem(command, withValue), new RegExp(`${flag} takes no value`));
    });
  }

  test(`${command}: an unknown option with an equals sign is still refused`, () => {
    const args = expandEqualsOptions(command, [command, '--no-such-option=1']);
    assert.match(optionProblem(command, args), /unknown option "--no-such-option=1"/);
  });
}

test('analyze: after a bare "--" every argument is text, equals form included', () => {
  const args = ['analyze', '--', '--key=not-an-option', '--format=json'];
  assert.deepStrictEqual(expandEqualsOptions('analyze', args), args);
  assert.strictEqual(optionProblem('analyze', args), null);
});

test('scan: the equals form and the spaced form give the same output and exit code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-optq-'));
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'A harmless note with no instructions.\n');
    const env = { ...process.env, ZN_LOCAL_ONLY: 'true' };
    const spaced = spawnSync(process.execPath, [CLI, 'scan', '--format', 'json', dir], { encoding: 'utf8', env });
    const equals = spawnSync(process.execPath, [CLI, 'scan', '--format=json', dir], { encoding: 'utf8', env });
    assert.strictEqual(equals.status, spaced.status, equals.stderr);
    assert.strictEqual(equals.stderr, spaced.stderr);
    assert.strictEqual(equals.stdout, spaced.stdout);
    assert.strictEqual(equals.status, 0, equals.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyze: --stage=VALUE is read as --stage VALUE, not refused', () => {
  const r = spawnSync(process.execPath, [CLI, 'analyze', '--stage=v30', '--local-only', 'hello there'], {
    encoding: 'utf8',
    env: { ...process.env, ZN_LOCAL_ONLY: 'true' },
  });
  assert.doesNotMatch(r.stderr, /takes no value|unknown option|give the value/);
});

test('analyze --json is accepted with --opt=value options and takes no value', () => {
  const ok = optionProblem('analyze', expandEqualsOptions('analyze', ['analyze', '--json', '--stage=v30', 'hello']));
  assert.strictEqual(ok, null);
  const bad = optionProblem('analyze', expandEqualsOptions('analyze', ['analyze', '--json=1', 'hello']));
  assert.strictEqual(bad, '--json takes no value.');
});
