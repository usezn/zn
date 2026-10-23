'use strict';
// A skill note that CLAUDE.md or AGENTS.md imports with @path is loaded as instructions: never lowered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { audit } = require('../lib/audit');

const FRONT = '---\nname: demo\ndescription: Demo skill\n---\n';
const NOTE = '.claude/skills/demo/ref.md';
const ORDER = '# Readiness: <system-or-project>' + String.fromCharCode(10);

function run(t, files, note) {
  const dir = tempDir(t, 'zn-audit-impskill-');
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return audit({ root: dir, agents: ['all'], env: {} }).findings.filter((f) => f.id === 'ZNA012' && f.file === (note || NOTE));
}
const base = { '.claude/skills/demo/SKILL.md': FRONT, [NOTE]: ORDER };

test('audit: a skill note that is not imported is lowered, as before', (t) => {
  const f = run(t, base);
  assert.deepEqual(f, []);
});

for (const loader of ['CLAUDE.md', 'AGENTS.md']) {
  test('audit: a skill note imported by ' + loader + ' stays high', (t) => {
    const f = run(t, { ...base, [loader]: '# Project\nRead @' + NOTE + ' first.\n' });
    assert.ok(f.length > 0);
    assert.ok(f.every((x) => x.severity === 'high'));
  });
  test('audit: import order does not matter for ' + loader + ' (skills folder sorted after the import)', (t) => {
    const zzz = '.claude/skills/zzz/ref.md';
    const f = run(t, { [loader]: '@' + zzz + '\n', '.claude/skills/zzz/SKILL.md': FRONT, [zzz]: ORDER }, zzz);
    assert.ok(f.length > 0);
    assert.ok(f.every((x) => x.severity === 'high'));
  });
}
