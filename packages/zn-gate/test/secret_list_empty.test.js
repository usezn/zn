'use strict';
/*
 * `zn secret list` on an unlocked vault with no secrets prints one clear line
 * that says nothing is stored and how to add one, and exits 0.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

process.env.ZN_STATS = 'off';

const cli = require('../lib/broker/cli');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

test('zn secret list on an empty vault prints the empty message and exits 0', async (t) => {
  const home = tempDir(t, 'zn-secret-list-');
  const zn = path.join(home, '.zn');
  fs.mkdirSync(zn, { recursive: true });
  const previous = process.env.ZN_HOME;
  process.env.ZN_HOME = zn;
  t.after(() => {
    if (previous === undefined) delete process.env.ZN_HOME;
    else process.env.ZN_HOME = previous;
  });

  const stdout = sink();
  const stderr = sink();
  const code = await cli.dispatch('secret', ['list'], { vault: createFakeVault(), stdout, stderr, home });

  assert.equal(code, 0, stderr.text());
  assert.equal(stderr.text(), '');
  const lines = stdout.text().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, stdout.text());
  assert.match(lines[0], /^No secrets stored\. Add one with: zn secret set NAME/);
});
