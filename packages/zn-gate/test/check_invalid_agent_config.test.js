'use strict';
process.env.ZN_STATS = 'off';

// zn-gate check and an agent config file that is not valid JSON or that the user may not read: the check names the
// file and what is wrong, says to fix or move it (`zn hooks install` fails on such a file), and the "Hooks: ... broken"
// line counts it as broken, so the two never disagree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const check = require('../lib/check');
const hooksList = require('../lib/hooks-list');
const { tempDir } = require('./helpers/tmp');

const AGENTS = ['codex', 'cursor', 'antigravity', 'copilot', 'gemini', 'zcode', 'claude-code'];
const canChmod = process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);

function setup(t, id) {
  const home = tempDir(t, 'zn-badcfg-');
  const cwd = tempDir(t, 'zn-badcfg-cwd-');
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  const spec = check.AGENTS.find((a) => a.id === id);
  const file = spec.file(getAdapter(id), { home, env });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const run = async () => {
    const res = await check.check({ home, cwd, env, live: false });
    return res;
  };
  return { home, cwd, env, file, run };
}

function printed(res) {
  let text = '';
  const code = check.report(res, (x) => { text += x; });
  return { text, code };
}

for (const id of AGENTS) {
  test(id + ': an invalid JSON config is named, not called "not set up", and counted as broken', async (t) => {
    const s = setup(t, id);
    fs.writeFileSync(s.file, '{\n  "hooks": {\n    oops,\n  }\n}\n');
    const res = await s.run();
    const r = res.results.find((x) => x.id === id);
    assert.equal(r.state, 'not-protected');
    assert.ok(r.problem.includes(s.file), r.problem);
    assert.match(r.problem, /is not valid JSON/);
    assert.match(r.problem, /at line \d+/);
    assert.match(r.fix, /fix or move this file/);
    assert.ok(r.fix.includes(s.file));
    assert.match(r.fix, new RegExp('zn hooks install ' + id));
    const { text, code } = printed(res);
    assert.ok(text.includes(s.file), text);
    assert.doesNotMatch(text, new RegExp(r.name.replace(/[()]/g, '.') + '\\s+zn is not set up for this agent'));
    assert.equal(code, 1);
    // the hooks list and the summary line agree with the check
    const list = hooksList.listHooks({ home: s.home, env: s.env, cwd: s.cwd });
    assert.equal(list.counts.broken, 1);
    assert.match(hooksList.summaryLine(list), /1 broken/);
    let ltext = '';
    hooksList.report(list, (x) => { ltext += x; });
    assert.ok(ltext.includes(s.file));
    assert.match(ltext, /Fix: fix or move this file/);
    assert.doesNotMatch(ltext, /Fix: run `zn hooks install \w+` in your own terminal/);
  });
}

for (const id of ['codex', 'cursor', 'gemini', 'copilot', 'opencode']) {
  test(id + ': a config file this user may not read is named as unreadable and counted as broken', { skip: !canChmod && 'needs chmod and a non-root user' }, async (t) => {
    const s = setup(t, id);
    fs.writeFileSync(s.file, id === 'opencode' ? 'export default {};\n' : '{}\n');
    fs.chmodSync(s.file, 0o000);
    t.after(() => { try { fs.chmodSync(s.file, 0o600); } catch (_) { /* gone */ } });
    const res = await s.run();
    const r = res.results.find((x) => x.id === id);
    assert.equal(r.state, 'not-protected');
    assert.ok(r.problem.includes(s.file), r.problem);
    assert.match(r.problem, /cannot be read/);
    assert.match(r.fix, /read and write access|fix or move/);
    assert.ok(r.fix.includes(s.file));
    assert.match(r.fix, new RegExp('zn hooks install ' + id));
    const { text, code } = printed(res);
    assert.ok(text.includes(s.file), text);
    assert.equal(code, 1);
    const list = hooksList.listHooks({ home: s.home, env: s.env, cwd: s.cwd });
    assert.equal(list.counts.broken, 1);
    assert.match(hooksList.summaryLine(list), /1 broken/);
  });
}

test('an empty or missing config file is still "not set up", and a valid one is unaffected', async (t) => {
  const s = setup(t, 'codex');
  let r = (await s.run()).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'not-set-up');
  assert.ok(!r.configFault);
  fs.writeFileSync(s.file, '  \n');
  r = (await s.run()).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'not-set-up');
  fs.writeFileSync(s.file, '{}\n');
  r = (await s.run()).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'not-set-up');
  assert.match(r.fix, /zn hooks install codex/);
});

test('the printed report gives the file, the problem and the repair for an invalid config', async (t) => {
  const s = setup(t, 'cursor');
  fs.writeFileSync(s.file, '{ "version": 1, ');
  const { text } = printed(await s.run());
  assert.match(text, /NOT protected: .*is not valid JSON/);
  assert.match(text, /To fix it, fix or move this file/);
});
