'use strict';
/* The init and block messages that name a command print the .cmd shim on win32
 * (PowerShell's Restricted policy refuses npx.ps1 and zn.ps1). Other systems keep the plain names. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { cliName } = require('../lib/zn-command');
const { _internal: { permissionAdvice } } = require('../lib/init-guide');
const { adminDenial } = require('../lib/hooks/policy');
const { pluginSource } = require('../lib/agents/opencode');

function asPlatform(value, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

async function asPlatformAsync(value, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

// No zn on PATH, so the messages name the npx form.
const noPath = { PATH: '' };

test('cliName appends .cmd only on win32', () => {
  asPlatform('win32', () => assert.equal(cliName('zn-gate'), 'zn-gate.cmd'));
  asPlatform('linux', () => assert.equal(cliName('zn-gate'), 'zn-gate'));
});

test('init permission advice names npx.cmd on win32 and npx elsewhere', () => {
  const todo = [{ name: 'Claude Code', steps: [{ needsGlobal: true }] }];
  const args = { prefix: '/usr/local', env: {}, todo, shell: '/bin/bash' };
  asPlatform('win32', () => {
    const text = permissionAdvice(args);
    assert.match(text, /Then open a new terminal and run: npx\.cmd -y zn-gate init/);
  });
  asPlatform('linux', () => {
    const text = permissionAdvice(args);
    assert.match(text, /Then open a new terminal and run: npx -y zn-gate init/);
    assert.doesNotMatch(text, /npx\.cmd/);
  });
});

test('admin denial names zn-gate.cmd and npx.cmd on win32', () => {
  asPlatform('win32', () => {
    const pins = adminDenial('pins approve', { env: noPath });
    assert.match(pins, /run `zn-gate\.cmd pins approve`/);
    const init = adminDenial('init', { env: noPath });
    assert.match(init, /`zn-gate\.cmd init` turns/);
    assert.match(init, /\(`npx\.cmd -y zn-gate init`\)/);
  });
});

test('admin denial keeps the plain names on other systems', () => {
  asPlatform('linux', () => {
    const pins = adminDenial('pins approve', { env: noPath });
    assert.match(pins, /run `zn-gate pins approve`/);
    const init = adminDenial('init', { env: noPath });
    assert.match(init, /`zn-gate init` turns/);
    assert.match(init, /\(`npx -y zn-gate init`\)/);
    assert.doesNotMatch(init, /\.cmd/);
  });
});

test('OpenCode repair step names the .cmd shims on win32 only', () => {
  const opts = { nodePath: '/usr/bin/node', runnerPath: '/opt/zn/runner.js' };
  asPlatform('win32', () => {
    assert.match(pluginSource(opts), /Run zn-gate\.cmd check in a terminal, then zn\.cmd hooks install opencode\./);
  });
  asPlatform('linux', () => {
    assert.match(pluginSource(opts), /Run zn-gate check in a terminal, then zn hooks install opencode\./);
  });
});

test('a vault failure on win32 names zn.cmd unlock once and never the bare zn unlock', async () => {
  const runner = require('../lib/hooks/runner');
  const engine = require('../lib/scrub/engine');
  const adapter = (ev) => ({ id: 'claude-code', normalize: () => Object.assign({ cwd: process.cwd() }, ev), respond: (d) => d });
  const pre = { event: 'pre_tool', tool: 'webfetch', toolName: 'WebFetch', input: { url: 'https://example.com/?q=x' } };
  const run = () => runner.handle(adapter(pre), {}, { home: process.env.HOME, vault: { maskInfo: async () => { throw new Error('connection closed'); } }, engine });
  const win = await asPlatformAsync('win32', run);
  assert.match(win.decision.message, /\(zn\.cmd unlock\)/);
  assert.doesNotMatch(win.decision.message, /(^|[^.\w])zn unlock/);
  assert.equal(win.decision.message.split(' unlock)').length - 1, 1, win.decision.message);
  const posix = await asPlatformAsync('linux', run);
  assert.match(posix.decision.message, /\(zn unlock\)/);
  assert.doesNotMatch(posix.decision.message, /\.cmd/);
  assert.equal(posix.decision.message.split(' unlock)').length - 1, 1, posix.decision.message);
});
