'use strict';
// lib/stats.js counters across agents: summary() over a missing file, an empty file, one agent, many agents
// and an unknown agent name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { record, summary } = require('../lib/stats');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-agents-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const now = new Date('2026-10-14T10:00:00Z');
let n = 0;
const freshFile = () => path.join(dir, `stats-${n++}.json`);
const zero = { checked: 0, blocked: 0, warned: 0, redacted: 0 };

test('a missing stats file gives zero totals and no agents', () => {
  const s = summary({ now, file: path.join(dir, 'does-not-exist.json') });
  assert.deepEqual(s.total, zero);
  assert.deepEqual(s.byKey, {});
  assert.deepEqual(s.detections, {});
  assert.equal(s.since, null);
});

test('an empty stats file gives zero totals and no agents', () => {
  const file = freshFile();
  fs.writeFileSync(file, '');
  const s = summary({ now, file });
  assert.deepEqual(s.total, zero);
  assert.deepEqual(s.byKey, {});
  assert.equal(s.since, null);
});

test('one agent: counts add up over several records', () => {
  const file = freshFile();
  record({ layer: 'hook', agent: 'claude-code', checked: 1, blocked: 1 }, { file, now });
  record({ layer: 'hook', agent: 'claude-code', checked: 2, warned: 1, redacted: 3 }, { file, now });
  const s = summary({ now, file });
  assert.deepEqual(Object.keys(s.byKey), ['hook:claude-code']);
  assert.deepEqual(s.byKey['hook:claude-code'], { checked: 3, blocked: 1, warned: 1, redacted: 3 });
  assert.deepEqual(s.total, s.byKey['hook:claude-code']);
  assert.equal(s.since, '2026-10-14');
});

test('many agents: each keeps its own counts and the total is their sum', () => {
  const file = freshFile();
  record({ layer: 'hook', agent: 'claude-code', checked: 4, blocked: 1 }, { file, now });
  record({ layer: 'hook', agent: 'cursor', checked: 2, warned: 2 }, { file, now });
  record({ layer: 'mcp', agent: 'cursor', checked: 5, redacted: 1 }, { file, now });
  record({ layer: 'hook', agent: 'codex', checked: 1 }, { file, now: new Date('2026-10-13T10:00:00Z') });
  const s = summary({ now, file });
  assert.deepEqual(s.byKey['hook:claude-code'], { checked: 4, blocked: 1, warned: 0, redacted: 0 });
  assert.deepEqual(s.byKey['hook:cursor'], { checked: 2, blocked: 0, warned: 2, redacted: 0 });
  assert.deepEqual(s.byKey['mcp:cursor'], { checked: 5, blocked: 0, warned: 0, redacted: 1 });
  assert.deepEqual(s.byKey['hook:codex'], { checked: 1, blocked: 0, warned: 0, redacted: 0 });
  assert.deepEqual(s.total, { checked: 12, blocked: 1, warned: 2, redacted: 1 });
  assert.equal(s.since, '2026-10-13');
});

test('a day outside the window is not counted', () => {
  const file = freshFile();
  record({ layer: 'hook', agent: 'cursor', checked: 1 }, { file, now: new Date('2026-10-01T10:00:00Z') });
  record({ layer: 'hook', agent: 'cursor', checked: 1 }, { file, now });
  const s = summary({ now, file, days: 3 });
  assert.equal(s.total.checked, 1);
});

test('unknown or unusable agent names are counted under other', () => {
  const file = freshFile();
  record({ layer: 'hook', agent: 'My Custom Agent!', checked: 1 }, { file, now });
  record({ layer: 'hook', agent: '', checked: 1 }, { file, now });
  record({ layer: 'hook', checked: 1 }, { file, now });
  record({ layer: 'nonexistent', agent: 'cursor', checked: 1 }, { file, now });
  const s = summary({ now, file });
  assert.equal(s.byKey['hook:other'].checked, 2);
  assert.equal(s.byKey['hook:my-custom-agent-'].checked, 1);
  assert.equal(s.byKey['cli:cursor'].checked, 1);
  assert.equal(s.total.checked, 4);
});
