'use strict';
/* `doctor` is the same command as `check`: same exit code, same output, and no stats counted. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(command, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home };
  delete env.ZN_STATS;
  const r = spawnSync(process.execPath, [CLI, command], { env, cwd: home, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: normalize(r.stdout, home), err: normalize(r.stderr, home) };
}

// Replace temporary paths and timings so two runs can be compared line by line.
function normalize(text, home) {
  return String(text)
    .split(home).join('<home>')
    .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '<time>')
    .split(/\r?\n/);
}

test('doctor and check give the same exit code and output lines, and count nothing', (t) => {
  const homeCheck = tempDir(t, 'zn-alias-check-');
  const homeDoctor = tempDir(t, 'zn-alias-doctor-');
  const a = run('check', homeCheck);
  const b = run('doctor', homeDoctor);
  assert.notStrictEqual(a.status, null);
  assert.strictEqual(b.status, a.status);
  assert.deepStrictEqual(b.out, a.out);
  assert.deepStrictEqual(b.err, a.err);
  for (const home of [homeCheck, homeDoctor]) {
    assert.strictEqual(fs.existsSync(path.join(home, 'stats.json')), false);
    assert.strictEqual(fs.existsSync(path.join(home, '.zn', 'stats.json')), false);
  }
});
