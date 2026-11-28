'use strict';

process.env.ZN_STATS = 'off';

// An invalid ~/.zn/config.json must not silently weaken protection: the hooks tell the user once, the opt-in protections
// the text switches on stay on, and `check` reports the file. Valid and missing files behave as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const uc = require('../lib/user-config');
const runner = require('../lib/hooks/runner');
const stats = require('../lib/stats');
const { tempDir } = require('./helpers/tmp');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function homeWith(t, text) {
  const account = tempDir(t, 'zn-badcfg-');
  const dir = path.join(account, '.zn');
  fs.mkdirSync(dir, { recursive: true });
  if (text !== null) fs.writeFileSync(path.join(dir, 'config.json'), text);
  const before = process.env.ZN_HOME;
  stats._useRealHome(() => account);
  process.env.ZN_HOME = dir;
  t.after(() => {
    stats._useRealHome(null);
    if (before === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = before;
  });
  return { account, dir };
}

const CASES = {
  'trailing comment': '{"hooks": {"strict": true, "blockDestructiveCommands": true}} // mine\n',
  'truncated JSON': '{"hooks": {"strict": true, "blockDestructiveCommands": tr',
  'BOM': '﻿{"hooks": {"strict": true}}',
};

for (const [name, text] of Object.entries(CASES)) {
  test('invalid config (' + name + '): problem reported with the parse error, never fewer protections', (t) => {
    const { dir } = homeWith(t, text);
    const res = uc.readConfigFile(dir);
    assert.ok(res.problem, 'problem reported');
    assert.match(res.problem.error, /JSON|position|BOM/);
    assert.equal(res.problem.file, path.join(dir, 'config.json'));
    const hooks = runner.readConfig().hooks || {};
    if (name !== 'truncated JSON') assert.equal(hooks.strict, true);
    if (name === 'trailing comment') assert.equal(hooks.blockDestructiveCommands, true);
    assert.match(uc.problemText(res.problem), /not valid JSON/);
  });

  test('invalid config (' + name + '): the hook output carries a one-time warning', async (t) => {
    homeWith(t, text);
    const note = () => {
      runner.readConfig();
      return runnerNote();
    };
    const first = note();
    assert.match(first, /not valid JSON/);
    assert.equal(note(), null, 'once per version of the file');
  });
}

// takeConfigProblemNote is internal: reach it through the event the runner handles.
function runnerNote() {
  return runner._takeConfigProblemNote();
}

test('valid and missing configs are unchanged and report nothing', (t) => {
  const { dir } = homeWith(t, JSON.stringify({ hooks: { strict: true } }));
  assert.equal(uc.readConfigFile(dir).problem, null);
  assert.deepEqual(runner.readConfig().hooks, { strict: true });
  assert.equal(runnerNote(), null);
  const { dir: d2 } = homeWith(t, null);
  const res = uc.readConfigFile(d2);
  assert.equal(res.problem, null);
  assert.deepEqual(res.config, {});
});

test('recovery never relaxes: false values and unknown keys are not recovered', () => {
  assert.deepEqual(uc.recoverHooks('{"strict": false, "whenUnavailable": "allow", /*'), {});
});

test('check exits 1 and names the file when config.json is invalid', (t) => {
  const { account } = homeWith(t, CASES['trailing comment']);
  const env = { ...process.env, HOME: account, USERPROFILE: account, ZN_HOME: path.join(account, '.zn'), ZN_STATS: 'off' };
  const r = spawnSync(process.execPath, [CLI, 'check'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Settings file: .*config\.json is not valid JSON/);
  const j = spawnSync(process.execPath, [CLI, 'check', '--json'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(j.status, 1);
  assert.ok(JSON.parse(j.stdout).project_rules_errors.some((e) => /config\.json/.test(e)));
});
