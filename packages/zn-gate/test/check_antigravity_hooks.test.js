'use strict';
process.env.ZN_STATS = 'off';

// zn-gate check and Antigravity's "enabled" flag and other hooks. The hooks page says "Set to `false` to disable the
// hook without removing it. Defaults to `true`." and, for `allow`, "delegating to the next hook or default policy";
// it says nothing about the order of hooks or which answer wins, so check can only point at another hook.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const check = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const agy = getAdapter('antigravity');

function setup(t) {
  const home = tempDir(t, 'zn-agy-en-');
  const cwd = tempDir(t, 'zn-agy-en-cwd-');
  agy.install({ scope: 'user', home, nodePath: process.execPath });
  const file = agy.hooksFile({ home });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = (d) => fs.writeFileSync(file, JSON.stringify(d));
  const find = async (opts = {}) => (await check.check({ home, cwd, env: { ...process.env, HOME: home }, live: false, ...opts })).results.find((r) => r.id === 'antigravity');
  return { home, cwd, file, read, write, find };
}

const other = (extra = {}) => ({ enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/opt/other/hook.sh', timeout: 5 }] }], ...extra });

test('zn\'s hook with "enabled": false is not protected, and check says how to turn it back on', async (t) => {
  const s = await setup(t);
  assert.equal((await s.find()).state, 'protected');
  const d = s.read();
  d['zn-gate'].enabled = false;
  s.write(d);
  const r = await s.find();
  assert.equal(r.state, 'not-protected');
  assert.match(r.problem, /"enabled": false/);
  assert.match(r.problem, /zn does not protect Antigravity/);
  assert.match(r.fix, /zn hooks install antigravity/);
  assert.match(r.fix, /"enabled" to true/);
  // the printed report says the same
  let text = '';
  check.report({ results: [r], notes: [] }, (x) => { text += x; });
  assert.match(text, /"enabled": false/);
  // the repair it names works
  agy.install({ scope: 'user', home: s.home, nodePath: process.execPath });
  assert.equal((await s.find()).state, 'protected');
});

test('a disabled zn hook next to an enabled one does not change the result; a disabled foreign hook is no zn hook', async (t) => {
  const s = await setup(t);
  const d = s.read();
  d['zn-old'] = { ...d['zn-gate'], enabled: false };
  d.somebody = other({ enabled: false });
  s.write(d);
  const r = await s.find();
  assert.equal(r.state, 'protected', r.problem);
  assert.ok(!r.notes.some((n) => /another Antigravity hook/.test(n)), 'a hook that is turned off is not "another hook"');
  // only a foreign hook, turned off: zn is not set up at all
  const home2 = tempDir(t, 'zn-agy-en2-');
  fs.mkdirSync(path.dirname(agy.hooksFile({ home: home2 })), { recursive: true });
  fs.writeFileSync(agy.hooksFile({ home: home2 }), JSON.stringify({ somebody: other({ enabled: false }) }));
  const res = (await check.check({ home: home2, cwd: s.cwd, env: { ...process.env, HOME: home2 }, live: false })).results.find((x) => x.id === 'antigravity');
  assert.equal(res.state, 'not-set-up');
});

test('another enabled PreToolUse hook (user or project file) is noted: its order and winner are not documented', async (t) => {
  const s = await setup(t);
  const clean = await s.find();
  assert.ok(!clean.notes.some((n) => /another Antigravity hook/.test(n)));
  const d = s.read();
  d.audit = other();
  d.logger = { enabled: true, PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/opt/log.sh' }] }] };
  s.write(d);
  let r = await s.find();
  assert.equal(r.state, 'protected', 'a note, not a failure');
  const note = r.notes.find((n) => /another Antigravity hook/.test(n));
  assert.ok(note, JSON.stringify(r.notes));
  assert.match(note, /"audit"/);
  assert.match(note, /does not document in which order hooks run or which answer wins/);
  assert.ok(!/"logger"/.test(note) && !/and \d+ more/.test(note), 'a PostToolUse-only hook does not decide a call');
  // a hook in the project file counts too
  const d2 = s.read();
  delete d2.audit;
  s.write(d2);
  fs.mkdirSync(path.join(s.cwd, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(s.cwd, '.agents', 'hooks.json'), JSON.stringify({ teamhook: other() }));
  r = await s.find();
  const note2 = r.notes.find((n) => /another Antigravity hook/.test(n));
  assert.ok(note2 && /"teamhook"/.test(note2) && note2.includes(path.join('.agents', 'hooks.json')), JSON.stringify(r.notes));
  // zn's own project hook is not "another hook"
  agy.install({ scope: 'project', projectDir: s.cwd });
  fs.writeFileSync(path.join(s.cwd, '.agents', 'hooks.json'), JSON.stringify({ 'zn-gate': JSON.parse(fs.readFileSync(path.join(s.cwd, '.agents', 'hooks.json'), 'utf8'))['zn-gate'] }));
  r = await s.find();
  assert.ok(!r.notes.some((n) => /another Antigravity hook/.test(n)), JSON.stringify(r.notes));
});

test('two or more other hooks are counted in one note', async (t) => {
  const s = await setup(t);
  const d = s.read();
  d.a = other();
  d.b = other();
  s.write(d);
  const note = (await s.find()).notes.find((n) => /another Antigravity hook/.test(n));
  assert.match(note, /and 1 more/);
});
