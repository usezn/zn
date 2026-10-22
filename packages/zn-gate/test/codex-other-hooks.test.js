'use strict';

// lib/codex-other-hooks.js: other tools' Codex hooks that could change a call or answer an approval.
// Every test uses its own temp folders, and HOME, XDG_CONFIG_HOME, USERPROFILE and CODEX_HOME point at
// a temp folder too, so nothing here reads the real agent configs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { findOtherHooks, _internal } = require('../lib/codex-other-hooks');

const MB = 1024 * 1024;
const VARS = ['HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'CODEX_HOME'];

function isolate(t) {
  const home = tempDir(t, 'zn-r233-home-');
  const saved = {};
  for (const v of VARS) {
    saved[v] = process.env[v];
    process.env[v] = home;
  }
  t.after(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });
}

// A fresh Codex folder (the codexHome argument) with the environment isolated.
function codexHome(t) {
  isolate(t);
  return tempDir(t, 'zn-r233-codex-');
}

function writeHooks(dir, tree) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks.json'), typeof tree === 'string' ? tree : JSON.stringify(tree));
}

function group(matcher, command, extra = {}) {
  return { matcher, hooks: [{ command, ...extra }] };
}

function under(event, g) {
  return { hooks: { [event]: [g] } };
}

test('a folder without hooks files has no other hooks', (t) => {
  assert.equal(findOtherHooks(codexHome(t), null), null);
});

test('another PreToolUse hook is reported with its file and event', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, under('PreToolUse', group('Bash', 'other-tool check')));
  assert.deepEqual(findOtherHooks(dir, null), { file: path.join(dir, 'hooks.json'), event: 'PreToolUse' });
});

test('a PermissionRequest hook is reported as well', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, under('PermissionRequest', group('Bash', 'other-tool approve')));
  assert.equal(findOtherHooks(dir, null).event, 'PermissionRequest');
});

test('zn own hooks are not reported', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, {
    hooks: {
      PreToolUse: [
        group('Bash', 'node "/opt/zn/lib/hooks/runner.js" codex'),
        group('apply_patch', 'zn hook codex'),
      ],
    },
  });
  assert.equal(findOtherHooks(dir, null), null);
});

test('background hooks cannot change a call and are not reported', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, {
    hooks: {
      PreToolUse: [group('Bash', 'other-tool a', { async: true }), group('Bash', 'other-tool b', { async: 'true' })],
    },
  });
  assert.equal(findOtherHooks(dir, null), null);
});

test('events other than PreToolUse and PermissionRequest are not reported', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, { hooks: { Stop: [group('Bash', 'other-tool stop')], PostToolUse: [group('Bash', 'other-tool post')] } });
  assert.equal(findOtherHooks(dir, null), null);
});

test('a matcher must select one of the tools zn watches', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, under('PreToolUse', group('Write', 'other-tool write')));
  assert.equal(findOtherHooks(dir, null), null);
  writeHooks(dir, under('PreToolUse', group('Bash|apply_patch', 'other-tool shell')));
  assert.equal(findOtherHooks(dir, null).event, 'PreToolUse');
});

test('a hook entry with a command directly in its group is read', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, { hooks: { PreToolUse: [{ matcher: 'Bash', command: 'other-tool direct' }] } });
  assert.equal(findOtherHooks(dir, null).event, 'PreToolUse');
});

test('malformed or unexpected hook files give no hit and no exception', (t) => {
  const dir = codexHome(t);
  const cases = [
    '{not json',
    '[]',
    '{"hooks": null}',
    '{"hooks": {"PreToolUse": "not a list"}}',
    '{"hooks": {"PreToolUse": [null, "x", {"hooks": [null, {"command": 5}]}]}}',
  ];
  for (const text of cases) {
    writeHooks(dir, text);
    assert.equal(findOtherHooks(dir, null), null, text);
  }
});

test('the codex home is searched before the project .codex folder', (t) => {
  const home = codexHome(t);
  const project = tempDir(t, 'zn-r233-project-');
  writeHooks(path.join(project, '.codex'), under('PreToolUse', group('Bash', 'other-tool project')));
  writeHooks(home, under('PreToolUse', group('Bash', 'other-tool home')));
  assert.equal(findOtherHooks(home, project).file, path.join(home, 'hooks.json'));
});

