'use strict';

process.env.ZN_STATS = 'off';

// Copilot create_and_run_task: VS Code expands ${...} in a task before it starts it, so a placeholder value in the
// task environment must not pass for a key that loads code, and fields that start other tasks (dependsOn) are refused.
// Values are fictitious.

const test = require('node:test');
const assert = require('node:assert/strict');
const copilot = require('../lib/agents/copilot');
const runner = require('../lib/hooks/runner');
const { createFakeVault } = require('./helpers/fake_vault');
const fakeEngine = require('./helpers/fake_engine');
const { tempDir } = require('./helpers/tmp');

const PREFIX = 'ZN_AGENT=x "node" "run.js" --';
const run = (raw) => runner.handle(copilot, raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', znRunPrefix: PREFIX });
const denied = (r) => Boolean(r.output && r.output.permissionDecision && r.output.permissionDecision !== 'allow');
const task = (dir, extra) => ({ workspaceFolder: dir, task: Object.assign({ label: 'x', type: 'shell', command: 'echo', args: ['hello'] }, extra) });
const go = (dir, input) => run({ cwd: dir, toolName: 'create_and_run_task', toolArgs: input });

test('a placeholder value for a variable that loads code or moves a configuration is refused', async (t) => {
  const dir = tempDir(t, 'zn-task-env-');
  for (const env of [
    { BASH_ENV: '${TASK_SCRIPT}', TASK_SCRIPT: '${workspaceFolder}/.bashrc' },
    { BASH_ENV: '${env:TASK_SCRIPT}' },
    { BASH_ENV: '$TASK_SCRIPT' },
    { LD_PRELOAD: '${env:LIB}' },
    { NODE_OPTIONS: '${env:OPTS}' },
    { PATH: '${env:EVIL_PATH}' },
    { ZDOTDIR: '${env:Z}' },
    { CLAUDE_CONFIG_DIR: '${env:C}' },
    { HTTPS_PROXY: '${env:P}' },
  ]) {
    assert.ok(denied(await go(dir, task(dir, { options: { env } }))), JSON.stringify(env));
  }
});

test('benign environment values, with or without a placeholder, still pass', async (t) => {
  const dir = tempDir(t, 'zn-task-env-');
  for (const env of [
    { FOO: 'bar' },
    { GREETING: '${env:USER}' },
    { MODE: 'test', OUT: '${workspaceFolder}/out' },
  ]) {
    assert.equal((await go(dir, task(dir, { options: { env } }))).output, null, JSON.stringify(env));
  }
});

test('a task with dependsOn or dependsOrder is refused, in the base task and in a platform override', async (t) => {
  const dir = tempDir(t, 'zn-task-env-');
  for (const extra of [
    { dependsOn: ['other'] },
    { dependsOn: 'other' },
    { dependsOn: ['other'], dependsOrder: 'sequence' },
    { dependsOrder: 'parallel' },
    { linux: { dependsOn: ['other'] } },
    { windows: { dependsOrder: 'sequence' } },
  ]) {
    assert.ok(denied(await go(dir, task(dir, extra))), JSON.stringify(extra));
  }
  assert.equal((await go(dir, task(dir, {}))).output, null);
  assert.equal((await go(dir, task(dir, { linux: { command: 'echo' } }))).output, null);
});
