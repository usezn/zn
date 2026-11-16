'use strict';

// docs/compat.md and lib/agents/tested-versions.json must name the same tested versions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TESTED } = require('../lib/agents/versions');

const DOC = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'compat.md'), 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const [id, e] of Object.entries(TESTED)) {
  if (!e.tested) continue;
  test('docs/compat.md names ' + e.docsName + ' ' + e.tested + ' (' + id + ', from tested-versions.json)', () => {
    assert.ok(e.docsName, id + ': a tested version needs a docsName');
    const re = new RegExp(esc(e.docsName) + '[^\\n]{0,12}?\\b' + esc(e.tested) + '\\b');
    assert.match(DOC, re, 'update docs/compat.md or lib/agents/tested-versions.json so they agree');
  });
}

test('docs/compat.md points to the data file as the source of the tested versions', () => {
  assert.match(DOC, /lib\/agents\/tested-versions\.json/);
});