test('the project .codex folder is searched when the codex home has no other hook', (t) => {
  const home = codexHome(t);
  const project = tempDir(t, 'zn-r233-project-');
  writeHooks(home, under('PreToolUse', group('Bash', 'node "/opt/zn/lib/hooks/runner.js" codex')));
  writeHooks(path.join(project, '.codex'), under('PreToolUse', group('Bash', 'other-tool project')));
  assert.equal(findOtherHooks(home, project).file, path.join(project, '.codex', 'hooks.json'));
});

test('a project dir that is the codex home parent is read without a crash', (t) => {
  const project = tempDir(t, 'zn-r233-project-');
  const home = path.join(project, '.codex');
  writeHooks(home, under('PreToolUse', group('Bash', 'other-tool once')));
  assert.equal(findOtherHooks(home, project).file, path.join(home, 'hooks.json'));
});

test('config.toml hooks are read when there is no hooks.json', (t) => {
  const dir = codexHome(t);
  fs.writeFileSync(
    path.join(dir, 'config.toml'),
    '[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ncommand = "other tool"\n',
  );
  assert.deepEqual(findOtherHooks(dir, null), { file: path.join(dir, 'config.toml'), event: 'PreToolUse' });
});

test('control characters in the command do not hide the hook', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, under('PreToolUse', group('Bash', 'other\u0001tool\u0000check')));
  assert.equal(findOtherHooks(dir, null).event, 'PreToolUse');
});

test('Windows paths: the hook command and a C:\\ codex home', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, under('PreToolUse', group('Bash', '"C:\\Users\\me\\tools\\guard.exe" check')));
  assert.equal(findOtherHooks(dir, null).event, 'PreToolUse');
  // A folder that does not exist on this machine: no hit and no exception.
  assert.equal(findOtherHooks('C:\\Users\\me\\x', null), null);
});

test('a 200 KB command is read within the time bound', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, under('PreToolUse', group('Bash', 'x'.repeat(200 * 1024) + ' check')));
  const t0 = Date.now();
  assert.equal(findOtherHooks(dir, null).event, 'PreToolUse');
  assert.ok(Date.now() - t0 < 2000, 'took too long');
});

test('a hooks file over the 256 KB cap is reported as too large to check', (t) => {
  // A file above the cap is not read, so it is reported rather than taken for "no hooks".
  const dir = codexHome(t);
  const big = JSON.stringify(under('PreToolUse', group('Bash', 'other-tool big'))) + ' '.repeat(300 * 1024);
  writeHooks(dir, big);
  const r = findOtherHooks(dir, null);
  assert.equal(r.tooLarge, true);
  assert.match(r.file, /hooks\.json$/);
  assert.equal(r.event, undefined);
});

test('a hook found in a readable file wins over a too-large file; a too-large file alone is reported', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, JSON.stringify(under('PreToolUse', group('Bash', 'x'))) + ' '.repeat(300 * 1024));
  fs.writeFileSync(path.join(dir, 'config.toml'), '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "other-tool toml"\n');
  assert.equal(findOtherHooks(dir, null).event, 'PreToolUse');
  fs.writeFileSync(path.join(dir, 'config.toml'), '# nothing\n');
  assert.equal(findOtherHooks(dir, null).tooLarge, true);
});

test('the same hook under the cap is reported', (t) => {
  const dir = codexHome(t);
  writeHooks(dir, under('PreToolUse', group('Bash', 'other-tool small')));
  assert.equal(findOtherHooks(dir, null).event, 'PreToolUse');
});

test('matches() takes the matcher as a regex anchored to the whole tool name', () => {
  const { matches } = _internal;
  for (const m of [undefined, null, '', '*', 'Bash', 'Bash|apply_patch', 'mcp__.*', '(|Bash']) {
    assert.equal(matches(m), true, String(m));
  }
  for (const m of ['Write', 'Ba', 'ash', '(|Write']) {
    assert.equal(matches(m), false, m);
  }
});

test('entriesOf() keeps only string commands from well-formed groups', () => {
  const { entriesOf } = _internal;
  assert.deepEqual(entriesOf(null), []);
  assert.deepEqual(entriesOf({ hooks: 'x' }), []);
  assert.deepEqual(
    entriesOf({ hooks: { PreToolUse: [null, 'x', { hooks: [null, { command: 5 }, { command: 'ok' }] }] } }),
    [{ event: 'PreToolUse', matcher: undefined, command: 'ok', async: undefined }],
  );
});
