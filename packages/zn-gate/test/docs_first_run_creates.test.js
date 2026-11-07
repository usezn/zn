'use strict';
// The first-run example lists what each step creates. The init row must not claim that plain
// init creates nothing, because init can install hooks (settings backup and launcher script).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', '..', '..', 'docs', 'examples', 'unix-first-run.md');

test('first-run init row mentions the hooks files', { skip: !fs.existsSync(file) }, () => {
  const row = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('| 3. '));
  assert.ok(row, 'step 3 row exists');
  assert.ok(!/Not listed for plain/.test(row));
  assert.ok(/backup/.test(row) && /~\/\.zn\/hooks/.test(row));
});
