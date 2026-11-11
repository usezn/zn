'use strict';

process.env.ZN_STATS = 'off';

// GNU find -files0-from FILE (or - for stdin) takes its starting paths from a file the command text does not show.
// A delete over them cannot be checked, so it is refused; the file is never read. Only example paths; only text is checked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand } = require('../lib/destructive');

const rule = (cmd) => { const r = checkCommand(cmd); return r.verdict === 'block' ? r.rule.replace('destructive:', '') : 'allow'; };

test('a delete whose starting paths come from -files0-from is refused', () => {
  for (const c of ['find -files0-from - -delete', 'find -files0-from list.txt -delete', "find -files0-from list.txt -name '*.tmp' -delete",
    "find -files0-from - -type f -name '*.tmp' -delete", "find -files0-from list.txt -name '*.tmp' -exec rm {} ;",
    "find -files0-from list.txt -name '*.tmp' -execdir rm {} ;", "find -files0-from list.txt -name '*.tmp' -ok rm {} ;"]) {
    assert.equal(rule(c), 'rm_root_home', c);
  }
});

test('-files0-from without a delete stays allowed, and ordinary find verdicts do not change', () => {
  for (const c of ["find -files0-from list.txt -name '*.tmp' -print", 'find -files0-from - -print', "find -files0-from list.txt -name '*.tmp' -exec ls {} ;",
    "find ./build -name '*.tmp' -delete", 'find ./build -type f -print']) {
    assert.equal(rule(c), 'allow', c);
  }
  assert.equal(rule("find / -name '*.tmp' -delete"), 'rm_root_home');
});
