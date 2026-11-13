'use strict';

// printPlan of zn-gate uninstall with a fake io object: an empty plan, a one-item plan and a long plan,
// and the text stays plain when NO_COLOR is set. Nothing touches the real disk or terminal.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { printPlan } = require('../lib/uninstall');

function fakeIo() {
  const chunks = [];
  return { io: { stdout: { write: (s) => { chunks.push(String(s)); return true; } } }, text: () => chunks.join(''), lines: () => chunks.join('').split('\n') };
}
function emptyPlan() {
  return { agents: [], wrapped: [], launchers: [], shadowed: [], vault: { exists: false, home: '/example/.zn', lines: [] } };
}
const HEADER = ['', 'zn-gate uninstall: what zn-gate set up on this computer', ''];

test('printPlan: an empty plan says nothing was found', () => {
  const f = fakeIo();
  printPlan(emptyPlan(), f.io);
  assert.deepEqual(f.lines(), [...HEADER, 'Nothing from zn-gate was found for your user or this folder.', '']);
});

test('printPlan: a one-item plan lists the agent and its hook file', () => {
  const f = fakeIo();
  const p = emptyPlan();
  p.agents.push({ id: 'cursor', name: 'Cursor', userHooks: '/example/home/.cursor/hooks.json', projectHooks: null, plugin: null });
  printPlan(p, f.io);
  assert.deepEqual(f.lines(), [
    ...HEADER,
    'Will be removed:',
    '  Cursor',
    '    - zn\'s hooks for your user (and its "secrets" MCP server, if listed): /example/home/.cursor/hooks.json',
    '',
  ]);
});

test('printPlan: a long plan prints every section in order', () => {
  const f = fakeIo();
  const p = emptyPlan();
  p.agents.push({ id: 'claude-code', name: 'Claude Code', userHooks: '/example/u.json', projectHooks: '/example/proj/p.json', plugin: '/example/plugin' });
  for (let i = 0; i < 20; i++) p.agents.push({ id: 'a' + i, name: 'Agent ' + i, userHooks: '/example/a' + i + '.json', projectHooks: null, plugin: null });
  p.wrapped.push(
    { name: 'Env A', file: '/example/a.json', servers: 2, backup: '/example/a.json.bak', unsafe: null },
    { name: 'Env B', file: '/example/b.json', servers: 1, backup: null, unsafe: null },
    { name: 'Env C', file: '/example/c.json', servers: 1, backup: null, unsafe: 'a symlink' });
  p.vault = { exists: true, home: '/example/.zn', lines: ['/example/.zn/vault.db', '/example/.zn/audit.log'] };
  p.shadowed = ['/example/proj/.env', '/example/proj/.env.local'];
  printPlan(p, f.io);
  const t = f.text();
  const lines = f.lines();
  assert.equal(lines.filter((l) => /^ {2}Agent \d+$/.test(l)).length, 20);
  assert.ok(t.includes('    - the zn-gate plugin (/example/plugin)\n'));
  assert.ok(t.includes('    - zn\'s hooks for this project: /example/proj/p.json\n'));
  assert.ok(t.includes('    - Env A (2 wrapped): /example/a.json goes back to the copy saved before wrapping (/example/a.json.bak); changes made to that file since are lost\n'));
  assert.ok(t.includes('    - Env B (1 wrapped): /example/b.json has no saved copy, so it is left as it is: remove the "zn-gate shield" wrapping by hand\n'));
  assert.ok(t.includes('    - Env C (1 wrapped): /example/c.json cannot be restored safely (a symlink), so it is left as it is: remove'));
  assert.ok(t.includes('  The vault in /example/.zn: your stored secrets. Deleting it cannot be undone.\n'));
  assert.ok(t.includes('    - /example/.zn/vault.db\n    - /example/.zn/audit.log\n'));
  assert.ok(t.includes('  - /example/proj/.env holds zn markers instead of values.'));
  assert.ok(t.includes('  - /example/proj/.env.local holds zn markers'));
  const order = ['Will be removed:', '  MCP servers wrapped', 'Asked separately at the end (default no):', 'Left alone:'].map((s) => t.indexOf(s));
  assert.ok(order.every((n) => n >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(t.includes('Nothing from zn-gate was found'), false);
});

test('printPlan: output is plain text with or without NO_COLOR', () => {
  const saved = process.env.NO_COLOR;
  const plan = () => {
    const p = emptyPlan();
    p.agents.push({ id: 'codex', name: 'Codex CLI', userHooks: '/example/hooks.json', projectHooks: null, plugin: null });
    p.vault = { exists: true, home: '/example/.zn', lines: ['/example/.zn/vault.db'] };
    return p;
  };
  try {
    delete process.env.NO_COLOR;
    const a = fakeIo(); printPlan(plan(), a.io);
    process.env.NO_COLOR = '1';
    const b = fakeIo(); printPlan(plan(), b.io);
    assert.equal(b.text(), a.text());
    assert.equal(/\u001b\[/.test(b.text()), false);
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});
