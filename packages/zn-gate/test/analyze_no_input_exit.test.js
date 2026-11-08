'use strict';
// bin/cli.js analyze with no text and an empty stdin: the real behaviour is exit 1 with an error line
// that shows the usage on stderr and no JSON on stdout. The premise "exit 2" is kept as a todo until
// the product changes; the product code is not touched here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

const run = (args) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-analyze-no-input-'));
  try {
    const env = { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home };
    delete env.ZN_STATS;
    delete env.ZN_CLOUD;
    delete env.ZN_API_KEY;
    // input '' closes stdin: nothing to read, so the command must not wait for a terminal.
    return spawnSync(process.execPath, [CLI, 'analyze', ...args], { encoding: 'utf8', env, input: '' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

test('analyze with no text and an empty stdin exits 1 with a usage line on stderr and no JSON', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Please provide text to analyze: zn-gate analyze "<text>"/);
});

test('analyze with no text exits 2 as the spec says', {
  todo: 'premise mismatch: bin/cli.js analyze exits 1 (not 2) when no text is given; product code not changed',
}, () => {
  assert.equal(run([]).status, 2);
});
