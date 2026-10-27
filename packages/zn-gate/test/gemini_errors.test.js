'use strict';
/* Error paths of the Gemini CLI adapter's install, using a temporary fake home. */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const gemini = require('../lib/agents/gemini');

test('gemini install: a settings file whose hooks.BeforeTool is not a list is refused and left unchanged', (t) => {
  const home = tempDir(t, 'zn-gemini-home-');
  const file = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ hooks: { BeforeTool: { matcher: 'x' } } });
  fs.writeFileSync(file, original);
  assert.throws(
    () => gemini.install({ home, command: 'zn hook gemini' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, '"hooks.BeforeTool" in ' + file + ' must be a list (left unchanged)');
      return true;
    }
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
