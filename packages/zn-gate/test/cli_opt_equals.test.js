'use strict';
// scan and analyze take --option=value as well as --option value, as the Python CLI does. The tests run the CLI
// itself: both forms of every value option must behave the same, and a flag must still refuse a value.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const VALUE_OPTIONS = {
  scan: ['--format', '--include', '--exclude', '--key', '--stage', '--url', '--long-input', '--package'],
  analyze: ['--key', '--stage', '--url', '--long-input'],
};
const FLAGS = {
  scan: ['--code', '--all', '--allow-partial', '--include-home', '--local-only', '--verbose'],
  analyze: ['--local-only', '--verbose'],
};

// Runs the CLI in an empty home folder, so nothing is read from or written to the real one. --local-only keeps analyze off the network.
function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-opt-equals-'));
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 60000,
    });
    // The messages name the folder the run used: compare them without it.
    return { status: r.status, stderr: (r.stderr || '').split(home).join('<home>') };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const command of Object.keys(VALUE_OPTIONS)) {
  for (const name of VALUE_OPTIONS[command]) {
    test(`${command} ${name}: the equals form behaves like the spaced form`, () => {
      const spaced = run([command, name, 'value', '--local-only', '--', 'missing-target']);
      const equals = run([command, `${name}=value`, '--local-only', '--', 'missing-target']);
      assert.strictEqual(equals.status, spaced.status);
      assert.strictEqual(equals.stderr, spaced.stderr);
      assert.doesNotMatch(equals.stderr, /unknown option|give the value as the next argument/);
    });
  }

  for (const flag of FLAGS[command]) {
    test(`${command} ${flag}: a flag still refuses a value`, () => {
      const r = run([command, `${flag}=1`, '--', 'missing-target']);
      assert.strictEqual(r.status, 2);
      assert.match(r.stderr, new RegExp(`${flag} takes no value`));
    });
  }

  test(`${command}: an unknown option with an equals sign is still refused`, () => {
    const r = run([command, '--no-such-option=1', '--', 'missing-target']);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown option "--no-such-option=1"/);
  });
}

test('analyze: after a bare "--" every argument is text, equals form included', () => {
  const r = run(['analyze', '--local-only', '--', '--key=not-an-option', '--format=json']);
  assert.doesNotMatch(r.stderr, /unknown option|takes no value|give the value as the next argument/);
});
